#!/usr/bin/env node

/**
 * bashpilot - Shared console MCP server for bash
 *
 * Two modes:
 *   1. MCP server mode (default): Started by MCP client via stdio.
 *      AI calls start_console to open a visible terminal window.
 *   2. Console mode (--console): Runs inside the visible terminal window.
 *      Connects back to the MCP server via Unix domain socket.
 *
 * Usage:
 *   bashpilot                              # MCP server mode (stdio)
 *   bashpilot --console --socket PATH      # Console mode (internal)
 */

import { parseArgs } from './args.js';

const options = parseArgs();

if (options.console) {
    // Console mode: run inside a visible terminal window
    const { startConsole } = await import('./console.js');
    await startConsole(options);
} else {
    // MCP server mode: stdio transport, manages console processes
    const { startMcpServer } = await import('./mcp-server.js');
    await startMcpServer();
}
