/**
 * Tracks command lifecycle using OSC 633 events.
 *
 * Key insight: OSC markers and command output may arrive in the same PTY
 * data chunk, with markers processed before the output text. Therefore,
 * we cannot rely on state transitions to gate output capture.
 *
 * Strategy:
 *   1. When AI command is registered, capture ALL output unconditionally
 *   2. When promptStart fires, wait a settling delay for straggling output
 *   3. Resolve with captured output, stripping command echo and ANSI sequences
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
        this._settleTimer = null;
        this._commandSent = '';
    }

    get busy() {
        return this._isAiCommand;
    }

    /**
     * Register an AI-initiated command. Returns a promise that resolves
     * when the command completes with { output, exitCode, truncated }.
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
                    // The command is still running in the PTY.
                    const { timeoutId: tid } = this._pending;
                    clearTimeout(tid);
                    this._pending = null;
                    reject(new Error(`Command timed out after ${timeoutMs}ms`));
                }
            }, timeoutMs);

            this._pending = { resolve, reject, timeoutId };
            this._isAiCommand = true;
            this._output = '';
            this._truncated = false;
            this._exitCode = 0;
            this._commandSent = commandText;
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

    _scheduleResolve() {
        if (this._settleTimer) {
            clearTimeout(this._settleTimer);
        }
        this._settleTimer = setTimeout(() => {
            this._resolve();
        }, 150);
    }

    _resolve() {
        if (!this._pending) {
            // Timed out earlier — just cleanup the busy state
            this._cleanup();
            return;
        }

        const { resolve, timeoutId } = this._pending;
        clearTimeout(timeoutId);

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
            if (last === '' || last.endsWith('$') || last.endsWith('#')) {
                cleanedLines.pop();
            } else {
                break;
            }
        }

        output = cleanedLines.join('\n').trim();

        if (this._truncated) {
            output += '\n\n[Output truncated at 1MB]';
        }

        const exitCode = this._exitCode;
        this._cleanup();
        resolve({ output, exitCode });
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
