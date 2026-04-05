/**
 * MCP server exposing bash terminal tools via HTTP+SSE transport.
 *
 * Each SSE connection gets its own McpServer instance because the SDK
 * requires one transport per server.
 *
 * Tools:
 *   execute_command - Run a command in the shared bash session
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import { z } from 'zod';

function createMcpServer(ptyManager) {
    const server = new McpServer({
        name: 'bash-mcp',
        version: '0.1.0',
    });

    server.tool(
        'execute_command',
        'Execute a command in the shared bash terminal. The command and its output are visible to the user in real time. Session state (cwd, env vars, functions) persists across calls.',
        {
            command: z.string().describe('The bash command to execute'),
            timeout_seconds: z.number().optional().default(30).describe('Timeout in seconds (default: 30)')
        },
        async ({ command, timeout_seconds }) => {
            try {
                const result = await ptyManager.executeCommand(command, timeout_seconds * 1000);
                const text = result.output || '(no output)';
                return {
                    content: [{ type: 'text', text }],
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

    return server;
}

/**
 * Start the MCP HTTP+SSE server on the given port.
 */
export async function startMcpHttpServer(ptyManager, port) {
    const app = express();

    const transports = {};

    app.get('/sse', async (req, res) => {
        const server = createMcpServer(ptyManager);
        const transport = new SSEServerTransport('/messages', res);
        transports[transport.sessionId] = transport;
        res.on('close', () => {
            delete transports[transport.sessionId];
            server.close().catch(() => {});
        });
        await server.connect(transport);
    });

    app.post('/messages', async (req, res) => {
        const sessionId = req.query.sessionId;
        const transport = transports[sessionId];
        if (transport) {
            await transport.handlePostMessage(req, res);
        } else {
            res.status(400).json({ error: 'Unknown session' });
        }
    });

    return new Promise((resolve) => {
        const httpServer = app.listen(port, () => {
            resolve(httpServer);
        });
    });
}
