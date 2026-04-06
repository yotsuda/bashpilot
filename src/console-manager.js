/**
 * Manages console processes via Unix domain socket discovery.
 *
 * Each console listens on a socket file with a naming convention:
 *   /tmp/bashpilot.{proxyPid}.{agentId}.{consolePid}.sock
 *
 * The manager discovers consoles by scanning the filesystem, probes their
 * status via get_status messages, and routes commands to standby consoles.
 * If all consoles are busy, a new one is launched automatically.
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { launchConsole } from './console-launcher.js';
import { generateDisplayName, nextConsoleName } from './console-names.js';
import { enumerateSockets, parseSocketPath, cleanupSocket, getSocketPath, readPortFile, usesTcp } from './socket-paths.js';

export class ConsoleManager {
    constructor() {
        this._proxyPid = process.pid;
        this._agentId = 'default';
        this._activePid = null;
        this._busyPids = new Set();
        this._consoles = new Map();  // consolePid → { socketPath, displayName }
    }

    get hasConsole() {
        return this._consoles.size > 0;
    }

    async init() {
        // Clean up stale port/socket files from dead proxy processes
        this._cleanupStaleFiles();
    }

    /**
     * Remove port/socket files left by proxy processes that no longer exist.
     */
    _cleanupStaleFiles() {
        const allSockets = enumerateSockets();
        for (const socketPath of allSockets) {
            const parsed = parseSocketPath(socketPath);
            if (!parsed || !parsed.owned) continue;
            if (parsed.proxyPid === this._proxyPid) continue;

            // Check if the proxy process is still alive
            if (!isProcessAlive(parsed.proxyPid)) {
                cleanupSocket(socketPath);
            }
        }
    }

    /**
     * Start or reuse a console.
     */
    async startConsole(options = {}) {
        const forceNew = !!options.reason;

        if (!forceNew) {
            // Try to find a standby console
            const standby = await this._findStandbyConsole();
            if (standby) {
                this._activePid = standby.consolePid;
                const displayName = this._consoles.get(standby.consolePid)?.displayName || `#${standby.consolePid}`;
                // Re-set title on reuse (may have changed)
                await this._sendRequest(standby.socketPath, {
                    type: 'set_title',
                    title: `bashpilot ${displayName}`,
                }).catch(() => {});
                return {
                    status: 'reused',
                    pid: standby.consolePid,
                    displayName,
                };
            }
        }

        // Pick a name before launch so it can be shown immediately
        const consoleName = nextConsoleName();
        const title = `bashpilot ${consoleName}`;

        // Launch new console with title and banner as args (shown immediately)
        launchConsole(this._proxyPid, this._agentId, {
            shell: options.shell,
            cwd: options.cwd,
            banner: options.banner,
            title,
        });

        // Wait for the new console's socket to appear
        const socketPath = await this._waitForNewSocket(15000);
        const parsed = parseSocketPath(socketPath);
        const consolePid = parsed.consolePid;

        // Now we know the PID — update title and register
        const displayName = `#${consolePid} ${consoleName}`;
        this._consoles.set(consolePid, { socketPath, displayName });
        this._activePid = consolePid;

        // Update title with PID
        await this._sendRequest(socketPath, {
            type: 'set_title',
            title: `bashpilot ${displayName}`,
        }).catch(() => {});

        return { status: 'started', pid: consolePid, displayName };
    }

    /**
     * Execute a command on a console.
     * If the active console is busy, switches to another and returns a
     * 'switched' result instead of executing — the caller should verify
     * the working directory and re-execute.
     */
    async executeCommand(command, timeoutMs = 30000) {
        // Fast path: check active console
        let consolePid = this._activePid;
        let socketPath = this._getSocketPath(consolePid);

        if (!socketPath) {
            // No console — auto-launch
            const result = await this.startConsole({});
            consolePid = result.pid;
            socketPath = this._getSocketPath(consolePid);
        }

        // Check if active console is ready
        const status = await this._getStatus(socketPath);
        if (!status) {
            // Dead console — clean up, find or launch another
            const deadName = this._consoles.get(consolePid)?.displayName || `#${consolePid}`;
            this._removeConsole(consolePid);
            const standby = await this._findStandbyConsole();
            if (standby) {
                consolePid = standby.consolePid;
                socketPath = standby.socketPath;
                this._activePid = consolePid;
            } else {
                // Auto-launch a new console
                const result = await this.startConsole({});
                consolePid = result.pid;
                socketPath = this._getSocketPath(consolePid);
            }

            const displayName = this._consoles.get(consolePid)?.displayName || `#${consolePid}`;
            const cachedOutputs = await this.collectAllCachedOutputs();
            return {
                switched: true,
                displayName,
                output: `Console ${deadName} was closed. Switched to console ${displayName}. Pipeline NOT executed — cd to the correct directory and re-execute.`,
                exitCode: 0,
                cachedOutputs,
            };
        } else if (status.status === 'busy') {
            this._busyPids.add(consolePid);
            // Find another standby console or launch new
            const standby = await this._findStandbyConsole();
            if (standby) {
                consolePid = standby.consolePid;
                socketPath = standby.socketPath;
                this._activePid = consolePid;
            } else {
                // Launch new console automatically
                const result = await this.startConsole({});
                consolePid = result.pid;
                socketPath = this._getSocketPath(consolePid);
            }

            // Don't execute — notify caller of the switch
            const displayName = this._consoles.get(consolePid)?.displayName || `#${consolePid}`;
            const cachedOutputs = await this.collectAllCachedOutputs();

            return {
                switched: true,
                displayName,
                output: `Switched to console ${displayName}. Pipeline NOT executed — cd to the correct directory and re-execute.`,
                exitCode: 0,
                cachedOutputs,
            };
        }

        // Send execute command
        this._busyPids.add(consolePid);
        const displayName = this._consoles.get(consolePid)?.displayName || `#${consolePid}`;
        try {
            const response = await this._sendRequest(socketPath, {
                type: 'execute',
                id: randomUUID(),
                command,
                timeout: timeoutMs,
            }, timeoutMs + 5000);

            this._busyPids.delete(consolePid);

            if (response.type === 'error') {
                throw new Error(response.message);
            }

            // Collect cached outputs from other consoles
            const cachedOutputs = await this.collectAllCachedOutputs();

            return {
                output: response.output,
                exitCode: response.exitCode,
                duration: response.duration,
                command: response.command,
                displayName,
                cwd: response.cwd,
                cachedOutputs,
            };
        } catch (err) {
            // Timeout — return structured info instead of bare error
            if (err.message.includes('timed out')) {
                // Collect cached outputs from OTHER consoles
                const cachedOutputs = await this.collectAllCachedOutputs();
                return {
                    timedOut: true,
                    displayName,
                    command,
                    cachedOutputs,
                };
            }
            this._busyPids.delete(consolePid);
            throw err;
        }
    }

    /**
     * Collect cached outputs from all consoles (non-blocking).
     * Returns array of completed results without waiting.
     */
    async collectAllCachedOutputs() {
        const results = [];
        for (const [pid, c] of this._consoles) {
            const status = await this._getStatus(c.socketPath);
            if (!status) {
                this._removeConsole(pid);
                continue;
            }
            if (status.status === 'completed') {
                const cached = await this._sendRequest(c.socketPath, {
                    type: 'get_cached_output',
                }, 5000).catch(() => null);
                if (cached && cached.type === 'cached_result') {
                    this._busyPids.delete(pid);
                    results.push({
                        displayName: c.displayName,
                        output: cached.output,
                        exitCode: cached.exitCode,
                        cwd: cached.cwd,
                        command: cached.command,
                        duration: cached.duration,
                    });
                }
            }
        }
        return results;
    }

    /**
     * Wait for busy consoles to complete and return cached output.
     * Polls every 1s until timeout.
     */
    async waitForCompletion(timeoutMs = 30000) {
        const start = Date.now();
        const results = [];

        while (Date.now() - start < timeoutMs) {
            let anyBusy = false;

            for (const [pid, c] of this._consoles) {
                const status = await this._getStatus(c.socketPath);
                if (!status) {
                    this._removeConsole(pid);
                    continue;
                }

                if (status.status === 'completed') {
                    // Fetch cached output
                    const cached = await this._sendRequest(c.socketPath, {
                        type: 'get_cached_output',
                    }, 5000).catch(() => null);

                    if (cached && cached.type === 'cached_result') {
                        this._busyPids.delete(pid);
                        results.push({
                            displayName: c.displayName,
                            output: cached.output,
                            exitCode: cached.exitCode,
                            cwd: cached.cwd,
                            command: cached.command,
                            duration: cached.duration,
                        });
                    }
                } else if (status.status === 'busy') {
                    anyBusy = true;
                }
            }

            if (results.length > 0 || !anyBusy) break;

            await sleep(1000);
        }

        return results;
    }

    /**
     * Get status of all known consoles.
     */
    getStatus() {
        const consoles = [];
        for (const [pid, c] of this._consoles) {
            consoles.push({
                pid,
                displayName: c.displayName,
                busy: this._busyPids.has(pid),
                active: pid === this._activePid,
            });
        }
        return consoles;
    }

    // --- Discovery ---

    /**
     * Find a standby (non-busy) console by probing all known sockets.
     */
    async _findStandbyConsole() {
        const sockets = enumerateSockets(this._proxyPid, this._agentId);

        for (const socketPath of sockets) {
            const parsed = parseSocketPath(socketPath);
            if (!parsed) continue;

            const status = await this._getStatus(socketPath);
            if (!status) {
                // Dead socket — clean up
                this._removeConsole(parsed.consolePid);
                cleanupSocket(socketPath);
                continue;
            }

            // Register if not already known
            if (!this._consoles.has(parsed.consolePid)) {
                const displayName = generateDisplayName(parsed.consolePid);
                this._consoles.set(parsed.consolePid, { socketPath, displayName });
            }

            if (status.status === 'standby') {
                return { consolePid: parsed.consolePid, socketPath };
            } else {
                this._busyPids.add(parsed.consolePid);
            }
        }

        return null;
    }

    /**
     * Wait for a new socket file to appear (after launching a console).
     */
    async _waitForNewSocket(timeoutMs) {
        const start = Date.now();
        const knownPids = new Set(this._consoles.keys());

        while (Date.now() - start < timeoutMs) {
            const sockets = enumerateSockets(this._proxyPid, this._agentId);
            for (const socketPath of sockets) {
                const parsed = parseSocketPath(socketPath);
                if (parsed && !knownPids.has(parsed.consolePid)) {
                    // New socket found — verify it's responsive
                    const status = await this._getStatus(socketPath);
                    if (status) return socketPath;
                }
            }
            await sleep(200);
        }

        throw new Error('Console failed to start within timeout');
    }

    // --- Socket communication ---

    /**
     * Send get_status to a console and return the response, or null if dead.
     */
    async _getStatus(socketPath) {
        try {
            return await this._sendRequest(socketPath, { type: 'get_status' }, 3000);
        } catch {
            return null;
        }
    }

    /**
     * Connect to a console (Unix socket or TCP via port file), send a message, wait for response.
     */
    _sendRequest(socketPath, message, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            let connectOptions;
            if (usesTcp()) {
                const port = readPortFile(socketPath);
                if (!port) {
                    reject(new Error('Port file not found or invalid'));
                    return;
                }
                connectOptions = { host: '127.0.0.1', port };
            } else {
                connectOptions = { path: socketPath };
            }

            const socket = net.createConnection(connectOptions, () => {
                // Send message
                const json = JSON.stringify(message);
                const buf = Buffer.from(json, 'utf8');
                const lenBuf = Buffer.alloc(4);
                lenBuf.writeUInt32LE(buf.length);
                socket.write(lenBuf);
                socket.write(buf);
            });

            let recvBuf = Buffer.alloc(0);
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error('Request timed out'));
            }, timeoutMs);

            socket.on('data', (data) => {
                recvBuf = Buffer.concat([recvBuf, data]);

                while (recvBuf.length >= 4) {
                    const len = recvBuf.readUInt32LE(0);
                    if (recvBuf.length < 4 + len) break;
                    const json = recvBuf.subarray(4, 4 + len).toString('utf8');
                    recvBuf = recvBuf.subarray(4 + len);
                    clearTimeout(timer);
                    try {
                        resolve(JSON.parse(json));
                    } catch (e) {
                        reject(e);
                    }
                    // Don't close socket — keep alive for execute commands
                    // that send output after the command finishes
                    return;
                }
            });

            socket.on('error', (err) => {
                clearTimeout(timer);
                reject(err);
            });

            socket.on('close', () => {
                clearTimeout(timer);
                reject(new Error('Socket closed'));
            });
        });
    }

    // --- Cleanup ---

    _getSocketPath(consolePid) {
        return this._consoles.get(consolePid)?.socketPath || null;
    }

    _removeConsole(consolePid) {
        this._consoles.delete(consolePid);
        this._busyPids.delete(consolePid);
        if (this._activePid === consolePid) {
            this._activePid = this._consoles.size > 0
                ? this._consoles.keys().next().value
                : null;
        }
    }

    dispose() {
        // Don't kill consoles — they may be shared with user
        this._consoles.clear();
        this._busyPids.clear();
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0); // signal 0 = check existence only
        return true;
    } catch {
        return false;
    }
}
