import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { registerFileTools } from '../src/file-tools.js';

// Mock MCP server that captures tool registrations
class MockServer {
    constructor() {
        this._tools = {};
    }
    tool(name, description, schema, handler) {
        this._tools[name] = handler;
    }
    async call(name, params) {
        return this._tools[name](params);
    }
}

let server;
let tmpDir;

function tmpFile(name, content) {
    const filePath = path.join(tmpDir, name);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (content !== undefined) fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

describe('file-tools', () => {
    beforeEach(() => {
        server = new MockServer();
        registerFileTools(server);
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bashpilot-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('read_file', () => {
        it('reads file with line numbers', async () => {
            const f = tmpFile('test.txt', 'line1\nline2\nline3\n');
            const result = await server.call('read_file', { path: f, offset: 0, limit: 2000 });
            assert.ok(!result.isError, `Unexpected error: ${result.content[0].text}`);
            const text = result.content[0].text;
            assert.ok(/\d+:.*line1/.test(text), `Expected line1 in: ${text.substring(0, 200)}`);
        });

        it('supports offset', async () => {
            const f = tmpFile('test.txt', 'a\nb\nc\nd\ne\n');
            const result = await server.call('read_file', { path: f, offset: 2, limit: 2 });
            const text = result.content[0].text;
            assert.ok(text.includes('3: c'));
            assert.ok(text.includes('4: d'));
            assert.ok(!text.includes('1: a'));
            assert.ok(!text.includes('5: e'));
        });

        it('supports limit', async () => {
            const lines = Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n');
            const f = tmpFile('big.txt', lines);
            const result = await server.call('read_file', { path: f, offset: 0, limit: 5 });
            const text = result.content[0].text;
            assert.ok(text.includes('1: line1'));
            assert.ok(text.includes('5: line5'));
            assert.ok(!text.includes('6: line6'));
            assert.ok(text.includes('[Showing lines 1-5 of 100]'));
        });

        it('returns error for missing file', async () => {
            const result = await server.call('read_file', { path: '/nonexistent/file.txt' });
            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('not found'));
        });

        it('returns error for directory', async () => {
            const result = await server.call('read_file', { path: tmpDir });
            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('directory'));
        });

        it('detects binary file', async () => {
            const f = tmpFile('binary.bin');
            fs.writeFileSync(f, Buffer.from([0x48, 0x65, 0x6c, 0x00, 0x6f]));
            const result = await server.call('read_file', { path: f });
            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('Binary'));
        });
    });

    describe('write_file', () => {
        it('creates a new file', async () => {
            const f = path.join(tmpDir, 'new.txt');
            const result = await server.call('write_file', { path: f, content: 'hello\nworld' });
            assert.ok(!result.isError);
            assert.ok(result.content[0].text.includes('2 lines'));
            assert.equal(fs.readFileSync(f, 'utf8'), 'hello\nworld');
        });

        it('overwrites existing file', async () => {
            const f = tmpFile('existing.txt', 'old content');
            await server.call('write_file', { path: f, content: 'new content' });
            assert.equal(fs.readFileSync(f, 'utf8'), 'new content');
        });

        it('creates parent directories', async () => {
            const f = path.join(tmpDir, 'a', 'b', 'c', 'deep.txt');
            await server.call('write_file', { path: f, content: 'deep' });
            assert.equal(fs.readFileSync(f, 'utf8'), 'deep');
        });
    });

    describe('edit_file', () => {
        it('replaces unique string', async () => {
            const f = tmpFile('edit.txt', 'hello world\nfoo bar\n');
            const result = await server.call('edit_file', {
                path: f,
                old_string: 'foo bar',
                new_string: 'baz qux',
            });
            assert.ok(!result.isError);
            assert.equal(fs.readFileSync(f, 'utf8'), 'hello world\nbaz qux\n');
        });

        it('returns error if string not found', async () => {
            const f = tmpFile('edit.txt', 'hello world\n');
            const result = await server.call('edit_file', {
                path: f,
                old_string: 'not here',
                new_string: 'replacement',
            });
            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('not found'));
        });

        it('returns error if string not unique', async () => {
            const f = tmpFile('edit.txt', 'foo\nbar\nfoo\n');
            const result = await server.call('edit_file', {
                path: f,
                old_string: 'foo',
                new_string: 'baz',
            });
            assert.ok(result.isError);
            assert.ok(result.content[0].text.includes('2 times'));
        });

        it('handles multi-line replacement', async () => {
            const f = tmpFile('edit.txt', 'line1\nline2\nline3\n');
            await server.call('edit_file', {
                path: f,
                old_string: 'line1\nline2',
                new_string: 'replaced1\nreplaced2',
            });
            assert.equal(fs.readFileSync(f, 'utf8'), 'replaced1\nreplaced2\nline3\n');
        });

        it('returns error for missing file', async () => {
            const result = await server.call('edit_file', {
                path: '/nonexistent.txt',
                old_string: 'a',
                new_string: 'b',
            });
            assert.ok(result.isError);
        });
    });

    describe('search_files', () => {
        it('finds matching lines in a file', async () => {
            const f = tmpFile('search.txt', 'apple\nbanana\napricot\ncherry\n');
            const result = await server.call('search_files', {
                pattern: 'ap',
                path: f,
            });
            const text = result.content[0].text;
            assert.ok(text.includes(':1: apple'));
            assert.ok(text.includes(':3: apricot'));
            assert.ok(!text.includes('banana'));
        });

        it('searches directory recursively', async () => {
            tmpFile('dir1/a.txt', 'match here\n');
            tmpFile('dir2/b.txt', 'no hit\n');
            tmpFile('dir2/c.txt', 'match again\n');
            const result = await server.call('search_files', {
                pattern: 'match',
                path: tmpDir,
            });
            const text = result.content[0].text;
            assert.ok(text.includes('a.txt:1: match here'));
            assert.ok(text.includes('c.txt:1: match again'));
            assert.ok(!text.includes('b.txt'));
        });

        it('respects glob filter', async () => {
            tmpFile('code.js', 'function hello() {}\n');
            tmpFile('code.py', 'def hello():\n');
            const result = await server.call('search_files', {
                pattern: 'hello',
                path: tmpDir,
                glob: '*.js',
            });
            const text = result.content[0].text;
            assert.ok(text.includes('code.js'));
            assert.ok(!text.includes('code.py'));
        });

        it('respects max_results', async () => {
            const lines = Array.from({ length: 100 }, (_, i) => `match${i}`).join('\n');
            tmpFile('many.txt', lines);
            const result = await server.call('search_files', {
                pattern: 'match',
                path: tmpDir,
                max_results: 5,
            });
            const text = result.content[0].text;
            const matches = text.split('\n').filter(l => l.includes('match'));
            assert.ok(matches.length <= 5);
            assert.ok(text.includes('[Results limited to 5]'));
        });

        it('skips binary files', async () => {
            tmpFile('text.txt', 'findme\n');
            const binPath = tmpFile('binary.bin');
            fs.writeFileSync(binPath, Buffer.concat([
                Buffer.from('findme\n'),
                Buffer.from([0x00, 0x00]),
            ]));
            const result = await server.call('search_files', {
                pattern: 'findme',
                path: tmpDir,
            });
            const text = result.content[0].text;
            assert.ok(text.includes('text.txt'));
            assert.ok(!text.includes('binary.bin'));
        });

        it('returns no matches message', async () => {
            tmpFile('empty.txt', 'nothing here\n');
            const result = await server.call('search_files', {
                pattern: 'zzzzz',
                path: tmpDir,
            });
            assert.ok(result.content[0].text.includes('No matches'));
        });
    });

    describe('find_files', () => {
        it('finds files by extension', async () => {
            tmpFile('a.js', '');
            tmpFile('b.ts', '');
            tmpFile('c.js', '');
            const result = await server.call('find_files', {
                pattern: '*.js',
                path: tmpDir,
            });
            const text = result.content[0].text;
            assert.ok(text.includes('a.js'));
            assert.ok(text.includes('c.js'));
            assert.ok(!text.includes('b.ts'));
        });

        it('finds files recursively', async () => {
            tmpFile('src/index.js', '');
            tmpFile('src/lib/util.js', '');
            tmpFile('readme.md', '');
            const result = await server.call('find_files', {
                pattern: '*.js',
                path: tmpDir,
            });
            const text = result.content[0].text;
            assert.ok(text.includes('index.js'));
            assert.ok(text.includes('util.js'));
            assert.ok(!text.includes('readme.md'));
        });

        it('skips node_modules', async () => {
            tmpFile('src/app.js', '');
            tmpFile('node_modules/pkg/index.js', '');
            const result = await server.call('find_files', {
                pattern: '*.js',
                path: tmpDir,
            });
            const text = result.content[0].text;
            assert.ok(text.includes('app.js'));
            assert.ok(!text.includes('node_modules'));
        });

        it('returns no files message', async () => {
            const result = await server.call('find_files', {
                pattern: '*.xyz',
                path: tmpDir,
            });
            assert.ok(result.content[0].text.includes('No files'));
        });
    });
});
