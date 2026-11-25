import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_SHORTCUTS,
    eventToShortcut,
    findShortcutConflict,
    formatShortcut,
    matchesPeekRelease,
    matchesShortcut,
    normalizeShortcut,
    normalizeShortcutsMap
} from '../src/shortcuts.js';

test('normalizeShortcut canonicalizes modifier order, aliases, empty string and rejects invalid bindings', () => {
    assert.equal(normalizeShortcut('shift + ctrl + k'), 'Ctrl+Shift+K');
    assert.equal(normalizeShortcut('Option+s'), 'Alt+S');
    assert.equal(normalizeShortcut('cmd+shift+1'), 'Shift+Meta+1');
    assert.equal(normalizeShortcut('  space  '), 'Space');
    assert.equal(normalizeShortcut('f8'), 'F8');
    assert.equal(normalizeShortcut(''), '');
    assert.equal(normalizeShortcut('   '), '');
    assert.equal(normalizeShortcut('Alt'), null);
    assert.equal(normalizeShortcut('Alt', { allowModifierOnly: true }), 'Alt');
    assert.equal(normalizeShortcut('Control', { allowModifierOnly: true }), 'Ctrl');
    assert.equal(normalizeShortcut('Shift', { allowModifierOnly: true }), 'Shift');
    assert.equal(normalizeShortcut('Meta', { allowModifierOnly: true }), null);
    assert.equal(normalizeShortcut('Escape'), null);
    assert.equal(normalizeShortcut('Alt+Escape'), null);
    assert.equal(normalizeShortcut('Ctrl+Ctrl+A'), null);
    assert.equal(normalizeShortcut('InvalidKey'), null);
    assert.equal(normalizeShortcut(123), null);
});

test('eventToShortcut and matchesShortcut handle physical codes (including macOS Option keys) and synthetic events', () => {
    // macOS Option+S emits key='ß' while code='KeyS'.
    assert.equal(eventToShortcut({ altKey: true, key: 'ß', code: 'KeyS' }), 'Alt+S');
    assert.equal(matchesShortcut({ altKey: true, key: 'ß', code: 'KeyS' }, 'Alt+S'), true);
    assert.equal(matchesShortcut({ ctrlKey: true, shiftKey: true, key: 'K', code: 'KeyK' }, 'Ctrl+Shift+K'), true);
    assert.equal(matchesShortcut({ key: '3' }, '3'), true);
    assert.equal(matchesShortcut({ ctrlKey: true, key: '3' }, '3'), false);
    assert.equal(matchesShortcut({ key: ' ' }, 'Space'), true);
    assert.equal(matchesShortcut({ altKey: true, key: 'Alt', code: 'AltLeft' }, 'Alt', { allowModifierOnly: true }), true);
    assert.equal(matchesShortcut({ altKey: true, shiftKey: true, key: 'Alt', code: 'AltLeft' }, 'Alt', { allowModifierOnly: true }), false);
    assert.equal(matchesShortcut({ key: 'v', code: 'KeyV' }, 'V', { allowModifierOnly: true }), true);
    assert.equal(matchesShortcut({ key: 's' }, ''), false);
});

test('matchesPeekRelease handles modifier-only, single-key and combo peek bindings', () => {
    assert.equal(matchesPeekRelease({ key: 'Alt', code: 'AltLeft' }, 'Alt'), true);
    assert.equal(matchesPeekRelease({ key: 'Shift', code: 'ShiftLeft' }, 'Alt'), false);
    assert.equal(matchesPeekRelease({ key: 'v', code: 'KeyV' }, 'V'), true);
    assert.equal(matchesPeekRelease({ key: 'Control', code: 'ControlLeft' }, 'Ctrl+Space'), true);
    assert.equal(matchesPeekRelease({ key: ' ', code: 'Space' }, 'Ctrl+Space'), true);
    assert.equal(matchesPeekRelease({ key: 's', code: 'KeyS' }, ''), false);
});

test('formatShortcut, normalizeShortcutsMap and findShortcutConflict handle defaults and collisions', () => {
    assert.equal(formatShortcut(''), '已禁用');
    assert.equal(formatShortcut('Space'), '空格');
    assert.equal(formatShortcut('Ctrl+Shift+Backquote'), 'Ctrl + Shift + `');

    const map = normalizeShortcutsMap({ capture: 'ctrl+k', toggleMask: 'bad-key', editMask: '', peek: 'shift' });
    assert.equal(map.capture, 'Ctrl+K');
    assert.equal(map.toggleMask, DEFAULT_SHORTCUTS.toggleMask);
    assert.equal(map.editMask, '');
    assert.equal(map.peek, 'Shift');

    assert.equal(findShortcutConflict(DEFAULT_SHORTCUTS), null);
    assert.equal(findShortcutConflict({ ...DEFAULT_SHORTCUTS, capture: '', notebook: '' }), null);
    const globalConflict = findShortcutConflict({ ...DEFAULT_SHORTCUTS, capture: 'Alt+X', notebook: 'Alt+X' });
    assert.equal(globalConflict?.first.id, 'capture');
    assert.equal(globalConflict?.second.id, 'notebook');
    const sessionConflict = findShortcutConflict({ ...DEFAULT_SHORTCUTS, rateAgain: 'Q', rateHard: 'Q' });
    assert.equal(sessionConflict?.first.id, 'rateAgain');
    assert.equal(sessionConflict?.second.id, 'rateHard');
});
