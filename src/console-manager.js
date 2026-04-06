/**
 * Manages multiple console processes from the MCP server side.
 *
 * - Tracks console state: standby (idle) or busy (executing)
 * - Auto-switches to a standby console when the active one is busy
 * - Launches new consoles when none are available
 * - Assigns display names and sets window titles
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { launchConsole } from './console-launcher.js';
import { generateDisplayName } from './console-names.js';

export class ConsoleManager {
    constructor() {
        this._server = null;
        this._port = 0;
        this._consoles = new Map();  // pid → { socket, pid, displayName, busy }
        this._activePid = null;      // PID of the currently active console
        this._pendingRequests = new Map();
        this._recvBufs = new Map();  // pid → Buffer
        this._connectResolve = null;
    }

    get hasConsole() {
        return this._consoles.size > 0;
    }

    /**
     * Initialize the TCP server.
     */
    async init() {
        return new Promise((resolve, reject) => {
            this._server = net.createServer((socket) => {
                this._handleConnection(socket);
            });
            this._server.on('error', reject);
            this._server.listen(0, '127.0.0.1', () => {
                this._port = this._server.address().port;
                resolve();
            });
        });
    }

    /**
     * Start or reuse a console.
     * If reason is provided, always launch a new console.
     * Otherwise, reuse an existing standby console if available.
     */
    async startConsole(options = {}) {
        const forceNew = !!options.reason;

        if (!forceNew) {
            // Try to find a standby console
            const standby = this._findStandbyConsole();
            if (standby) {
                this._activePid = standby.pid;
                return {
                    status: 'reused',
                    pid: standby.pid,
                    displayName: standby.displayName
                };
            }
        }

        // Launch new console
        launchConsole(`tcp:${this._port}`, {
            shell: options.shell,
            cwd: options.cwd,
        });

        const pid = await this._waitForConnection(15000);
        const console = this._consoles.get(pid);

        // Assign display name and set window title
        const displayName = generateDisplayName(pid);
        console.displayName = displayName;
        this._activePid = pid;

        // Tell console to set window title
        this._sendMessage(console.socket, {
            type: 'set_title',
            title: `bashpilot — ${displayName}`,
        });

        return { status: 'started', pid, displayName };
    }

    /**
     * Execute a command on a console.
     * If active console is busy, auto-switch to standby or launch new.
     */
    async executeCommand(command, timeoutMs = 30000) {
        let console = this._getActiveConsole();

        if (!console) {
            throw new Error('No console connected. Call start_console first.');
        }

        // If active console is busy, find or launch another
        if (console.busy) {
            const standby = this._findStandbyConsole();
            if (standby) {
                this._activePid = standby.pid;
                console = standby;
            } else {
                // Launch a new console and wait for it
                launchConsole(`tcp:${this._port}`, {});
                const newPid = await this._waitForConnection(15000);
                const newConsole = this._consoles.get(newPid);
                const displayName = generateDisplayName(newPid);
                newConsole.displayName = displayName;
                this._activePid = newPid;

                this._sendMessage(newConsole.socket, {
                    type: 'set_title',
                    title: `bashpilot — ${displayName}`,
                });

                console = newConsole;
            }
        }

        // Mark busy
        console.busy = true;
        const consolePid = console.pid;
        const id = randomUUID();

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this._pendingRequests.delete(id);
                // Don't unmark busy on timeout — command may still be running
                reject(new Error(`Command timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this._pendingRequests.set(id, {
                resolve: (result) => {
                    const c = this._consoles.get(consolePid);
                    if (c) c.busy = false;
                    resolve(result);
                },
                reject: (err) => {
                    const c = this._consoles.get(consolePid);
                    if (c) c.busy = false;
                    reject(err);
                },
                timeoutId
            });

            this._sendMessage(console.socket, {
                type: 'execute',
                id,
                command,
                timeout: timeoutMs,
            });
        });
    }

    /**
     * Get status of all consoles.
     */
    getStatus() {
        const consoles = [];
        for (const [pid, c] of this._consoles) {
            consoles.push({
                pid,
                displayName: c.displayName,
                busy: c.busy,
                active: pid === this._activePid,
            });
        }
        return consoles;
    }

    _getActiveConsole() {
        if (this._activePid && this._consoles.has(this._activePid)) {
            return this._consoles.get(this._activePid);
        }
        // Fallback to any console
        for (const c of this._consoles.values()) {
            this._activePid = c.pid;
            return c;
        }
        return null;
    }

    _findStandbyConsole() {
        for (const c of this._consoles.values()) {
            if (!c.busy) return c;
        }
        return null;
    }

    _handleConnection(socket) {
        const socketId = randomUUID();
        this._recvBufs.set(socketId, Buffer.alloc(0));

        socket.on('data', (data) => {
            const buf = Buffer.concat([this._recvBufs.get(socketId) || Buffer.alloc(0), data]);
            this._recvBufs.set(socketId, buf);
            this._processMessages(socketId, socket);
        });

        socket.on('close', () => {
            this._recvBufs.delete(socketId);
            // Find and remove the console by socket
            for (const [pid, c] of this._consoles) {
                if (c.socket === socket) {
                    this._consoles.delete(pid);
                    if (this._activePid === pid) {
                        // Switch active to another console if available
                        this._activePid = this._consoles.size > 0
                            ? this._consoles.keys().next().value
                            : null;
                    }
                    break;
                }
            }
            // Reject pending requests for this socket
            for (const [id, req] of this._pendingRequests) {
                clearTimeout(req.timeoutId);
                req.reject(new Error('Console disconnected'));
            }
        });

        socket.on('error', () => socket.destroy());
    }

    _processMessages(socketId, socket) {
        let buf = this._recvBufs.get(socketId);
        while (buf && buf.length >= 4) {
            const len = buf.readUInt32LE(0);
            if (buf.length < 4 + len) break;
            const json = buf.subarray(4, 4 + len).toString('utf8');
            buf = buf.subarray(4 + len);
            this._recvBufs.set(socketId, buf);
            try {
                this._handleMessage(socket, JSON.parse(json));
            } catch {}
        }
    }

    _handleMessage(socket, msg) {
        switch (msg.type) {
            case 'ready': {
                const pid = msg.pid;
                this._consoles.set(pid, {
                    socket,
                    pid,
                    displayName: null,
                    busy: false,
                });
                if (this._connectResolve) {
                    this._connectResolve(pid);
                    this._connectResolve = null;
                }
                break;
            }

            case 'result':
            case 'error': {
                const req = this._pendingRequests.get(msg.id);
                if (req) {
                    clearTimeout(req.timeoutId);
                    this._pendingRequests.delete(msg.id);
                    if (msg.type === 'result') {
                        req.resolve({ output: msg.output, exitCode: msg.exitCode });
                    } else {
                        req.reject(new Error(msg.message));
                    }
                }
                break;
            }
        }
    }

    _sendMessage(socket, obj) {
        const json = JSON.stringify(obj);
        const buf = Buffer.from(json, 'utf8');
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(buf.length);
        socket.write(lenBuf);
        socket.write(buf);
    }

    _waitForConnection(timeoutMs) {
        return new Promise((resolve, reject) => {
            // Check if a console just connected
            if (this._connectResolve) {
                reject(new Error('Already waiting for a connection'));
                return;
            }
            this._connectResolve = resolve;
            setTimeout(() => {
                if (this._connectResolve === resolve) {
                    this._connectResolve = null;
                    reject(new Error('Console failed to connect within timeout'));
                }
            }, timeoutMs);
        });
    }

    dispose() {
        for (const c of this._consoles.values()) {
            c.socket.destroy();
        }
        this._consoles.clear();
        if (this._server) {
            this._server.close();
        }
    }
}
