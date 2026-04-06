/**
 * Console mode: runs inside a visible terminal window.
 *
 * 1. Spawns bash PTY with shell integration
 * 2. Forwards stdin/stdout for user interaction
 * 3. Connects to MCP server via TCP localhost
 * 4. Receives commands from MCP server, writes to PTY, returns output
 */

import net from 'node:net';
import { PtyManager } from './pty-manager.js';

export async function startConsole(options) {
    const socketArg = options.socket;
    if (!socketArg) {
        process.stderr.write('Error: --socket is required in console mode\n');
        process.exit(1);
    }

    const pty = new PtyManager({
        shell: options.shell,
        cwd: options.cwd || process.cwd(),
    });

    // Parse socket argument: "tcp:PORT" or a Unix socket path
    let connectOptions;
    if (socketArg.startsWith('tcp:')) {
        const port = parseInt(socketArg.substring(4), 10);
        connectOptions = { host: '127.0.0.1', port };
    } else {
        connectOptions = { path: socketArg };
    }

    const client = net.createConnection(connectOptions, () => {
        sendMessage(client, { type: 'ready', pid: process.pid });
    });

    let recvBuf = Buffer.alloc(0);

    client.on('data', (data) => {
        recvBuf = Buffer.concat([recvBuf, data]);

        while (recvBuf.length >= 4) {
            const len = recvBuf.readUInt32LE(0);
            if (recvBuf.length < 4 + len) break;
            const json = recvBuf.subarray(4, 4 + len).toString('utf8');
            recvBuf = recvBuf.subarray(4 + len);

            try {
                const msg = JSON.parse(json);
                handleMessage(msg);
            } catch {}
        }
    });

    async function handleMessage(msg) {
        if (msg.type === 'execute') {
            try {
                const result = await pty.executeCommand(msg.command, msg.timeout || 30000);
                sendMessage(client, {
                    type: 'result',
                    id: msg.id,
                    output: result.output,
                    exitCode: result.exitCode
                });
            } catch (err) {
                sendMessage(client, {
                    type: 'error',
                    id: msg.id,
                    message: err.message
                });
            }
        } else if (msg.type === 'set_title') {
            // Set terminal window title via escape sequence
            pty.setTitle(msg.title);
        }
    }

    client.on('error', (err) => {
        process.stderr.write(`\x1b[31m[bashpilot] Connection error: ${err.message}\x1b[0m\n`);
        process.exit(1);
    });

    client.on('close', () => {
        pty.dispose();
        process.exit(0);
    });

    // Start PTY (user-facing terminal)
    pty.start();

    const cleanup = () => {
        pty.dispose();
        client.destroy();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

function sendMessage(socket, obj) {
    const json = JSON.stringify(obj);
    const buf = Buffer.from(json, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(buf.length);
    socket.write(lenBuf);
    socket.write(buf);
}
