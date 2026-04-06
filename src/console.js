/**
 * Console mode: runs inside a visible terminal window.
 *
 * Each console is a socket/TCP SERVER — the MCP proxy connects to it.
 * - Unix: listens on a Unix domain socket file
 * - Windows: listens on TCP localhost; writes port to a .port marker file
 *
 * Handles requests from MCP proxy: get_status, execute, set_title
 */

import net from 'node:net';
import { PtyManager } from './pty-manager.js';
import { getSocketPath, cleanupSocket, writePortFile, usesTcp } from './socket-paths.js';

export async function startConsole(options) {
    const { proxyPid, agentId } = options;
    if (!proxyPid) {
        process.stderr.write('Error: --proxy-pid is required in console mode\n');
        process.exit(1);
    }

    const consolePid = process.pid;
    const markerPath = getSocketPath(proxyPid, agentId || 'default', consolePid);

    const pty = new PtyManager({
        shell: options.shell,
        cwd: options.cwd || process.cwd(),
    });

    const server = net.createServer((socket) => {
        handleConnection(socket, pty);
    });

    if (usesTcp()) {
        // Windows: listen on TCP localhost, write port to marker file
        server.listen(0, '127.0.0.1', () => {
            const port = server.address().port;
            writePortFile(markerPath, port);
        });
    } else {
        // Unix: listen on domain socket
        cleanupSocket(markerPath);
        server.listen(markerPath);
    }

    server.on('error', (err) => {
        process.stderr.write(`\x1b[31m[bashpilot] Server error: ${err.message}\x1b[0m\n`);
        process.exit(1);
    });

    // Start PTY (user-facing terminal)
    pty.start();

    // Cleanup on exit
    const cleanup = () => {
        pty.dispose();
        server.close();
        cleanupSocket(markerPath);
    };
    process.on('exit', () => cleanupSocket(markerPath));
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

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
            sendMessage(socket, {
                type: 'status',
                status: busy ? 'busy' : 'standby',
                pid: process.pid,
            });
            break;
        }

        case 'execute': {
            try {
                const result = await pty.executeCommand(msg.command, msg.timeout || 30000);
                sendMessage(socket, {
                    type: 'result',
                    id: msg.id,
                    output: result.output,
                    exitCode: result.exitCode
                });
            } catch (err) {
                sendMessage(socket, {
                    type: 'error',
                    id: msg.id,
                    message: err.message
                });
            }
            break;
        }

        case 'get_location': {
            try {
                const info = await getLocationInfo(pty);
                sendMessage(socket, { type: 'location', location: info });
            } catch (err) {
                sendMessage(socket, { type: 'error', message: err.message });
            }
            break;
        }

        case 'set_title': {
            pty.setTitle(msg.title);
            break;
        }
    }
}

async function getLocationInfo(pty) {
    // Collect system/session info by running a script in the bash PTY
    const script = [
        'echo "@@BASHPILOT_LOCATION_START@@"',
        'echo "pwd:$(pwd)"',
        'echo "user:$(whoami)"',
        'echo "hostname:$(hostname)"',
        'echo "shell:$BASH_VERSION"',
        'echo "os:$(uname -s -r -m)"',
        'echo "term:$TERM"',
        'echo "lang:$LANG"',
        'echo "@@BASHPILOT_LOCATION_END@@"',
    ].join('; ');

    const result = await pty.executeCommand(script, 5000);
    const lines = result.output.split('\n');

    const info = {
        current_directory: null,
        user: null,
        hostname: null,
        bash_version: null,
        os: null,
        term: null,
        lang: null,
    };

    for (const line of lines) {
        const [key, ...rest] = line.split(':');
        const value = rest.join(':');
        switch (key) {
            case 'pwd': info.current_directory = value; break;
            case 'user': info.user = value; break;
            case 'hostname': info.hostname = value; break;
            case 'shell': info.bash_version = value; break;
            case 'os': info.os = value; break;
            case 'term': info.term = value; break;
            case 'lang': info.lang = value; break;
        }
    }

    return info;
}

function sendMessage(socket, obj) {
    const json = JSON.stringify(obj);
    const buf = Buffer.from(json, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(buf.length);
    socket.write(lenBuf);
    socket.write(buf);
}
