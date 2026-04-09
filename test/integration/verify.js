#!/usr/bin/env node

/**
 * Verify integration test output from bashpilot MCP server.
 * Reads JSON-RPC responses from stdin or a file and checks expectations.
 *
 * Usage: node verify.js < output.jsonl
 *    or: node verify.js output.jsonl
 */

import { readFileSync } from 'fs';

const input = process.argv[2]
    ? readFileSync(process.argv[2], 'utf8')
    : readFileSync('/dev/stdin', 'utf8');

const lines = input.trim().split('\n').filter(l => l.trim());
const responses = new Map();

for (const line of lines) {
    try {
        const msg = JSON.parse(line);
        if (msg.id != null) {
            responses.set(msg.id, msg);
        }
    } catch {
        // skip non-JSON lines
    }
}

let passed = 0;
let failed = 0;

function check(id, description, predicate) {
    const resp = responses.get(id);
    if (!resp) {
        console.log(`FAIL [id:${id}] ${description} — no response found`);
        failed++;
        return;
    }
    try {
        if (predicate(resp)) {
            console.log(`PASS [id:${id}] ${description}`);
            passed++;
        } else {
            console.log(`FAIL [id:${id}] ${description}`);
            console.log(`     response: ${JSON.stringify(resp).slice(0, 200)}`);
            failed++;
        }
    } catch (e) {
        console.log(`FAIL [id:${id}] ${description} — ${e.message}`);
        failed++;
    }
}

function getText(resp) {
    return resp?.result?.content?.[0]?.text || '';
}

function getExitCode(resp) {
    return resp?.result?.metadata?.exitCode;
}

// id:1 — initialize
check(1, 'initialize returns server info', r =>
    r.result?.serverInfo?.name === 'bash' &&
    r.result?.protocolVersion === '2024-11-05');

// id:2 — tools/list
check(2, 'tools/list returns tools', r =>
    Array.isArray(r.result?.tools) &&
    r.result.tools.some(t => t.name === 'start_console') &&
    r.result.tools.some(t => t.name === 'execute_command') &&
    r.result.tools.some(t => t.name === 'read_file'));

// id:3 — start_console
check(3, 'start_console opens a console', r =>
    getText(r).includes('Console #') && getText(r).includes('opened'));

// id:4 — echo
check(4, 'execute_command echo', r =>
    getText(r).includes('HELLO_BASHPILOT') &&
    getText(r).includes('Completed') &&
    getExitCode(r) === 0);

// id:5 — for loop
check(5, 'execute_command for loop', r =>
    getText(r).includes('count_1') &&
    getText(r).includes('count_2') &&
    getText(r).includes('count_3') &&
    getExitCode(r) === 0);

// id:6 — env set
check(6, 'execute_command env set', r =>
    getText(r).includes('integration') &&
    getExitCode(r) === 0);

// id:7 — env persist
check(7, 'execute_command env persists across calls', r =>
    getText(r).includes('integration') &&
    getExitCode(r) === 0);

// id:8 — exit code non-zero
check(8, 'execute_command captures non-zero exit code', r =>
    getExitCode(r) !== 0 &&
    getText(r).includes('Failed'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
