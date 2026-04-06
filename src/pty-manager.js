/**
 * Manages the bash PTY process and terminal I/O forwarding.
 *
 * - Spawns bash with shell integration script sourced
 * - Forwards user stdin to PTY
 * - Forwards PTY output to user stdout (with OSC sequences stripped)
 * - Parses OSC 633 events and feeds them to CommandTracker
 * - Provides write() for AI to send commands to the same PTY
 */

import { spawn } from 'node-pty';
import { OscParser } from './osc-parser.js';
import { CommandTracker } from './command-tracker.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class PtyManager {
    constructor(options = {}) {
        this.shell = options.shell || process.env.SHELL || (process.platform === 'win32' ? 'bash.exe' : 'bash');
        this.cwd = options.cwd || process.cwd();
        this.tracker = new CommandTracker();
        this._parser = new OscParser();
        this._pty = null;
    }

    /**
     * Start the PTY and begin forwarding I/O.
     */
    start() {
        const cols = process.stdout.columns || 80;
        const rows = process.stdout.rows || 24;

        this._pty = spawn(this.shell, ['-i'], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd: this.cwd,
            env: {
                ...process.env,
                BASHPILOT_ACTIVE: '1',
            }
        });

        // Inject shell integration inline after bash starts.
        // This avoids --init-file path issues (Windows vs WSL vs MSYS).
        this._injectShellIntegration();

        // PTY output → parse OSC → display to user + feed tracker
        this._pty.onData((data) => {
            const { cleaned, events } = this._parser.parse(data);

            // Feed events to tracker
            for (const event of events) {
                this.tracker.handleEvent(event);
            }

            // Feed cleaned output to tracker (for capture)
            if (cleaned) {
                this.tracker.feedOutput(cleaned);
            }

            // Display to user
            if (cleaned) {
                process.stdout.write(cleaned);
            }
        });

        this._pty.onExit(({ exitCode }) => {
            this.tracker.cancel();
            process.exit(exitCode);
        });

        // User stdin → PTY
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.resume();
        process.stdin.on('data', (data) => {
            this._pty.write(data.toString());
        });

        // Handle terminal resize
        process.stdout.on('resize', () => {
            if (this._pty) {
                this._pty.resize(
                    process.stdout.columns || 80,
                    process.stdout.rows || 24
                );
            }
        });
    }

    /**
     * Send a command from AI to the PTY.
     * Returns a promise that resolves with { output, exitCode }.
     */
    async executeCommand(command, timeoutMs = 30000) {
        if (!this._pty) {
            throw new Error('PTY not started');
        }

        // Register the command for tracking
        const resultPromise = this.tracker.registerCommand(command, timeoutMs);

        // Write command + newline to PTY (appears in terminal as if typed)
        this._pty.write(command + '\n');

        // Wait for completion
        return resultPromise;
    }

    /**
     * Get current working directory by querying bash.
     */
    async getCwd() {
        const result = await this.executeCommand('pwd', 5000);
        return result.output.trim();
    }

    /**
     * Inject shell integration by writing a heredoc to a temp file via PTY,
     * then sourcing it. Works on WSL, MSYS/Git Bash, and native Linux
     * because the path is always a Unix path inside the bash environment.
     */
    _injectShellIntegration() {
        const scriptPath = join(__dirname, '..', 'shell-integration.bash');
        const script = readFileSync(scriptPath, 'utf8');

        const tmpFile = '/tmp/.bashpilot-integration-' + process.pid + '.sh';

        // Write heredoc to temp file, source it, remove it, clear screen
        const injection = [
            `cat > ${tmpFile} << 'BASH_MCP_EOF'`,
            script.trimEnd(),
            'BASH_MCP_EOF',
            `source ${tmpFile}; rm -f ${tmpFile}; clear`,
            ''
        ].join('\n');

        this._pty.write(injection);
    }

    /**
     * Set the terminal window title.
     * Sets __bashpilot_title which gets injected into PS1 by shell integration.
     * Clears the screen to hide the variable assignment from the user.
     * Also writes OSC directly for immediate effect.
     */
    setTitle(title) {
        if (this._pty) {
            const escaped = title.replace(/'/g, "'\\''");
            this._pty.write(`__bashpilot_title='${escaped}'; clear\n`);
            process.stdout.write(`\x1b]0;${title}\x07`);
        }
    }

    dispose() {
        if (this._pty) {
            this._pty.kill();
            this._pty = null;
        }
    }
}
