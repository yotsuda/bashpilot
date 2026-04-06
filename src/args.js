/**
 * Parse command-line arguments.
 */
export function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        console: false,
        proxyPid: null,
        agentId: null,
        shell: null,
        cwd: null,
        // Legacy (kept for backward compatibility during transition)
        socket: null,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--console':
                options.console = true;
                break;
            case '--proxy-pid':
                options.proxyPid = parseInt(args[++i], 10);
                break;
            case '--agent-id':
                options.agentId = args[++i];
                break;
            case '--socket':
                options.socket = args[++i];
                break;
            case '--shell':
                options.shell = args[++i];
                break;
            case '--cwd':
                options.cwd = args[++i];
                break;
        }
    }

    return options;
}
