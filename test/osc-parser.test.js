import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OscParser } from '../src/osc-parser.js';

describe('OscParser', () => {
    it('extracts promptStart event', () => {
        const parser = new OscParser();
        const { cleaned, events } = parser.parse('\x1b]633;A\x07');
        assert.equal(cleaned, '');
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'promptStart');
    });

    it('extracts commandExecuted event', () => {
        const parser = new OscParser();
        const { events } = parser.parse('\x1b]633;C\x07');
        assert.equal(events[0].type, 'commandExecuted');
    });

    it('extracts commandFinished with exit code', () => {
        const parser = new OscParser();
        const { events } = parser.parse('\x1b]633;D;0\x07');
        assert.equal(events[0].type, 'commandFinished');
        assert.equal(events[0].exitCode, 0);
    });

    it('extracts commandFinished with non-zero exit code', () => {
        const parser = new OscParser();
        const { events } = parser.parse('\x1b]633;D;127\x07');
        assert.equal(events[0].exitCode, 127);
    });

    it('extracts commandInputStart event', () => {
        const parser = new OscParser();
        const { events } = parser.parse('\x1b]633;B\x07');
        assert.equal(events[0].type, 'commandInputStart');
    });

    it('strips OSC sequences and returns cleaned text', () => {
        const parser = new OscParser();
        const { cleaned, events } = parser.parse('hello\x1b]633;A\x07world');
        assert.equal(cleaned, 'helloworld');
        assert.equal(events.length, 1);
    });

    it('handles multiple events in one chunk', () => {
        const parser = new OscParser();
        const { cleaned, events } = parser.parse(
            '\x1b]633;C\x07output\x1b]633;D;0\x07\x1b]633;A\x07'
        );
        assert.equal(cleaned, 'output');
        assert.equal(events.length, 3);
        assert.equal(events[0].type, 'commandExecuted');
        assert.equal(events[1].type, 'commandFinished');
        assert.equal(events[2].type, 'promptStart');
    });

    it('handles OSC sequence split across chunks', () => {
        const parser = new OscParser();

        const r1 = parser.parse('text\x1b]633');
        assert.equal(r1.cleaned, 'text');
        assert.equal(r1.events.length, 0);

        const r2 = parser.parse(';A\x07more');
        assert.equal(r2.cleaned, 'more');
        assert.equal(r2.events.length, 1);
        assert.equal(r2.events[0].type, 'promptStart');
    });

    it('handles ST terminator (\\x1b\\\\)', () => {
        const parser = new OscParser();
        const { events } = parser.parse('\x1b]633;D;1\x1b\\');
        assert.equal(events.length, 1);
        assert.equal(events[0].type, 'commandFinished');
        assert.equal(events[0].exitCode, 1);
    });

    it('passes through text with no OSC sequences', () => {
        const parser = new OscParser();
        const { cleaned, events } = parser.parse('just normal text\n');
        assert.equal(cleaned, 'just normal text\n');
        assert.equal(events.length, 0);
    });

    it('ignores unknown OSC 633 codes', () => {
        const parser = new OscParser();
        const { events } = parser.parse('\x1b]633;Z;unknown\x07');
        assert.equal(events.length, 0);
    });
});
