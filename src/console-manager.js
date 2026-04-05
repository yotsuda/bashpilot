/**
 * Manages console processes from the MCP server side.
 *
 * - Listens on a TCP localhost port for console connections
 * - Launches visible terminal windows via console-launcher
 * - Routes commands to the active console
 * - Handles console lifecycle (connect, disconnect)
 *
 * Uses TCP localhost instead of Unix domain sockets for cross-platform
 * compatibility (Windows named pipes are not accessible from WSL bash).
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { launchConsole } from './console-launcher.js';

export class ConsoleManager {
    constructor() {
        this._server = null;
        this._port = 0;             // assigned by OS
        this._console = null;        // { socket, pid }
        this._pendingRequests = new Map();
        this._recvBuf = Buffer.alloc(0);
        this._connectResolve = null;
    }

    get hasConsole() {
        return this._console !== null;
    }

    /**
     * Initialize the TCP server on a random localhost port.
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
     * Launch a new console window.
     */
    async startConsole(options = {}) {
        if (this._console) {
            return { status: 'reused', pid: this._console.pid };
        }

        // Pass TCP port as the "socket" path — console connects via TCP
        launchConsole(`tcp:${this._port}`, {
            shell: options.shell,
            cwd: options.cwd,
        });

        const pid = await this._waitForConnection(15000);
        return { status: 'started', pid };
    }

    /**
     * Send a command to the console and wait for the result.
     */
    async executeCommand(command, timeoutMs = 30000) {
        if (!this._console) {
            throw new Error('No console connected. Call start_console first.');
        }

        const id = randomUUID();

        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this._pendingRequests.delete(id);
                reject(new Error(`Command timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            this._pendingRequests.set(id, { resolve, reject, timeoutId });

            this._sendMessage(this._console.socket, {
                type: 'execute',
                id,
                command,
                timeout: timeoutMs,
            });
        });
    }

    _handleConnection(socket) {
        socket.on('data', (data) => {
            this._recvBuf = Buffer.concat([this._recvBuf, data]);
            this._processMessages(socket);
        });

        socket.on('close', () => {
            if (this._console && this._console.socket === socket) {
                this._console = null;
                for (const [id, req] of this._pendingRequests) {
                    clearTimeout(req.timeoutId);
                    req.reject(new Error('Console disconnected'));
                }
                this._pendingRequests.clear();
            }
        });

        socket.on('error', () => {
            socket.destroy();
        });
    }

    _processMessages(socket) {
        while (this._recvBuf.length >= 4) {
            const len = this._recvBuf.readUInt32LE(0);
            if (this._recvBuf.length < 4 + len) break;
            const json = this._recvBuf.subarray(4, 4 + len).toString('utf8');
            this._recvBuf = this._recvBuf.subarray(4 + len);
            try {
                const msg = JSON.parse(json);
                this._handleMessage(socket, msg);
            } catch {}
        }
    }

    _handleMessage(socket, msg) {
        switch (msg.type) {
            case 'ready':
                this._console = { socket, pid: msg.pid };
                if (this._connectResolve) {
                    this._connectResolve(msg.pid);
                    this._connectResolve = null;
                }
                break;

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
        if (this._console) {
            return Promise.resolve(this._console.pid);
        }
        return new Promise((resolve, reject) => {
            this._connectResolve = resolve;
            setTimeout(() => {
                if (!this._console) {
                    this._connectResolve = null;
                    reject(new Error('Console failed to connect within timeout'));
                }
            }, timeoutMs);
        });
    }

    dispose() {
        if (this._console) {
            this._console.socket.destroy();
            this._console = null;
        }
        if (this._server) {
            this._server.close();
        }
    }
}
