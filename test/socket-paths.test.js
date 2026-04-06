import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getSocketPath, getUnownedSocketPath, parseSocketPath, enumerateSockets } from '../src/socket-paths.js';

describe('socket-paths', () => {
    describe('getSocketPath', () => {
        it('generates owned socket path', () => {
            const path = getSocketPath(1234, 'default', 5678);
            assert.ok(path.includes('bashpilot.1234.default.5678'));
        });

        it('includes .sock extension on Unix', () => {
            if (process.platform !== 'win32') {
                const path = getSocketPath(1, 'a', 2);
                assert.ok(path.endsWith('.sock'));
            }
        });
    });

    describe('getUnownedSocketPath', () => {
        it('generates unowned socket path', () => {
            const path = getUnownedSocketPath(9999);
            assert.ok(path.includes('bashpilot.9999'));
            assert.ok(!path.includes('default'));
        });
    });

    describe('parseSocketPath', () => {
        it('parses owned socket path', () => {
            const result = parseSocketPath('bashpilot.1234.default.5678.sock');
            assert.deepEqual(result, {
                proxyPid: 1234,
                agentId: 'default',
                consolePid: 5678,
                owned: true
            });
        });

        it('parses owned path with directory prefix', () => {
            const result = parseSocketPath('/tmp/bashpilot.1234.myagent.5678.sock');
            assert.deepEqual(result, {
                proxyPid: 1234,
                agentId: 'myagent',
                consolePid: 5678,
                owned: true
            });
        });

        it('parses unowned socket path', () => {
            const result = parseSocketPath('bashpilot.9999.sock');
            assert.deepEqual(result, {
                proxyPid: null,
                agentId: null,
                consolePid: 9999,
                owned: false
            });
        });

        it('returns null for non-bashpilot paths', () => {
            assert.equal(parseSocketPath('other.1234.sock'), null);
        });

        it('returns null for malformed paths', () => {
            assert.equal(parseSocketPath('bashpilot.abc.sock'), null);
        });

        it('round-trips with getSocketPath', () => {
            const path = getSocketPath(111, 'test', 222);
            const parsed = parseSocketPath(path);
            assert.equal(parsed.proxyPid, 111);
            assert.equal(parsed.agentId, 'test');
            assert.equal(parsed.consolePid, 222);
            assert.equal(parsed.owned, true);
        });

        it('round-trips with getUnownedSocketPath', () => {
            const path = getUnownedSocketPath(333);
            const parsed = parseSocketPath(path);
            assert.equal(parsed.consolePid, 333);
            assert.equal(parsed.owned, false);
        });
    });

    describe('enumerateSockets', () => {
        it('returns array (may be empty)', () => {
            const result = enumerateSockets(99999);
            assert.ok(Array.isArray(result));
        });
    });
});
