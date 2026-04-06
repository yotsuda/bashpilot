/**
 * File operation tools — Node.js native, optimized for performance.
 *
 * Design principles (from PowerShell.MCP):
 * - Single-pass processing wherever possible
 * - Streaming for large files (no full file load for read/search)
 * - Binary file detection and skip
 * - Shared read access (don't fail on locked files)
 * - Early termination when limits are reached
 */

import fs from 'node:fs';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { z } from 'zod';

const BINARY_CHECK_BYTES = 8192;
const MAX_LINE_LENGTH = 10000; // Truncate extremely long lines in output

/**
 * Register file tools on an McpServer instance.
 */
export function registerFileTools(server) {
    server.tool(
        'read_file',
        'Read a file with line numbers. Supports offset/limit for large files, or tail to read the last N lines.',
        {
            path: z.string().describe('Absolute path to the file'),
            offset: z.coerce.number().optional().default(0).describe('Line number to start from (0-based)'),
            limit: z.coerce.number().optional().default(2000).describe('Maximum number of lines to read'),
            tail: z.coerce.number().optional().describe('Read the last N lines (overrides offset/limit)'),
        },
        async ({ path: filePath, offset, limit, tail }) => {
            try {
                if (!fs.existsSync(filePath)) {
                    return error(`File not found: ${filePath}`);
                }
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    return error(`Path is a directory: ${filePath}`);
                }
                if (isBinaryFile(filePath)) {
                    return error(`Binary file, cannot display: ${filePath}`);
                }

                if (tail) {
                    const result = await readTail(filePath, tail);
                    return ok(result);
                }

                // Stream line by line — skip offset lines, take limit lines
                const result = await readLines(filePath, offset, limit);
                return ok(result.output + result.info);
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
                const lines = countNewlines(content) + 1;
                return ok(`Written ${lines} lines to ${filePath}`);
            } catch (err) {
                return error(err.message);
            }
        }
    );

    server.tool(
        'edit_file',
        'Edit a file by replacing an exact string with a new string. By default old_string must be unique. Use replace_all to replace all occurrences.',
        {
            path: z.string().describe('Absolute path to the file'),
            old_string: z.string().describe('Exact string to find and replace'),
            new_string: z.string().describe('Replacement string'),
            replace_all: z.boolean().optional().default(false).describe('Replace all occurrences (default: false, requires unique match)'),
        },
        async ({ path: filePath, old_string, new_string, replace_all }) => {
            try {
                if (!fs.existsSync(filePath)) {
                    return error(`File not found: ${filePath}`);
                }
                const content = fs.readFileSync(filePath, 'utf8');
                const firstIdx = content.indexOf(old_string);
                if (firstIdx === -1) {
                    return error('old_string not found in file.');
                }

                if (replace_all) {
                    // Replace all occurrences via indexOf loop (no regex overhead)
                    let newContent = '';
                    let lastEnd = 0;
                    let idx = firstIdx;
                    let count = 0;
                    while (idx !== -1) {
                        newContent += content.substring(lastEnd, idx) + new_string;
                        lastEnd = idx + old_string.length;
                        count++;
                        idx = content.indexOf(old_string, lastEnd);
                    }
                    newContent += content.substring(lastEnd);
                    fs.writeFileSync(filePath, newContent, 'utf8');
                    return ok(`Replaced ${count} occurrence${count > 1 ? 's' : ''} in ${filePath}`);
                }

                // Single replacement: must be unique
                const secondIdx = content.indexOf(old_string, firstIdx + 1);
                if (secondIdx !== -1) {
                    const count = countOccurrences(content, old_string);
                    return error(`old_string found ${count} times. It must be unique. Add more context or use replace_all.`);
                }
                const newContent = content.substring(0, firstIdx) +
                    new_string +
                    content.substring(firstIdx + old_string.length);
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
            glob: z.string().optional().describe('Glob pattern to filter files (e.g., "*.js", "*.ts")'),
            max_results: z.coerce.number().optional().default(50).describe('Maximum number of results'),
        },
        async ({ pattern, path: searchPath, glob: globPattern, max_results }) => {
            try {
                const regex = new RegExp(pattern, 'i');
                const basePath = searchPath || process.cwd();
                const results = [];

                if (fs.statSync(basePath).isFile()) {
                    await searchInFileStreaming(basePath, regex, results, max_results);
                } else {
                    await walkAndSearch(basePath, regex, results, max_results, globPattern);
                }

                if (results.length === 0) {
                    return ok('No matches found.');
                }
                const truncated = results.length >= max_results
                    ? `\n\n[Results limited to ${max_results}]` : '';
                return ok(results.join('\n') + truncated);
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
                findFilesRecursive(dir, pattern, results, 200);
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

// --- Response helpers ---

function ok(text) {
    return { content: [{ type: 'text', text }] };
}

function error(message) {
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

// --- Tail reader (ring buffer, single pass) ---

async function readTail(filePath, n) {
    return new Promise((resolve, reject) => {
        const stream = createReadStream(filePath, { encoding: 'utf8', flags: 'r' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });

        // Ring buffer: store last N lines with their line numbers
        const buf = new Array(n);
        let writeIdx = 0;
        let count = 0;
        let lineNum = 0;

        rl.on('line', (line) => {
            lineNum++;
            buf[writeIdx] = { num: lineNum, line };
            writeIdx = (writeIdx + 1) % n;
            if (count < n) count++;
        });

        rl.on('close', () => {
            const lines = [];
            const startIdx = count < n ? 0 : writeIdx;
            for (let i = 0; i < count; i++) {
                const entry = buf[(startIdx + i) % n];
                const display = entry.line.length > MAX_LINE_LENGTH
                    ? entry.line.substring(0, MAX_LINE_LENGTH) + '...'
                    : entry.line;
                lines.push(`${String(entry.num).padStart(4)}: ${display}`);
            }
            resolve(lines.join('\n'));
        });

        rl.on('error', reject);
    });
}

// --- Streaming file reader ---

async function readLines(filePath, offset, limit) {
    return new Promise((resolve, reject) => {
        const stream = createReadStream(filePath, {
            encoding: 'utf8',
            // Use shared read access (don't fail on locked files)
            flags: 'r',
        });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });

        const lines = [];
        let lineNum = 0;
        let totalLines = 0;

        rl.on('line', (line) => {
            totalLines++;
            if (lineNum >= offset && lines.length < limit) {
                const display = line.length > MAX_LINE_LENGTH
                    ? line.substring(0, MAX_LINE_LENGTH) + '...'
                    : line;
                lines.push(`${String(lineNum + 1).padStart(4)}: ${display}`);
            }
            lineNum++;
            if (lines.length >= limit) {
                // Keep counting total lines but don't store more
            }
        });

        rl.on('close', () => {
            const output = lines.join('\n');
            const info = totalLines > offset + limit
                ? `\n\n[Showing lines ${offset + 1}-${offset + lines.length} of ${totalLines}]`
                : '';
            resolve({ output, info });
        });

        rl.on('error', reject);
    });
}

// --- Streaming search ---

async function searchInFileStreaming(filePath, regex, results, maxResults) {
    if (isBinaryFile(filePath)) return;

    return new Promise((resolve) => {
        const stream = createReadStream(filePath, { encoding: 'utf8', flags: 'r' });
        const rl = createInterface({ input: stream, crlfDelay: Infinity });
        let lineNum = 0;

        rl.on('line', (line) => {
            lineNum++;
            if (results.length >= maxResults) {
                rl.close();
                stream.destroy();
                return;
            }
            if (regex.test(line)) {
                const display = line.length > MAX_LINE_LENGTH
                    ? line.substring(0, MAX_LINE_LENGTH) + '...'
                    : line;
                results.push(`${filePath}:${lineNum}: ${display}`);
            }
        });

        rl.on('close', resolve);
        rl.on('error', resolve); // Skip unreadable files
    });
}

async function walkAndSearch(dir, regex, results, maxResults, globPattern) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (results.length >= maxResults) return;

        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            await walkAndSearch(path.join(dir, entry.name), regex, results, maxResults, globPattern);
        } else if (entry.isFile()) {
            if (globPattern && !matchGlob(entry.name, globPattern)) continue;
            await searchInFileStreaming(path.join(dir, entry.name), regex, results, maxResults);
        }
    }
}

// --- File finder ---

function findFilesRecursive(dir, pattern, results, maxResults) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }

    for (const entry of entries) {
        if (results.length >= maxResults) return;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            findFilesRecursive(fullPath, pattern, results, maxResults);
        } else if (entry.isFile()) {
            if (matchGlob(entry.name, pattern) || matchGlob(fullPath, pattern)) {
                results.push(fullPath);
            }
        }
    }
}

// --- Binary detection (single-pass, first N bytes) ---

function isBinaryFile(filePath) {
    try {
        const fd = fs.openSync(filePath, 'r');
        const buf = Buffer.alloc(BINARY_CHECK_BYTES);
        const bytesRead = fs.readSync(fd, buf, 0, BINARY_CHECK_BYTES, 0);
        fs.closeSync(fd);

        // Check for null bytes (strong binary indicator)
        for (let i = 0; i < bytesRead; i++) {
            if (buf[i] === 0) return true;
        }
        return false;
    } catch {
        return false;
    }
}

// --- Utilities ---

function countNewlines(str) {
    let count = 0;
    let idx = -1;
    while ((idx = str.indexOf('\n', idx + 1)) !== -1) count++;
    return count;
}

function countOccurrences(str, substr) {
    let count = 0;
    let idx = -1;
    while ((idx = str.indexOf(substr, idx + 1)) !== -1) count++;
    return count;
}

/**
 * Glob matching (supports *, **, ?).
 * Compiled to regex once per call — no repeated compilation.
 */
function matchGlob(str, pattern) {
    const regex = globToRegex(pattern);
    return regex.test(str);
}

function globToRegex(pattern) {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '§§')
        .replace(/\*/g, '[^/\\\\]*')
        .replace(/§§/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`(^|[\\/\\\\])${escaped}$`, 'i');
}

const SKIP_DIRS = new Set([
    'node_modules', '.git', '.hg', '.svn', '__pycache__',
    'dist', 'build', '.next', '.nuxt', 'coverage',
    '.tox', '.venv', 'venv', '.mypy_cache', '.pytest_cache',
    'target', 'bin', 'obj',
]);
