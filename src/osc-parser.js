/**
 * OSC 633 parser - extracts shell integration sequences from PTY output stream.
 *
 * Sequences: \x1b]633;{code}[;{data}]\x07
 *   A = PromptStart
 *   B = CommandInputStart
 *   C = CommandExecuted
 *   D;{exitCode} = CommandFinished
 */

const OSC_START = '\x1b]633;';
const OSC_END_BEL = '\x07';
const OSC_END_ST = '\x1b\\';

export class OscParser {
    constructor() {
        this._buffer = '';
    }

    /**
     * Parse a chunk of PTY output.
     * Returns { cleaned, events } where:
     *   cleaned = output with OSC 633 sequences stripped
     *   events = array of { type, data } objects
     */
    parse(chunk) {
        const events = [];
        let cleaned = '';
        let input = this._buffer + chunk;
        this._buffer = '';

        let i = 0;
        while (i < input.length) {
            const oscIdx = input.indexOf(OSC_START, i);

            if (oscIdx === -1) {
                // No more OSC sequences - check if trailing chars could be start of one
                const escIdx = input.indexOf('\x1b', i);
                if (escIdx !== -1 && escIdx >= input.length - OSC_START.length) {
                    // Possible incomplete OSC at end - buffer it
                    cleaned += input.substring(i, escIdx);
                    this._buffer = input.substring(escIdx);
                    return { cleaned, events };
                }
                cleaned += input.substring(i);
                break;
            }

            // Add text before the OSC sequence
            cleaned += input.substring(i, oscIdx);

            // Find end of OSC sequence
            const searchFrom = oscIdx + OSC_START.length;
            const belIdx = input.indexOf(OSC_END_BEL, searchFrom);
            const stIdx = input.indexOf(OSC_END_ST, searchFrom);

            let endIdx = -1;
            let endLen = 0;
            if (belIdx !== -1 && (stIdx === -1 || belIdx <= stIdx)) {
                endIdx = belIdx;
                endLen = OSC_END_BEL.length;
            } else if (stIdx !== -1) {
                endIdx = stIdx;
                endLen = OSC_END_ST.length;
            }

            if (endIdx === -1) {
                // Incomplete sequence - buffer everything from OSC start
                this._buffer = input.substring(oscIdx);
                return { cleaned, events };
            }

            // Extract the payload between OSC_START and end marker
            const payload = input.substring(searchFrom, endIdx);
            const event = this._parsePayload(payload);
            if (event) {
                events.push(event);
            }

            i = endIdx + endLen;
        }

        return { cleaned, events };
    }

    _parsePayload(payload) {
        if (!payload) return null;

        const code = payload[0];
        const data = payload.length > 2 && payload[1] === ';' ? payload.substring(2) : undefined;

        switch (code) {
            case 'A': return { type: 'promptStart' };
            case 'B': return { type: 'commandInputStart' };
            case 'C': return { type: 'commandExecuted' };
            case 'D': return { type: 'commandFinished', exitCode: data ? parseInt(data, 10) : 0 };
            case 'P': {
                // Property: P;Key=Value
                if (data && data.startsWith('Cwd=')) {
                    return { type: 'cwd', cwd: data.substring(4) };
                }
                return null;
            }
            default: return null;
        }
    }
}
