import test from 'node:test';
import assert from 'node:assert/strict';
import { createConfigStore } from '../src/config.js';

const LEGACY_KEY = 'bili_caption_mask_v200_cfg';
const GLOBAL_KEY = 'bili_caption_mask_v240_global';
const SERIES_PREFIX = 'bili_caption_mask_v240_series:';
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
        singleKeys: true, leadIn: 3, loopBefore: 3, loopAfter: 3, loopCount: 3, loopGap: 0, playbackRate: 1
    });
    defaults.left = 0;
    assert.equal(store.get('one').left, 15);
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
    store.patch('one', { top: 30, width: 40, enabled: false, playbackRate: 1.5 });
    store.patch('two', { top: 60 });
    const result = store.reset('one');
    assert.equal(result.top, 84);
    assert.equal(result.width, 70);
    assert.equal(result.enabled, false);
    assert.equal(result.playbackRate, 1.5);
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
    assert.equal(config.playbackRate, 1);
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

test('playback and loop numeric settings clamp to supported ranges', () => {
    const store = createConfigStore({ localStorage: memoryStorage() });
    const config = store.patch('one', { blur: 500, leadIn: -3, loopBefore: 90, loopAfter: -2, loopCount: 3.7, loopGap: 900, playbackRate: 10 });
    assert.deepEqual([config.blur, config.leadIn, config.loopBefore, config.loopAfter, config.loopCount, config.loopGap, config.playbackRate], [40, 0, 60, 0, 4, 30, 3]);
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
