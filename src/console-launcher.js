/**
 * Platform-specific console launcher.
 * Opens a visible terminal window running bashpilot in console mode.
 */

import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENTRY = join(__dirname, 'index.js');

/**
 * Launch a visible terminal window running bashpilot --console.
 * Returns the child process (detached).
 */
export function launchConsole(proxyPid, agentId, options = {}) {
    const nodeCmd = process.execPath;
    const args = [ENTRY, '--console', '--proxy-pid', String(proxyPid), '--agent-id', agentId];
    if (options.shell) args.push('--shell', options.shell);
    if (options.cwd) args.push('--cwd', options.cwd);
    if (options.title) args.push('--title', options.title);

    const platform = process.platform;
    const cwd = options.cwd;
    const title = options.title || 'bashpilot';

    if (platform === 'win32') {
        return launchWindows(nodeCmd, args, cwd, title);
    } else if (platform === 'darwin') {
        return launchMacOS(nodeCmd, args, cwd);
    } else {
        return launchLinux(nodeCmd, args, cwd);
    }
}

function launchWindows(nodeCmd, args, cwd, title) {

    if (hasCommand('wt.exe')) {
        return spawn('wt.exe', ['--title', title, '--', nodeCmd, ...args], {
            detached: true,
            stdio: 'ignore',
            cwd: cwd || undefined,
        });
    }

    return spawn('cmd', ['/c', 'start', title, '/wait', nodeCmd, ...args], {
        detached: true,
        stdio: 'ignore',
        cwd: cwd || undefined,
    });
}

function launchMacOS(nodeCmd, args, cwd) {
    const cmdline = [nodeCmd, ...args].map(a => `\\"${a}\\"`).join(' ');
    const script = `tell application "Terminal" to do script "${cmdline}"`;
    return spawn('osascript', ['-e', script], {
        detached: true,
        stdio: 'ignore',
    });
}

function launchLinux(nodeCmd, args, cwd) {
    const terminals = [
        { cmd: 'x-terminal-emulator', prefix: ['-e'] },
        { cmd: 'gnome-terminal', prefix: ['--'] },
        { cmd: 'konsole', prefix: ['-e'] },
        { cmd: 'xfce4-terminal', prefix: ['-e'] },
        { cmd: 'xterm', prefix: ['-e'] },
    ];

    for (const term of terminals) {
        if (hasCommand(term.cmd)) {
            const child = spawn(term.cmd, [...term.prefix, nodeCmd, ...args], {
                detached: true,
                stdio: 'ignore',
                cwd: cwd || undefined,
            });
            child.unref();
            return child;
        }
    }

    throw new Error('No terminal emulator found. Tried: ' + terminals.map(t => t.cmd).join(', '));
}

function hasCommand(cmd) {
    try {
        const where = process.platform === 'win32' ? 'where' : 'which';
        execSync(`${where} ${cmd}`, { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}
