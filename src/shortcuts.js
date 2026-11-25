const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
const MODIFIER_ALIAS = {
    ctrl: 'Ctrl', control: 'Ctrl',
    alt: 'Alt', option: 'Alt',
    shift: 'Shift',
    meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', super: 'Meta'
};
const MODIFIER_ONLY_KEYS = new Set(['Ctrl', 'Alt', 'Shift']);

const SPECIAL_CODES = {
    Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Minus: 'Minus', Equal: 'Equal', BracketLeft: 'BracketLeft', BracketRight: 'BracketRight',
    Backslash: 'Backslash', Semicolon: 'Semicolon', Quote: 'Quote', Backquote: 'Backquote',
    Comma: 'Comma', Period: 'Period', Slash: 'Slash'
};

const SPECIAL_KEYS = {
    ' ': 'Space', spacebar: 'Space', space: 'Space', enter: 'Enter', tab: 'Tab',
    backspace: 'Backspace', delete: 'Delete', del: 'Delete',
    home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown',
    arrowup: 'ArrowUp', up: 'ArrowUp', arrowdown: 'ArrowDown', down: 'ArrowDown',
    arrowleft: 'ArrowLeft', left: 'ArrowLeft', arrowright: 'ArrowRight', right: 'ArrowRight',
    '-': 'Minus', minus: 'Minus', '=': 'Equal', equal: 'Equal',
    '[': 'BracketLeft', bracketleft: 'BracketLeft', ']': 'BracketRight', bracketright: 'BracketRight',
    '\\': 'Backslash', backslash: 'Backslash', ';': 'Semicolon', semicolon: 'Semicolon',
    "'": 'Quote', quote: 'Quote', '`': 'Backquote', backquote: 'Backquote',
    ',': 'Comma', comma: 'Comma', '.': 'Period', period: 'Period', '/': 'Slash', slash: 'Slash'
};

const DISPLAY_KEYS = {
    Space: '空格',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/'
};

export const SHORTCUT_ACTIONS = Object.freeze([
    { id: 'capture', label: '收藏此句', scope: 'global', allowModifierOnly: false },
    { id: 'notebook', label: '开关复习本', scope: 'global', allowModifierOnly: false },
    { id: 'toggleMask', label: '开关遮罩', scope: 'global', allowModifierOnly: false },
    { id: 'editMask', label: '遮罩编辑', scope: 'global', allowModifierOnly: false },
    { id: 'peek', label: '按住临时查看中文', scope: 'global', allowModifierOnly: true },
    { id: 'reveal', label: '复习时显示答案', scope: 'session', allowModifierOnly: false },
    { id: 'rateAgain', label: '复习自评：没听懂', scope: 'session', allowModifierOnly: false },
    { id: 'rateHard', label: '复习自评：费劲', scope: 'session', allowModifierOnly: false },
    { id: 'rateGood', label: '复习自评：听懂了', scope: 'session', allowModifierOnly: false }
]);

export const DEFAULT_SHORTCUTS = Object.freeze({
    capture: 'Alt+S',
    notebook: 'Alt+B',
    toggleMask: 'Alt+C',
    editMask: 'Alt+Z',
    peek: 'Alt',
    reveal: 'Space',
    rateAgain: '1',
    rateHard: '2',
    rateGood: '3'
});

function normalizeMainKey(token) {
    if (typeof token !== 'string') return null;
    if (token === ' ') return 'Space';
    const trimmed = token.trim();
    if (!trimmed) return null;
    if (/^[a-zA-Z]$/.test(trimmed)) return trimmed.toUpperCase();
    if (/^[0-9]$/.test(trimmed)) return trimmed;
    if (/^F([1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
    return SPECIAL_KEYS[trimmed.toLowerCase()] || null;
}

/**
 * Normalize a shortcut string into canonical form (e.g. "Ctrl+Shift+S", "Space", "Alt", or "" for disabled).
 * Returns null if the input is invalid.
 */
export function normalizeShortcut(value, { allowModifierOnly = false } = {}) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw) return '';
    if (raw.length > 64) return null;
    // Allow literal "+" only if not used as delimiter; split on "+" with optional spaces.
    const parts = raw.split(/\s*\+\s*/);
    if (parts.some(part => !part)) return null;
    if (parts.length === 1) {
        const mod = MODIFIER_ALIAS[parts[0].toLowerCase()];
        if (mod) return allowModifierOnly && MODIFIER_ONLY_KEYS.has(mod) ? mod : null;
        return normalizeMainKey(parts[0]);
    }
    const mods = new Set();
    for (let i = 0; i < parts.length - 1; i++) {
        const mod = MODIFIER_ALIAS[parts[i].toLowerCase()];
        if (!mod || mods.has(mod)) return null;
        mods.add(mod);
    }
    const key = normalizeMainKey(parts[parts.length - 1]);
    if (!key) return null;
    const ordered = MODIFIER_ORDER.filter(mod => mods.has(mod));
    return [...ordered, key].join('+');
}

export function normalizeShortcutsMap(input) {
    const output = { ...DEFAULT_SHORTCUTS };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return output;
    for (const action of SHORTCUT_ACTIONS) {
        if (!Object.hasOwn(input, action.id)) continue;
        const normalized = normalizeShortcut(input[action.id], { allowModifierOnly: action.allowModifierOnly });
        if (normalized !== null) output[action.id] = normalized;
    }
    return output;
}

function keyTokenFromEvent(event) {
    const code = typeof event?.code === 'string' ? event.code : '';
    if (/^Key([A-Z])$/.test(code)) return code.slice(3);
    if (/^(?:Digit|Numpad)([0-9])$/.test(code)) return code.slice(-1);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    if (SPECIAL_CODES[code]) return SPECIAL_CODES[code];
    const key = typeof event?.key === 'string' ? event.key : '';
    if (!key) return null;
    const mod = MODIFIER_ALIAS[key.toLowerCase()];
    if (mod) return mod;
    return normalizeMainKey(key);
}

/** Convert a KeyboardEvent into a canonical shortcut string, or null if unsupported/incomplete. */
export function eventToShortcut(event, { allowModifierOnly = false } = {}) {
    if (!event) return null;
    const token = keyTokenFromEvent(event);
    if (!token) return null;
    if (MODIFIER_ORDER.includes(token)) {
        if (!allowModifierOnly || !MODIFIER_ONLY_KEYS.has(token)) return null;
        const otherMods =
            (token !== 'Ctrl' && Boolean(event.ctrlKey)) ||
            (token !== 'Alt' && Boolean(event.altKey)) ||
            (token !== 'Shift' && Boolean(event.shiftKey)) ||
            Boolean(event.metaKey);
        return otherMods ? null : token;
    }
    const mods = [];
    if (event.ctrlKey) mods.push('Ctrl');
    if (event.altKey) mods.push('Alt');
    if (event.shiftKey) mods.push('Shift');
    if (event.metaKey) mods.push('Meta');
    return mods.length ? `${mods.join('+')}+${token}` : token;
}

/** Check whether a keydown event matches a canonical shortcut binding. */
export function matchesShortcut(event, spec, { allowModifierOnly = false } = {}) {
    if (!spec) return false;
    const actual = eventToShortcut(event, { allowModifierOnly });
    return actual !== null && actual === spec;
}

/** Check whether a keyup event releases the key bound to hold-to-peek. */
export function matchesPeekRelease(event, spec) {
    if (!spec) return false;
    const token = keyTokenFromEvent(event);
    if (!token) return false;
    if (MODIFIER_ONLY_KEYS.has(spec)) return token === spec;
    const parts = spec.split('+');
    return parts.includes(token);
}

/** Format a canonical shortcut string for display in Chinese UI. */
export function formatShortcut(spec) {
    if (!spec) return '已禁用';
    return spec.split('+').map(part => DISPLAY_KEYS[part] || part).join(' + ');
}

/** Find duplicate non-empty shortcuts within the same conflict scope. */
export function findShortcutConflict(shortcuts) {
    for (const scope of ['global', 'session']) {
        const seen = new Map();
        for (const action of SHORTCUT_ACTIONS) {
            if (action.scope !== scope) continue;
            const value = shortcuts?.[action.id];
            if (!value) continue;
            if (seen.has(value)) {
                return { first: seen.get(value), second: action, shortcut: value };
            }
            seen.set(value, action);
        }
    }
    return null;
}
