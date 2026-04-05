import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CommandTracker } from '../src/command-tracker.js';

describe('CommandTracker', () => {
    describe('basic command flow', () => {
        it('resolves with output on promptStart after commandFinished', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('echo hello', 5000);

            // Simulate: echo, output, markers arrive in same chunk
            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 0 });
            tracker.handleEvent({ type: 'promptStart' });
            // Output arrives after markers (as observed in real PTY)
            tracker.feedOutput('echo hello\n');
            tracker.feedOutput('hello\n');
            tracker.feedOutput('user@host:~$ ');

            const result = await promise;
            assert.equal(result.output, 'hello');
            assert.equal(result.exitCode, 0);
        });

        it('captures exit code from commandFinished', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('false', 5000);

            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 1 });
            tracker.handleEvent({ type: 'promptStart' });
            tracker.feedOutput('false\n');
            tracker.feedOutput('user@host:~$ ');

            const result = await promise;
            assert.equal(result.exitCode, 1);
        });

        it('handles multi-line output', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('ls', 5000);

            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 0 });
            tracker.handleEvent({ type: 'promptStart' });
            tracker.feedOutput('ls\n');
            tracker.feedOutput('file1.txt\nfile2.txt\nfile3.txt\n');
            tracker.feedOutput('user@host:~$ ');

            const result = await promise;
            assert.equal(result.output, 'file1.txt\nfile2.txt\nfile3.txt');
        });
    });

    describe('command echo removal', () => {
        it('removes the echoed command from output', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('pwd', 5000);

            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 0 });
            tracker.handleEvent({ type: 'promptStart' });
            tracker.feedOutput('pwd\n/home/user\n');
            tracker.feedOutput('user@host:~$ ');

            const result = await promise;
            assert.equal(result.output, '/home/user');
        });
    });

    describe('prompt removal', () => {
        it('removes trailing prompt ending with $', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('echo hi', 5000);

            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 0 });
            tracker.handleEvent({ type: 'promptStart' });
            tracker.feedOutput('echo hi\nhi\n');
            tracker.feedOutput('user@host:/tmp$ ');

            const result = await promise;
            assert.equal(result.output, 'hi');
        });

        it('removes trailing prompt ending with #', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('whoami', 5000);

            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 0 });
            tracker.handleEvent({ type: 'promptStart' });
            tracker.feedOutput('whoami\nroot\n');
            tracker.feedOutput('root@host:~# ');

            const result = await promise;
            assert.equal(result.output, 'root');
        });
    });

    describe('ANSI stripping', () => {
        it('strips CSI sequences from output', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('ls --color', 5000);

            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 0 });
            tracker.handleEvent({ type: 'promptStart' });
            tracker.feedOutput('ls --color\n');
            tracker.feedOutput('\x1b[32mfile.txt\x1b[0m\n');
            tracker.feedOutput('user@host:~$ ');

            const result = await promise;
            assert.equal(result.output, 'file.txt');
        });

        it('strips bracketed paste mode sequences', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('echo test', 5000);

            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 0 });
            tracker.handleEvent({ type: 'promptStart' });
            tracker.feedOutput('\x1b[?2004lecho test\n');
            tracker.feedOutput('test\n');
            tracker.feedOutput('user@host:~$ ');

            const result = await promise;
            assert.equal(result.output, 'test');
        });
    });

    describe('edge cases', () => {
        it('rejects concurrent commands', async () => {
            const tracker = new CommandTracker();
            const first = tracker.registerCommand('cmd1', 5000);
            first.catch(() => {}); // suppress unhandled rejection on cleanup

            await assert.rejects(
                () => tracker.registerCommand('cmd2', 5000),
                /Another command is already executing/
            );

            tracker.cancel(); // cleanup
        });

        it('rejects on timeout', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('sleep 100', 100);

            await assert.rejects(() => promise, /timed out/);
        });

        it('rejects on cancel', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('cmd', 5000);

            tracker.cancel();

            await assert.rejects(() => promise, /cancelled/);
        });

        it('returns (empty) for command with no output', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('true', 5000);

            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 0 });
            tracker.handleEvent({ type: 'promptStart' });
            tracker.feedOutput('true\n');
            tracker.feedOutput('user@host:~$ ');

            const result = await promise;
            assert.equal(result.output, '');
        });

        it('truncates output exceeding 1MB', async () => {
            const tracker = new CommandTracker();
            const promise = tracker.registerCommand('big', 5000);

            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 0 });
            tracker.handleEvent({ type: 'promptStart' });
            tracker.feedOutput('big\n');
            // Feed >1MB of output
            const chunk = 'x'.repeat(100_000) + '\n';
            for (let i = 0; i < 12; i++) {
                tracker.feedOutput(chunk);
            }
            tracker.feedOutput('user@host:~$ ');

            const result = await promise;
            assert.ok(result.output.includes('[Output truncated at 1MB]'));
        });

        it('ignores events when no AI command is active', () => {
            const tracker = new CommandTracker();
            // Should not throw
            tracker.handleEvent({ type: 'commandExecuted' });
            tracker.handleEvent({ type: 'commandFinished', exitCode: 0 });
            tracker.handleEvent({ type: 'promptStart' });
            tracker.feedOutput('user typed something\n');
        });
    });
});
