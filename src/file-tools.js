/**
 * File operation tools — Node.js native, not PTY-based.
 * Compatible with Claude Code's Read, Write, Edit, Grep, Glob tools.
 */

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

/**
 * Register file tools on an McpServer instance.
 */
export function registerFileTools(server) {
    server.tool(
        'read_file',
        'Read a file with line numbers. Supports offset and limit for large files.',
        {
            path: z.string().describe('Absolute path to the file'),
            offset: z.coerce.number().optional().default(0).describe('Line number to start from (0-based)'),
            limit: z.coerce.number().optional().default(2000).describe('Maximum number of lines to read'),
        },
        async ({ path: filePath, offset, limit }) => {
            try {
                if (!fs.existsSync(filePath)) {
                    return error(`File not found: ${filePath}`);
                }
                const content = fs.readFileSync(filePath, 'utf8');
                const lines = content.split('\n');
                const selected = lines.slice(offset, offset + limit);
                const numbered = selected.map((line, i) =>
                    `${String(offset + i + 1).padStart(4)}: ${line}`
                ).join('\n');
                const info = lines.length > offset + limit
                    ? `\n\n[Showing lines ${offset + 1}-${offset + selected.length} of ${lines.length}]`
                    : '';
                return ok(numbered + info);
            } catch (err) {
                return error(err.message);
            }
        }
    );

    server.tool(
        'write_file',
        'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
        {
            path: z.string().describe('Absolute path to the file'),
            content: z.string().describe('Content to write'),
        },
        async ({ path: filePath, content }) => {
            try {
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                fs.writeFileSync(filePath, content, 'utf8');
                const lines = content.split('\n').length;
                return ok(`Written ${lines} lines to ${filePath}`);
            } catch (err) {
                return error(err.message);
            }
        }
    );

    server.tool(
        'edit_file',
        'Edit a file by replacing an exact string with a new string. The old_string must be unique in the file.',
        {
            path: z.string().describe('Absolute path to the file'),
            old_string: z.string().describe('Exact string to find and replace'),
            new_string: z.string().describe('Replacement string'),
        },
        async ({ path: filePath, old_string, new_string }) => {
            try {
                if (!fs.existsSync(filePath)) {
                    return error(`File not found: ${filePath}`);
                }
                const content = fs.readFileSync(filePath, 'utf8');
                const count = content.split(old_string).length - 1;
                if (count === 0) {
                    return error('old_string not found in file.');
                }
                if (count > 1) {
                    return error(`old_string found ${count} times. It must be unique. Add more context to make it unique.`);
                }
                const newContent = content.replace(old_string, new_string);
                fs.writeFileSync(filePath, newContent, 'utf8');
                return ok(`Replaced 1 occurrence in ${filePath}`);
            } catch (err) {
                return error(err.message);
            }
        }
    );

    server.tool(
        'search_files',
        'Search file contents using a regular expression. Returns matching lines with file paths and line numbers.',
        {
            pattern: z.string().describe('Regular expression pattern to search for'),
            path: z.string().optional().describe('Directory or file to search in (default: current directory)'),
            glob: z.string().optional().describe('Glob pattern to filter files (e.g., "*.js", "**/*.ts")'),
            max_results: z.coerce.number().optional().default(50).describe('Maximum number of results'),
        },
        async ({ pattern, path: searchPath, glob: globPattern, max_results }) => {
            try {
                const regex = new RegExp(pattern, 'i');
                const basePath = searchPath || process.cwd();
                const results = [];

                if (fs.statSync(basePath).isFile()) {
                    searchInFile(basePath, regex, results, max_results);
                } else {
                    walkDir(basePath, regex, results, max_results, globPattern);
                }

                if (results.length === 0) {
                    return ok('No matches found.');
                }
                return ok(results.join('\n'));
            } catch (err) {
                return error(err.message);
            }
        }
    );

    server.tool(
        'find_files',
        'Find files by glob pattern. Returns matching file paths.',
        {
            pattern: z.string().describe('Glob-like pattern (e.g., "*.js", "src/**/*.ts")'),
            path: z.string().optional().describe('Base directory to search in (default: current directory)'),
        },
        async ({ pattern, path: basePath }) => {
            try {
                const dir = basePath || process.cwd();
                const results = [];
                findFiles(dir, pattern, results, 200);
                if (results.length === 0) {
                    return ok('No files found.');
                }
                return ok(results.join('\n'));
            } catch (err) {
                return error(err.message);
            }
        }
    );
}

// --- Helpers ---

function ok(text) {
    return { content: [{ type: 'text', text }] };
}

function error(message) {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

function searchInFile(filePath, regex, results, maxResults) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
            if (regex.test(lines[i])) {
                results.push(`${filePath}:${i + 1}: ${lines[i]}`);
            }
        }
    } catch {
        // Skip unreadable files
    }
}

function walkDir(dir, regex, results, maxResults, globPattern) {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= maxResults) return;
            const fullPath = path.join(dir, entry.name);

            // Skip common non-content directories
            if (entry.isDirectory()) {
                if (['node_modules', '.git', '.hg', '.svn', '__pycache__', 'dist', 'build'].includes(entry.name)) continue;
                walkDir(fullPath, regex, results, maxResults, globPattern);
            } else if (entry.isFile()) {
                if (globPattern && !matchGlob(entry.name, globPattern)) continue;
                searchInFile(fullPath, regex, results, maxResults);
            }
        }
    } catch {
        // Skip unreadable directories
    }
}

function findFiles(dir, pattern, results, maxResults) {
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (results.length >= maxResults) return;
            const fullPath = path.join(dir, entry.name);

            if (entry.isDirectory()) {
                if (['node_modules', '.git', '.hg', '.svn', '__pycache__', 'dist', 'build'].includes(entry.name)) continue;
                findFiles(fullPath, pattern, results, maxResults);
            } else if (entry.isFile()) {
                if (matchGlob(entry.name, pattern) || matchGlob(fullPath, pattern)) {
                    results.push(fullPath);
                }
            }
        }
    } catch {
        // Skip unreadable directories
    }
}

/**
 * Simple glob matching (supports * and **).
 */
function matchGlob(str, pattern) {
    const regex = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '§§')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/§§/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${regex}$`, 'i').test(str) ||
           new RegExp(`(^|[\\/\\\\])${regex}$`, 'i').test(str);
}
