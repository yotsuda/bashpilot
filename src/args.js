/**
 * Parse command-line arguments.
 */
export function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        console: false,
        socket: null,
        shell: null,
        cwd: null,
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--console':
                options.console = true;
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
