import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigStore } from '../src/config.js';
import { DEFAULT_SHORTCUTS } from '../src/shortcuts.js';

const LEGACY_KEY = 'bili_caption_mask_v200_cfg';
const GLOBAL_KEY = 'bili_caption_mask_v240_global';
const SERIES_PREFIX = 'bili_caption_mask_v240_series:';
const V250_KEYS = {
    capture: 'Alt+S', notebook: 'Alt+B', toggleMask: 'Alt+C', editMask: 'Alt+Z', peek: 'Alt',
    reveal: 'Space', rateAgain: '1', rateHard: '2', rateGood: '3'
};
function memoryStorage(initial = {}) {
    const data = new Map(Object.entries(initial));
    const writes = [];
    return {
        data, writes,
        getItem(key) { return data.get(key) ?? null; },
        setItem(key, value) { writes.push(key); data.set(key, value); },
        removeItem(key) { data.delete(key); }
    };
}

test('config defaults are independent snapshots and geometry remains inside the player', () => {
    const localStorage = memoryStorage();
    const store = createConfigStore({ localStorage });
    const defaults = store.get('one');
    assert.deepEqual(defaults, {
        enabled: true, left: 15, top: 84, width: 70, height: 7.2, blur: 14, mode: 'blur',
        shortcuts: { ...DEFAULT_SHORTCUTS }
    });
    defaults.left = 0;
    defaults.shortcuts.capture = 'X';
    assert.equal(store.get('one').left, 15);
    assert.equal(store.get('one').shortcuts.capture, 'C');
    const clamped = store.patch('one', { left: 200, top: 100, width: 500, height: -1 });
    assert.deepEqual([clamped.left, clamped.top, clamped.width, clamped.height], [0, 98, 100, 2]);
    const minimum = store.patch('one', { left: -4, top: -2, width: 1, height: 1 });
    assert.deepEqual([minimum.left, minimum.top, minimum.width, minimum.height], [0, 0, 5, 2]);
});

test('legacy config is a read-only fallback, including per-series geometry', () => {
    const legacy = JSON.stringify({ global: { enabled: false, left: 20, top: 70, width: 60, height: 10 }, series: { one: { left: 25, top: 65, width: 50, height: 12 } } });
    const localStorage = memoryStorage({ [LEGACY_KEY]: legacy });
    const store = createConfigStore({ localStorage });
    assert.equal(store.get('one').enabled, false);
    assert.deepEqual([store.get('one').left, store.get('one').width], [25, 50]);
    assert.deepEqual([store.get('two').left, store.get('two').width], [20, 60]);
    assert.equal(localStorage.writes.length, 0);
    store.patch('one', { top: 55 });
    assert.equal(store.get('one').top, 55);
    assert.equal(localStorage.getItem(LEGACY_KEY), legacy);
    assert.deepEqual(localStorage.writes, [`${SERIES_PREFIX}one`]);
});

test('two instances editing different series retain both configurations without a shared object write', () => {
    const localStorage = memoryStorage();
    const first = createConfigStore({ localStorage });
    const second = createConfigStore({ localStorage });
    first.get('a');
    second.get('b');
    first.patch('a', { top: 50 });
    second.patch('b', { width: 40 });
    assert.equal(second.get('a').top, 50);
    assert.equal(first.get('b').width, 40);
    assert.deepEqual(localStorage.writes, [`${SERIES_PREFIX}a`, `${SERIES_PREFIX}b`]);
});

test('global patches read the latest state and merge settings from another instance', () => {
    const localStorage = memoryStorage();
    const first = createConfigStore({ localStorage });
    const second = createConfigStore({ localStorage });
    first.get('a');
    second.get('b');
    first.patch('a', { enabled: false });
    second.patch('b', { blur: 20, mode: 'solid' });
    assert.equal(first.get('a').enabled, false);
    assert.equal(first.get('a').blur, 20);
    assert.equal(first.get('a').mode, 'solid');
    assert.deepEqual(localStorage.writes, [GLOBAL_KEY, GLOBAL_KEY]);
    assert.equal(JSON.parse(localStorage.getItem(GLOBAL_KEY)).left, undefined);
});

test('reset restores only one series geometry and preserves global options and other series', () => {
    const localStorage = memoryStorage();
    const store = createConfigStore({ localStorage });
    store.patch('one', { top: 30, width: 40, enabled: false, blur: 22 });
    store.patch('two', { top: 60 });
    const result = store.reset('one');
    assert.equal(result.top, 84);
    assert.equal(result.width, 70);
    assert.equal(result.enabled, false);
    assert.equal(result.blur, 22);
    assert.equal(store.get('two').top, 60);
});

test('malformed legacy/new values fall back to safe defaults without NaN or null geometry', () => {
    const localStorage = memoryStorage({
        [LEGACY_KEY]: JSON.stringify({ global: null, series: null }),
        [GLOBAL_KEY]: JSON.stringify({ enabled: null, playbackRate: 'fast', mode: 'unsafe', blur: null }),
        [`${SERIES_PREFIX}one`]: JSON.stringify({ left: null, top: 'high', width: 1000, height: -2 })
    });
    const store = createConfigStore({ localStorage });
    const config = store.get('one');
    assert.equal(config.enabled, true);
    assert.equal(config.playbackRate, undefined);
    assert.equal(config.mode, 'blur');
    assert.equal(config.blur, 14);
    assert.deepEqual([config.left, config.top, config.width, config.height], [0, 84, 100, 2]);
    localStorage.setItem(`${SERIES_PREFIX}one`, '{invalid json');
    assert.equal(store.get('one').width, 70);
});

test('invalid patches and prototype pollution are rejected before any write', () => {
    const localStorage = memoryStorage();
    const store = createConfigStore({ localStorage });
    for (const value of [null, NaN, Infinity, -Infinity, '20', {}]) {
        assert.throws(() => store.patch('one', { top: value }), /有效数字/);
    }
    assert.throws(() => store.patch('one', { enabled: 1 }), /开关/);
    assert.throws(() => store.patch('one', { mode: 'invisible' }), /模式/);
    assert.throws(() => store.patch('one', { unknown: true }), /不支持/);
    assert.throws(() => store.patch('one', JSON.parse('{"__proto__":{"polluted":true}}')), /不安全/);
    assert.throws(() => store.patch('one', Object.create({ enabled: false })), /无效/);
    assert.equal({}.polluted, undefined);
    assert.equal(localStorage.writes.length, 0);
});

test('obsolete stored settings are ignored and existing mask settings remain', () => {
    const obsolete = { singleKeys: false, leadIn: 4, loopBefore: 2, loopAfter: 5, loopCount: 2, loopGap: 1, playbackRate: 1.5, reviewBatch: 30 };
    const localStorage = memoryStorage({
        [GLOBAL_KEY]: JSON.stringify({ ...obsolete, blur: 22, mode: 'solid' }),
        [`${SERIES_PREFIX}one`]: JSON.stringify({ top: 30 })
    });
    const store = createConfigStore({ localStorage });
    const config = store.get('one');
    assert.deepEqual([config.top, config.blur, config.mode, config.shortcuts.capture], [30, 22, 'solid', 'C']);
    assert.ok(Object.keys(obsolete).every(key => !Object.hasOwn(config, key)));
    assert.throws(() => store.patch('one', { leadIn: 4 }), /不支持/);
    assert.equal(store.patch('one', { blur: 500 }).blur, 40);
    assert.ok(Object.keys(obsolete).every(key => !Object.hasOwn(JSON.parse(localStorage.getItem(GLOBAL_KEY)), key)));
});

test('GM storage takes precedence and writes only one backend', () => {
    const localStorage = memoryStorage({ [GLOBAL_KEY]: JSON.stringify({ enabled: true }) });
    const gm = memoryStorage({ [GLOBAL_KEY]: JSON.stringify({ enabled: false }) });
    const store = createConfigStore({ localStorage, gmGet: (key, fallback) => gm.getItem(key) ?? fallback, gmSet: (key, value) => gm.setItem(key, value) });
    assert.equal(store.get('one').enabled, false);
    store.patch('one', { blur: 25 });
    assert.equal(localStorage.writes.length, 0);
    assert.deepEqual(gm.writes, [GLOBAL_KEY]);
    assert.equal(store.get('one').blur, 25);
});

test('saved v2.5 defaults migrate without changing mask preferences or writing on read', () => {
    const old = { blur: 27, mode: 'solid', singleKeys: true, reviewBatch: 20, shortcuts: V250_KEYS };
    const localStorage = memoryStorage({ [GLOBAL_KEY]: JSON.stringify(old), [`${SERIES_PREFIX}one`]: JSON.stringify({ top: 30 }) });
    const store = createConfigStore({ localStorage });
    const { blur, mode, top, shortcuts } = store.get('one');
    assert.deepEqual({ blur, mode, top }, { blur: 27, mode: 'solid', top: 30 });
    assert.deepEqual(shortcuts, DEFAULT_SHORTCUTS);
    assert.deepEqual(localStorage.writes, []);
    assert.deepEqual(store.patch('one', { blur: 28 }).shortcuts, DEFAULT_SHORTCUTS);
    const saved = JSON.parse(localStorage.getItem(GLOBAL_KEY));
    assert.deepEqual(saved.shortcuts, DEFAULT_SHORTCUTS);
    assert.equal(Object.hasOwn(saved, 'singleKeys'), false);
});

test('v2.5 snapshots with customized or disabled bindings preserve their surviving keys', () => {
    for (const change of [{ capture: 'Ctrl+K', editMask: '' }, { reveal: 'Enter' }]) {
        const shortcuts = { ...V250_KEYS, ...change };
        const storage = memoryStorage({ [GLOBAL_KEY]: JSON.stringify({ loopCount: 3, shortcuts }) });
        const config = createConfigStore({ localStorage: storage }).get('one');
        assert.deepEqual(config.shortcuts, Object.fromEntries(Object.keys(DEFAULT_SHORTCUTS).map(id => [id, shortcuts[id]])));
    }
});

test('v3 keeps explicitly saved Alt+S and Alt+C even with older fallback settings', () => {
    const shortcuts = { ...DEFAULT_SHORTCUTS, capture: 'Alt+S', toggleMask: 'Alt+C' };
    const localStorage = memoryStorage({
        [LEGACY_KEY]: JSON.stringify({ global: { singleKeys: true } }),
        [GLOBAL_KEY]: JSON.stringify({ blur: 20, shortcuts })
    });
    const store = createConfigStore({ localStorage });
    assert.deepEqual(store.get('one').shortcuts, shortcuts);
    assert.deepEqual(store.patch('one', { blur: 21 }).shortcuts, shortcuts);
});

test('a GM read exception can recover local legacy settings but never a competing new local value', () => {
    const localStorage = memoryStorage({
        [LEGACY_KEY]: JSON.stringify({ global: { enabled: false }, series: { one: { top: 50 } } }),
        [GLOBAL_KEY]: JSON.stringify({ blur: 35 })
    });
    const store = createConfigStore({ localStorage, gmGet: () => { throw new Error('read denied'); }, gmSet: () => { throw new Error('write denied'); } });
    assert.equal(store.get('one').top, 50);
    assert.equal(store.get('one').enabled, false);
    assert.equal(store.get('one').blur, 14);
    assert.throws(() => store.patch('one', { blur: 20 }), /设置保存失败/);
    assert.equal(localStorage.writes.length, 0);
});

test('local and GM write failures are reported instead of returning success', () => {
    const broken = createConfigStore({ localStorage: { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } } });
    assert.throws(() => broken.patch('one', { enabled: false }), /存储空间不足/);
    const missing = createConfigStore({ localStorage: null });
    assert.throws(() => missing.patch('one', { top: 50 }), /设置保存失败/);
    const gm = createConfigStore({ gmGet: () => null, gmSet: () => { throw new Error('denied'); }, localStorage: memoryStorage() });
    assert.throws(() => gm.patch('one', { enabled: false }), /设置保存失败/);
});

test('get reads new external changes on every call and dispose closes the store', () => {
    const localStorage = memoryStorage();
    const store = createConfigStore({ localStorage, window: {} });
    assert.equal(store.get('one').blur, 14);
    localStorage.setItem(GLOBAL_KEY, JSON.stringify({ blur: 22 }));
    assert.equal(store.get('one').blur, 22);
    store.dispose();
    assert.throws(() => store.get('one'), /已关闭/);
});

test('custom shortcuts merge partially across instances, validate strictly and fall back safely when malformed', () => {
    const localStorage = memoryStorage();
    const first = createConfigStore({ localStorage });
    const second = createConfigStore({ localStorage });
    first.patch('one', { shortcuts: { capture: 'ctrl + shift + k', editMask: '' } });
    second.patch('two', { shortcuts: { peek: 'shift', notebook: 'Enter' } });
    assert.deepEqual(first.get('one').shortcuts, {
        ...DEFAULT_SHORTCUTS,
        capture: 'Ctrl+Shift+K',
        editMask: '',
        peek: 'Shift',
        notebook: 'Enter'
    });
    assert.throws(() => first.patch('one', { shortcuts: 'Alt+S' }), /对象/);
    assert.throws(() => first.patch('one', { shortcuts: { unknownAction: 'Alt+K' } }), /不支持的快捷键/);
    assert.throws(() => first.patch('one', { shortcuts: { capture: 'Alt' } }), /格式无效/);
    assert.throws(() => first.patch('one', { shortcuts: { capture: 'Escape' } }), /格式无效/);
    assert.throws(() => first.patch('one', JSON.parse('{"shortcuts":{"__proto__":{"polluted":true}}}')), /不安全/);
    assert.equal({}.polluted, undefined);
    localStorage.setItem(GLOBAL_KEY, JSON.stringify({ shortcuts: { capture: 'bad', peek: 'Control', rateGood: 'g' } }));
    const recovered = first.get('one').shortcuts;
    assert.equal(recovered.capture, DEFAULT_SHORTCUTS.capture);
    assert.equal(recovered.peek, 'Ctrl');
    assert.equal(recovered.rateGood, undefined);
});
