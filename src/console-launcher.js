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
export function launchConsole(socketPath, options = {}) {
    const nodeCmd = process.execPath;
    const args = [ENTRY, '--console', '--socket', socketPath];
    if (options.shell) args.push('--shell', options.shell);
    if (options.cwd) args.push('--cwd', options.cwd);

    const platform = process.platform;

    if (platform === 'win32') {
        return launchWindows(nodeCmd, args, options.cwd);
    } else if (platform === 'darwin') {
        return launchMacOS(nodeCmd, args, options.cwd);
    } else {
        return launchLinux(nodeCmd, args, options.cwd);
    }
}

function launchWindows(nodeCmd, args, cwd) {
    // Use Windows Terminal (wt.exe) if available, otherwise conhost
    const cmdline = [nodeCmd, ...args].map(a => `"${a}"`).join(' ');

    if (hasCommand('wt.exe')) {
        return spawn('wt.exe', ['--title', 'bashpilot', '--', 'cmd', '/c', cmdline], {
            detached: true,
            stdio: 'ignore',
            cwd: cwd || undefined,
        });
    }

    // Fallback: start with conhost
    return spawn('cmd', ['/c', 'start', 'bashpilot', '/wait', 'cmd', '/k', cmdline], {
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
