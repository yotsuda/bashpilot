#!/usr/bin/env node

/**
 * bash-mcp - Shared console MCP server for bash
 *
 * Launches an interactive bash session that both the user and AI can use.
 * The user types in the terminal as normal.
 * AI sends commands via MCP, and they appear in the same terminal.
 *
 * Usage:
 *   node src/index.js [--port PORT] [--shell SHELL]
 *
 * The MCP server listens on http://localhost:PORT/sse (default port: 8818)
 */

import { PtyManager } from './pty-manager.js';
import { startMcpHttpServer } from './mcp-server.js';

function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        port: 8818,
        shell: undefined,
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--port' && args[i + 1]) {
            options.port = parseInt(args[i + 1], 10);
            i++;
        } else if (args[i] === '--shell' && args[i + 1]) {
            options.shell = args[i + 1];
            i++;
        }
    }

    return options;
}

async function main() {
    const options = parseArgs();

    // Start PTY (interactive bash with shell integration)
    const pty = new PtyManager({
        shell: options.shell,
        cwd: process.cwd(),
    });

    // Start MCP server
    const httpServer = await startMcpHttpServer(pty, options.port);
    const addr = httpServer.address();

    // Print banner to stderr (so it doesn't interfere with terminal output)
    process.stderr.write(
        `\x1b[90m[bash-mcp] MCP server listening on http://localhost:${addr.port}/sse\x1b[0m\n`
    );

    // Start the terminal (this sets up stdin/stdout forwarding)
    pty.start();

    // Cleanup on exit
    const cleanup = () => {
        pty.dispose();
        httpServer.close();
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

main().catch((err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    process.exit(1);
});
