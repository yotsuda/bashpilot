#!/usr/bin/env node

/**
 * bashpilot - Shared console MCP server for bash
 *
 * Two modes:
 *   1. MCP server mode (default): Started by MCP client via stdio.
 *      AI calls start_console to open a visible terminal window.
 *   2. Console mode (--console): Runs inside the visible terminal window.
 *      Connects back to the MCP server via Unix domain socket.
 */

import { parseArgs } from './args.js';

const options = parseArgs();

if (options.console) {
    const { startConsole } = await import('./console.js');
    await startConsole(options);
} else {
    const { startMcpServer } = await import('./mcp-server.js');
    await startMcpServer();
}
