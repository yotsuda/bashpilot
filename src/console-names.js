/**
 * Display name generator for console windows.
 * Assigns memorable names like "#12345 Falcon".
 */

const NAMES = [
    'Falcon', 'Sparrow', 'Eagle', 'Hawk', 'Raven',
    'Phoenix', 'Condor', 'Osprey', 'Merlin', 'Wren',
    'Lark', 'Swift', 'Crane', 'Heron', 'Finch',
    'Robin', 'Dove', 'Owl', 'Jay', 'Kite',
    'Atlas', 'Nova', 'Vega', 'Orion', 'Zenith',
    'Apex', 'Pulse', 'Flux', 'Arc', 'Bolt',
    'Iron', 'Zinc', 'Neon', 'Cobalt', 'Amber',
    'Jade', 'Onyx', 'Opal', 'Ruby', 'Pearl',
];

let _index = 0;

// Shuffle on first use
let _shuffled = false;
function ensureShuffled() {
    if (_shuffled) return;
    for (let i = NAMES.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [NAMES[i], NAMES[j]] = [NAMES[j], NAMES[i]];
    }
    _shuffled = true;
}

/**
 * Generate a display name for a console with the given PID.
 * Returns something like "#12345 Falcon".
 */
export function generateDisplayName(pid) {
    ensureShuffled();
    const name = NAMES[_index % NAMES.length];
    _index++;
    return `#${pid} ${name}`;
}
