/**
 * MCP server (stdio transport) with start_console and execute_command tools.
 *
 * Flow:
 *   1. MCP client starts bashpilot via stdio
 *   2. AI calls start_console → visible terminal window opens
 *   3. AI calls execute_command → command runs in the visible terminal
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConsoleManager } from './console-manager.js';

export async function startMcpServer() {
    const consoleManager = new ConsoleManager();
    await consoleManager.init();

    const server = new McpServer({
        name: 'bashpilot',
        version: '0.1.0',
    });

    server.tool(
        'start_console',
        'Open a visible bash terminal window. The user can see and type in this terminal. AI commands sent via execute_command will also appear here.',
        {
            shell: z.string().optional().describe('Shell to use (default: $SHELL or bash)'),
            cwd: z.string().optional().describe('Working directory for the console'),
        },
        async ({ shell, cwd }) => {
            try {
                const result = await consoleManager.startConsole({ shell, cwd });
                const msg = result.status === 'reused'
                    ? `Console already open (PID ${result.pid}). Reusing existing session.`
                    : `Console opened (PID ${result.pid}). The user can see the terminal window.`;
                return { content: [{ type: 'text', text: msg }] };
            } catch (err) {
                return {
                    content: [{ type: 'text', text: `Failed to start console: ${err.message}` }],
                    isError: true
                };
            }
        }
    );

    server.tool(
        'execute_command',
        'Execute a command in the shared bash terminal. The command and its output are visible to the user in real time. Session state (cwd, env vars, functions) persists across calls. Call start_console first if no console is open.',
        {
            command: z.string().describe('The bash command to execute'),
            timeout_seconds: z.number().optional().default(30).describe('Timeout in seconds (default: 30)')
        },
        async ({ command, timeout_seconds }) => {
            try {
                const result = await consoleManager.executeCommand(command, timeout_seconds * 1000);
                return {
                    content: [{ type: 'text', text: result.output || '(no output)' }],
                    metadata: { exitCode: result.exitCode }
                };
            } catch (err) {
                return {
                    content: [{ type: 'text', text: `Error: ${err.message}` }],
                    isError: true
                };
            }
        }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Cleanup on exit
    process.on('SIGINT', () => consoleManager.dispose());
    process.on('SIGTERM', () => consoleManager.dispose());
}
