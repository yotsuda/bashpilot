/**
 * Platform-aware socket/pipe path management for console discovery.
 *
 * Naming convention (filesystem marker files):
 *   /tmp/bashpilot.{proxyPid}.{agentId}.{consolePid}.sock  (Unix: actual socket)
 *   %TEMP%/bashpilot.{proxyPid}.{agentId}.{consolePid}.port (Windows: file containing TCP port)
 *
 * On Unix: consoles listen on Unix domain sockets.
 * On Windows: consoles listen on TCP localhost; a .port file stores the port number.
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PREFIX = 'bashpilot';
const IS_WINDOWS = process.platform === 'win32';

/**
 * Get the directory used for socket files / port marker files.
 */
export function getSocketDir() {
    return process.env.TMPDIR || tmpdir() || '/tmp';
}

/**
 * Generate a socket path (Unix) or port-file path (Windows) for an owned console.
 */
export function getSocketPath(proxyPid, agentId, consolePid) {
    const name = `${PREFIX}.${proxyPid}.${agentId}.${consolePid}`;
    const ext = IS_WINDOWS ? '.port' : '.sock';
    return join(getSocketDir(), name + ext);
}

/**
 * Generate a path for an unowned (user-started) console.
 */
export function getUnownedSocketPath(consolePid) {
    const name = `${PREFIX}.${consolePid}`;
    const ext = IS_WINDOWS ? '.port' : '.sock';
    return join(getSocketDir(), name + ext);
}

/**
 * Parse a socket/port-file path to extract metadata.
 */
export function parseSocketPath(pathOrName) {
    let name = pathOrName;
    const lastSlash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    if (lastSlash !== -1) name = name.substring(lastSlash + 1);
    // Remove extension
    if (name.endsWith('.sock') || name.endsWith('.port')) {
        name = name.slice(0, name.lastIndexOf('.'));
    }

    if (!name.startsWith(PREFIX + '.')) return null;

    const parts = name.substring(PREFIX.length + 1).split('.');

    if (parts.length === 3) {
        const proxyPid = parseInt(parts[0], 10);
        const agentId = parts[1];
        const consolePid = parseInt(parts[2], 10);
        if (isNaN(proxyPid) || isNaN(consolePid)) return null;
        return { proxyPid, agentId, consolePid, owned: true };
    }

    if (parts.length === 1) {
        const consolePid = parseInt(parts[0], 10);
        if (isNaN(consolePid)) return null;
        return { proxyPid: null, agentId: null, consolePid, owned: false };
    }

    return null;
}

/**
 * Enumerate socket/port files matching the given filter.
 */
export function enumerateSockets(proxyPid, agentId) {
    const dir = getSocketDir();
    const ext = IS_WINDOWS ? '.port' : '.sock';
    const results = [];

    let files;
    try {
        files = readdirSync(dir);
    } catch {
        return results;
    }

    const filterPrefix = buildFilterPrefix(proxyPid, agentId);

    for (const file of files) {
        if (!file.startsWith(PREFIX + '.')) continue;
        if (!file.endsWith(ext)) continue;
        if (filterPrefix && !file.startsWith(filterPrefix)) continue;
        results.push(join(dir, file));
    }

    return results;
}

/**
 * Enumerate unowned socket/port files (bashpilot.{pid}.sock only).
 */
export function enumerateUnownedSockets() {
    const dir = getSocketDir();
    const ext = IS_WINDOWS ? '.port' : '.sock';
    const results = [];

    let files;
    try {
        files = readdirSync(dir);
    } catch {
        return results;
    }

    for (const file of files) {
        if (!file.startsWith(PREFIX + '.')) continue;
        if (!file.endsWith(ext)) continue;
        const parsed = parseSocketPath(file);
        if (parsed && !parsed.owned) {
            results.push(join(dir, file));
        }
    }

    return results;
}

/**
 * Remove a stale socket/port file.
 */
export function cleanupSocket(socketPath) {
    try {
        unlinkSync(socketPath);
    } catch {
        // Already removed or doesn't exist
    }
}

/**
 * Write the TCP port number to a .port marker file (Windows only).
 */
export function writePortFile(filePath, port) {
    writeFileSync(filePath, String(port), 'utf8');
}

/**
 * Read the TCP port number from a .port marker file (Windows only).
 * Returns the port number, or null if file doesn't exist or is invalid.
 */
export function readPortFile(filePath) {
    try {
        const content = readFileSync(filePath, 'utf8').trim();
        const port = parseInt(content, 10);
        return isNaN(port) ? null : port;
    } catch {
        return null;
    }
}

/**
 * Whether the current platform uses TCP+port-files (Windows) or Unix domain sockets.
 */
export function usesTcp() {
    return IS_WINDOWS;
}

function buildFilterPrefix(proxyPid, agentId) {
    if (proxyPid == null) return null;
    let prefix = `${PREFIX}.${proxyPid}.`;
    if (agentId != null) {
        prefix += `${agentId}.`;
    }
    return prefix;
}
