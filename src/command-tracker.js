/**
 * Tracks command lifecycle using OSC 633 events.
 *
 * Key insight: OSC markers and command output may arrive in the same PTY
 * data chunk, with markers processed before the output text. Therefore,
 * we cannot rely on state transitions to gate output capture.
 *
 * Timeout behavior: when a command times out, the caller's promise is
 * rejected but output capture continues. When the command eventually
 * completes, the output is cached and can be retrieved via consumeCachedOutput().
 */

const MAX_OUTPUT_BYTES = 1024 * 1024; // 1MB

// Strip ANSI escape sequences from captured output
function stripAnsi(text) {
    return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')  // CSI sequences
               .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC sequences
               .replace(/\x1b\][^\x1b]*\x1b\\/g, '')     // OSC with ST
               .replace(/\x1b[()][0-9A-B]/g, '')          // Character set
               .replace(/\r/g, '');                        // Carriage returns
}

export class CommandTracker {
    constructor() {
        this._pending = null;       // { resolve, reject, timeoutId }
        this._isAiCommand = false;
        this._output = '';
        this._truncated = false;
        this._exitCode = 0;
        this._cwd = null;
        this._settleTimer = null;
        this._commandSent = '';
        this._cachedResult = null;  // Cached output after timeout
        this._startTime = null;
    }

    get busy() {
        return this._isAiCommand;
    }

    /**
     * Register an AI-initiated command. Returns a promise that resolves
     * when the command completes with { output, exitCode, cwd }.
     */
    registerCommand(commandText, timeoutMs = 30000) {
        if (this._isAiCommand) {
            return Promise.reject(new Error('Another command is already executing. Wait for it to complete.'));
        }

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                if (this._pending) {
                    // Reject the caller's promise, but keep _isAiCommand = true
                    // so get_status reports 'busy' until the shell signals completion.
                    // Output capture continues — result will be cached.
                    this._pending = null;
                    reject(new Error(`Command timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);

            this._pending = { resolve, reject, timeoutId };
            this._isAiCommand = true;
            this._output = '';
            this._truncated = false;
            this._exitCode = 0;
            this._cwd = null;
            this._commandSent = commandText;
            this._cachedResult = null;
            this._startTime = Date.now();
        });
    }

    /**
     * Feed an OSC event from the parser.
     */
    handleEvent(event) {
        if (!this._isAiCommand) return;

        switch (event.type) {
            case 'commandFinished':
                this._exitCode = event.exitCode ?? 0;
                break;

            case 'cwd':
                this._cwd = event.cwd;
                break;

            case 'promptStart':
                this._scheduleResolve();
                break;
        }
    }

    /**
     * Feed cleaned output from the PTY.
     */
    feedOutput(text) {
        if (this._isAiCommand) {
            if (this._output.length < MAX_OUTPUT_BYTES) {
                this._output += text;
                if (this._output.length > MAX_OUTPUT_BYTES) {
                    this._output = this._output.substring(0, MAX_OUTPUT_BYTES);
                    this._truncated = true;
                }
            }

            if (this._settleTimer) {
                clearTimeout(this._settleTimer);
                this._scheduleResolve();
            }
        }
    }

    /**
     * Consume cached output from a timed-out command that has since completed.
     * Returns { output, exitCode, cwd, command, duration } or null if no cache.
     */
    consumeCachedOutput() {
        const result = this._cachedResult;
        this._cachedResult = null;
        return result;
    }

    /**
     * Whether there is cached output available.
     */
    get hasCachedOutput() {
        return this._cachedResult !== null;
    }

    _scheduleResolve() {
        if (this._settleTimer) {
            clearTimeout(this._settleTimer);
        }
        this._settleTimer = setTimeout(() => {
            this._resolve();
        }, 150);
    }

    _resolve() {
        const output = this._cleanOutput();
        const exitCode = this._exitCode;
        const cwd = this._cwd;
        const command = this._commandSent;
        const duration = this._startTime ? ((Date.now() - this._startTime) / 1000).toFixed(2) : '0.00';

        if (!this._pending) {
            // Timed out earlier — cache the result for wait_for_completion
            this._cachedResult = { output, exitCode, cwd, command, duration };
            this._cleanup();
            return;
        }

        const { resolve, timeoutId } = this._pending;
        clearTimeout(timeoutId);
        this._cleanup();
        resolve({ output, exitCode, cwd });
    }

    _cleanOutput() {
        let output = stripAnsi(this._output);

        // Remove command echo (first line containing the sent command)
        const lines = output.split('\n');
        const cleanedLines = [];
        let echoSkipped = false;

        for (const line of lines) {
            if (!echoSkipped) {
                if (line.includes(this._commandSent) || line.trim() === '') {
                    echoSkipped = true;
                    continue;
                }
            }
            cleanedLines.push(line);
        }

        // Remove trailing prompt line(s)
        while (cleanedLines.length > 0) {
            const last = cleanedLines[cleanedLines.length - 1].trim();
            if (last === '' || last === '$' || last === '#' ||
                last.endsWith('$') || last.endsWith('#') ||
                /MINGW|MSYS/.test(last) ||
                /^\S+@\S+/.test(last)) {
                cleanedLines.pop();
            } else {
                break;
            }
        }

        output = cleanedLines.join('\n').trim();

        if (this._truncated) {
            output += '\n\n[Output truncated at 1MB]';
        }

        return output;
    }

    _cleanup() {
        if (this._settleTimer) {
            clearTimeout(this._settleTimer);
            this._settleTimer = null;
        }
        this._pending = null;
        this._isAiCommand = false;
        this._output = '';
        this._commandSent = '';
        this._startTime = null;
    }

    /**
     * Cancel any pending command (e.g., Ctrl+C).
     */
    cancel() {
        if (this._pending) {
            const { reject, timeoutId } = this._pending;
            clearTimeout(timeoutId);
            this._cleanup();
            reject(new Error('Command cancelled'));
        }
    }
}
