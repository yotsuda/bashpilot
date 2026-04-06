/**
 * Console mode: runs inside a visible terminal window.
 *
 * Each console is a socket/TCP SERVER — the MCP proxy connects to it.
 *
 * Two modes:
 *   Owned:   started with --proxy-pid → socket: bashpilot.{proxyPid}.{agentId}.{pid}.sock
 *   Unowned: started without --proxy-pid → socket: bashpilot.{pid}.sock
 *
 * Owned consoles monitor proxy liveness and revert to unowned if proxy dies.
 * Unowned consoles can be claimed by a proxy via the 'claim' message.
 */

import net from 'node:net';
import { PtyManager } from './pty-manager.js';
import { getSocketPath, getUnownedSocketPath, cleanupSocket, writePortFile, usesTcp } from './socket-paths.js';

// Console ownership state
let _proxyPid = null;
let _agentId = null;
let _server = null;
let _markerPath = null;
let _pty = null;
let _livenessTimer = null;

export async function startConsole(options) {
    _proxyPid = options.proxyPid || null;
    _agentId = options.agentId || 'default';

    const consolePid = process.pid;

    _pty = new PtyManager({
        shell: options.shell,
        cwd: options.cwd || process.cwd(),
        onReady: () => {
            if (options.title) {
                process.stdout.write(`\x1b]0;${options.title}\x07`);
            } else if (!_proxyPid) {
                // Unowned: set a default title
                process.stdout.write(`\x1b]0;bashpilot #${consolePid}\x07`);
            }
        },
    });

    // Start listening on the appropriate socket
    _markerPath = _proxyPid
        ? getSocketPath(_proxyPid, _agentId, consolePid)
        : getUnownedSocketPath(consolePid);

    _server = createSocketServer();
    startListening(_server, _markerPath);

    _server.on('error', (err) => {
        process.stderr.write(`\x1b[31m[bashpilot] Server error: ${err.message}\x1b[0m\n`);
        process.exit(1);
    });

    // Start proxy liveness monitoring if owned
    if (_proxyPid) {
        startLivenessMonitor();
    }

    // Start PTY (user-facing terminal)
    _pty.start();

    // Cleanup on exit
    const cleanup = () => {
        stopLivenessMonitor();
        _pty.dispose();
        _server.close();
        cleanupSocket(_markerPath);
    };
    process.on('exit', () => cleanupSocket(_markerPath));
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

function createSocketServer() {
    return net.createServer((socket) => {
        handleConnection(socket, _pty);
    });
}

function startListening(server, path) {
    if (usesTcp()) {
        server.listen(0, '127.0.0.1', () => {
            writePortFile(path, server.address().port);
        });
    } else {
        cleanupSocket(path);
        server.listen(path);
    }
}

// --- Proxy liveness monitoring ---

function startLivenessMonitor() {
    stopLivenessMonitor();
    _livenessTimer = setInterval(() => {
        if (_proxyPid && !isProcessAlive(_proxyPid)) {
            revertToUnowned();
        }
    }, 5000);
}

function stopLivenessMonitor() {
    if (_livenessTimer) {
        clearInterval(_livenessTimer);
        _livenessTimer = null;
    }
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Revert from owned to unowned state.
 * Called when the proxy process dies.
 */
function revertToUnowned() {
    stopLivenessMonitor();

    const oldPath = _markerPath;
    _proxyPid = null;
    _agentId = 'default';
    _markerPath = getUnownedSocketPath(process.pid);

    // Close old server and start new one on unowned socket
    _server.close(() => {
        cleanupSocket(oldPath);
        _server = createSocketServer();
        startListening(_server, _markerPath);
        _server.on('error', (err) => {
            process.stderr.write(`\x1b[31m[bashpilot] Server error after revert: ${err.message}\x1b[0m\n`);
        });
    });

    // Update window title
    process.stdout.write(`\x1b]0;bashpilot #${process.pid}\x07`);
}

/**
 * Claim this console for a proxy. Transitions from unowned to owned.
 */
async function handleClaim(proxyPid, agentId, socket) {
    const oldPath = _markerPath;
    _proxyPid = proxyPid;
    _agentId = agentId || 'default';
    _markerPath = getSocketPath(_proxyPid, _agentId, process.pid);

    // Respond before closing (may not arrive — fire-and-forget on proxy side)
    sendMessage(socket, { type: 'claimed', newPath: _markerPath });

    // Close old server and start new one on owned socket
    _server.close(() => {
        cleanupSocket(oldPath);
        _server = createSocketServer();
        startListening(_server, _markerPath);
        _server.on('error', (err) => {
            process.stderr.write(`\x1b[31m[bashpilot] Server error after claim: ${err.message}\x1b[0m\n`);
        });

        // Start monitoring proxy liveness
        startLivenessMonitor();
    });
}

// --- Message handling ---

function handleConnection(socket, pty) {
    let recvBuf = Buffer.alloc(0);

    socket.on('data', (data) => {
        recvBuf = Buffer.concat([recvBuf, data]);

        while (recvBuf.length >= 4) {
            const len = recvBuf.readUInt32LE(0);
            if (recvBuf.length < 4 + len) break;
            const json = recvBuf.subarray(4, 4 + len).toString('utf8');
            recvBuf = recvBuf.subarray(4 + len);

            try {
                const msg = JSON.parse(json);
                handleMessage(msg, socket, pty);
            } catch {}
        }
    });

    socket.on('error', () => {});
}

async function handleMessage(msg, socket, pty) {
    switch (msg.type) {
        case 'get_status': {
            const busy = pty.tracker.busy;
            const hasCached = pty.tracker.hasCachedOutput;
            sendMessage(socket, {
                type: 'status',
                status: hasCached ? 'completed' : (busy ? 'busy' : 'standby'),
                pid: process.pid,
                owned: !!_proxyPid,
            });
            break;
        }

        case 'get_cached_output': {
            const cached = pty.tracker.consumeCachedOutput();
            if (cached) {
                sendMessage(socket, {
                    type: 'cached_result',
                    output: cached.output,
                    exitCode: cached.exitCode,
                    cwd: cached.cwd,
                    command: cached.command,
                    duration: cached.duration,
                });
            } else {
                sendMessage(socket, { type: 'no_cache' });
            }
            break;
        }

        case 'execute': {
            const startTime = Date.now();
            try {
                const result = await pty.executeCommand(msg.command, msg.timeout || 30000);
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                sendMessage(socket, {
                    type: 'result',
                    id: msg.id,
                    output: result.output,
                    exitCode: result.exitCode,
                    duration,
                    command: msg.command,
                    cwd: result.cwd,
                });
            } catch (err) {
                const duration = ((Date.now() - startTime) / 1000).toFixed(2);
                sendMessage(socket, {
                    type: 'error',
                    id: msg.id,
                    message: err.message,
                    duration,
                    command: msg.command,
                });
            }
            break;
        }

        case 'claim': {
            await handleClaim(msg.proxyPid, msg.agentId, socket);
            break;
        }

        case 'set_title': {
            pty.setTitle(msg.title);
            break;
        }
    }
}

function sendMessage(socket, obj) {
    const json = JSON.stringify(obj);
    const buf = Buffer.from(json, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(buf.length);
    socket.write(lenBuf);
    socket.write(buf);
}
