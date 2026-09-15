import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerAdapter, normalizeSource, resolveIdentity, getContainedRect, formatTime } from '../src/player.js';

const BV = 'BV1xx411c7mD';
const URL_ONE = `https://www.bilibili.com/video/${BV}/`;

function eventTarget(target = {}) {
    const handlers = new Map();
    target.addEventListener = (type, callback) => {
        if (!handlers.has(type)) handlers.set(type, new Set());
        handlers.get(type).add(callback);
    };
    target.removeEventListener = (type, callback) => handlers.get(type)?.delete(callback);
    target.dispatch = (type, event = {}) => { for (const callback of [...handlers.get(type) ?? []]) callback(event); };
    target.listenerCount = () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0);
    return target;
}

function fixture({ url = URL_ONE, canvasMode = false, readyState = 4, toBlob = null } = {}) {
    let now = 0;
    let nextTimer = 1;
    const timers = new Map();
    const navigations = [];
    const draws = [];
    const scripts = [];
    const observers = [];
    const containers = [];
    const rect = { left: 100, top: 100, width: 1280, height: 720, right: 1380, bottom: 820 };
    const makeContainer = (bounds = rect) => {
        const container = {
            bounds, isConnected: true, elements: [], style: {},
            getBoundingClientRect() { return this.bounds; },
            querySelectorAll(selector) {
                return this.elements.filter(element => selector === 'canvas' ? element.tagName === 'CANVAS' :
                    selector === 'video, bwp-video' ? element.tagName !== 'CANVAS' : false);
            },
            querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
            matches(selector) { return selector.includes('.bpx-player-video-wrap'); },
            contains(element) { return element === this || this.elements.includes(element); }
        };
        containers.push(container);
        return container;
    };
    const makeElement = (container, tagName, extra = {}) => {
        const element = {
            tagName, parentElement: container, isConnected: true, style: {},
            getBoundingClientRect() { return container.bounds; },
            closest(selector) { return selector === '.bpx-player-video-wrap' ? container : null; },
            ...extra
        };
        container.elements.push(element);
        return element;
    };
    const container = makeContainer();
    const media = makeElement(container, canvasMode ? 'BWP-VIDEO' : 'VIDEO', {
        currentTime: 123.5, paused: false, ended: false, duration: 600, readyState,
        videoWidth: canvasMode ? 0 : 1920, videoHeight: canvasMode ? 0 : 1080,
        style: canvasMode ? { display: 'none' } : { objectFit: 'contain' }
    });
    const drawable = canvasMode ? makeElement(container, 'CANVAS', { width: 1920, height: 1080 }) : media;
    const document = eventTarget({
        title: '测试视频_哔哩哔哩_bilibili', documentElement: {}, fullscreenElement: null,
        querySelectorAll(selector) {
            if (selector === 'script') return scripts;
            if (selector === 'video, bwp-video') return containers.flatMap(item => item.querySelectorAll(selector));
            if (selector.startsWith('.bpx-player-video-wrap,')) return containers;
            return [];
        },
        querySelector() { return null; },
        createElement(tag) {
            assert.equal(tag, 'canvas');
            return {
                width: 0, height: 0,
                getContext() { return { drawImage: (...args) => draws.push(args) }; },
                toBlob(callback, type, quality) {
                    if (toBlob) toBlob(callback, type, quality);
                    else callback(new Blob(['image'], { type }));
                }
            };
        }
    });
    const window = eventTarget({
        document, innerWidth: 1920, innerHeight: 1080,
        location: { href: url, assign(destination) { navigations.push(destination); } },
        history: {
            state: null,
            pushState(_state, _title, destination) { window.location.href = new URL(destination, window.location.href).href; },
            replaceState(_state, _title, destination) { window.location.href = new URL(destination, window.location.href).href; }
        },
        setTimeout(callback, delay) { const id = nextTimer++; timers.set(id, { callback, at: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        getComputedStyle(element) { return element.style; },
        MutationObserver: class {
            constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
            observe() {}
            disconnect() { this.disconnected = true; }
        }
    });
    function advance(ms) {
        const target = now + ms;
        for (;;) {
            const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            now = due[1].at;
            timers.delete(due[0]);
            due[1].callback();
        }
        now = target;
    }
    return { window, document, container, media, drawable, timers, navigations, draws, scripts, observers, containers,
        makeContainer, makeElement, advance };
}

test('normalizeSource distinguishes BV parts and strips unrelated query parameters', () => {
    const first = normalizeSource(`${URL_ONE}?spm_id_from=333.1`);
    const second = normalizeSource(`${URL_ONE}?p=2&t=33&bcm_seek=4`);
    assert.equal(first.sourceId, `bv:${BV}:p:1`);
    assert.equal(second.sourceId, `bv:${BV}:p:2`);
    assert.equal(second.url, `${URL_ONE}?p=2`);
    assert.equal(normalizeSource({ videoId: BV, page: 2 }).url, second.url);
    assert.equal(normalizeSource({ episodeId: 123 }).url, 'https://www.bilibili.com/bangumi/play/ep123');
});

test('normalizeSource rejects external URLs, invalid routes and conflicting identities', () => {
    for (const input of ['https://evil.test/video/' + BV, 'javascript:alert(1)',
        'https://bilibili.com.evil.test/video/' + BV, 'https://www.bilibili.com@evil.test/video/' + BV,
        `${URL_ONE}?p=0`, `${URL_ONE}?p=abc`, 'https://www.bilibili.com/']) assert.equal(normalizeSource(input), null);
    assert.equal(normalizeSource({ url: URL_ONE, page: 2 }), null);
    assert.equal(normalizeSource({ url: URL_ONE, episodeId: 'ep123' }), null);
    assert.equal(normalizeSource({ url: URL_ONE, sourceId: 'ep:123' }), null);
});

test('resolveIdentity preserves BV grouping while including the part in the source', () => {
    const identity = resolveIdentity({ url: `${URL_ONE}?p=2`, state: {
        videoData: { bvid: BV, title: '课程', pages: [{ page: 2, part: '第二课' }] }
    } });
    assert.equal(identity.seriesId, `bv_${BV}`);
    assert.equal(identity.epTitle, '第二课');
    assert.equal(identity.source.page, 2);
});

test('episodes fall back to explicit per-episode groups and accept matching season data', () => {
    const url = 'https://www.bilibili.com/bangumi/play/ep42';
    assert.equal(resolveIdentity({ url }).seriesId, 'bgm_ep42');
    assert.equal(resolveIdentity({ url, seasonId: 'ss7' }).seriesId, 'season_7');
    const state = { mediaInfo: { season_id: 7, title: '一部剧' }, epInfo: { id: 42, long_title: '第一集' } };
    assert.equal(resolveIdentity({ url, state }).seriesId, 'season_7');
    assert.equal(resolveIdentity({ url, state }).epTitle, '第一集');
    assert.equal(resolveIdentity({ url: 'https://www.bilibili.com/bangumi/play/ep99', state }).seriesId, 'bgm_ep99');
    const fromSeason = resolveIdentity({ url: 'https://www.bilibili.com/bangumi/play/ss7', state });
    assert.equal(fromSeason.seriesId, 'season_7');
    assert.equal(fromSeason.source.episodeId, 'ep42');
});

test('letterboxed video geometry uses the picture bounds inside the container', () => {
    const content = getContainedRect({
        containerRect: { left: 100, top: 50, width: 1920, height: 1080 },
        mediaRect: { left: 100, top: 50, width: 1920, height: 1080 },
        videoWidth: 2560, videoHeight: 1080
    });
    assert.deepEqual(content, { left: 0, top: 135, width: 1920, height: 810, right: 1920, bottom: 945 });
    assert.equal(getContainedRect({ containerRect: { width: 0, height: 100 } }), null);
    assert.deepEqual(getContainedRect({ containerRect: { left: 0, top: 0, width: 200, height: 200 },
        videoWidth: 200, videoHeight: 100, objectPosition: 'left top' }),
    { left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100 });
});

test('formatTime includes hours and treats invalid values safely', () => {
    assert.equal(formatTime(65.8), '01:05');
    assert.equal(formatTime(3605), '1:00:05');
    assert.equal(formatTime(NaN), '00:00');
});

test('capture uses the video time and asynchronous JPEG Blob at a maximum of 960px', async () => {
    const env = fixture();
    const adapter = createPlayerAdapter(env);
    const result = await adapter.capture();
    assert.equal(result.time, 123.5);
    assert.equal(result.imageBlob.type, 'image/jpeg');
    assert.equal(result.width, 960);
    assert.equal(result.height, 540);
    assert.equal(env.draws[0][0], env.media);
    adapter.dispose();
    assert.equal(env.timers.size, 0);
});

test('canvas rendering captures the canvas but reads time from the same playback controller', async () => {
    const env = fixture({ canvasMode: true });
    const adapter = createPlayerAdapter(env);
    assert.equal(adapter.getTime(), 123.5);
    assert.equal(adapter.getCurrent().media, env.media);
    const result = await adapter.capture();
    assert.equal(result.time, 123.5);
    assert.equal(env.draws[0][0], env.drawable);
    env.media.currentTime = undefined;
    assert.equal(adapter.getTime(), null);
    await assert.rejects(adapter.capture(), { code: 'TIME_UNAVAILABLE' });
    adapter.dispose();
});

test('the main visible player wins over a smaller autoplay preview', () => {
    const env = fixture();
    env.media.paused = true;
    const preview = env.makeContainer({ left: 0, top: 0, width: 160, height: 90, right: 160, bottom: 90 });
    env.makeElement(preview, 'VIDEO', { currentTime: 0, paused: false, videoWidth: 160, videoHeight: 90 });
    env.containers.reverse();
    const adapter = createPlayerAdapter(env);
    assert.equal(adapter.getCurrent().media, env.media);
    adapter.dispose();
});

test('multiple video elements cannot mix one frame with another playback clock', async () => {
    const env = fixture();
    env.media.paused = true;
    const playing = env.makeElement(env.container, 'VIDEO', {
        currentTime: 70, paused: false, ended: false, duration: 600, readyState: 4, videoWidth: 1920, videoHeight: 1080
    });
    const adapter = createPlayerAdapter(env);
    const captured = await adapter.capture();
    assert.equal(captured.time, 70);
    assert.equal(env.draws[0][0], playing);
    assert.equal(adapter.getCurrent().media, playing);
    adapter.dispose();
});

test('same-source seek waits for metadata and clamps the lead-in to zero', async () => {
    const env = fixture({ readyState: 0 });
    const adapter = createPlayerAdapter(env);
    const promise = adapter.seek({ source: normalizeSource(URL_ONE), time: 2 });
    assert.equal(env.media.currentTime, 123.5);
    env.media.readyState = 1;
    env.document.dispatch('loadedmetadata');
    env.advance(100);
    assert.deepEqual(await promise, { navigated: false });
    assert.equal(env.media.currentTime, 0);
    assert.equal(env.navigations.length, 0);
    adapter.dispose();
});

test('different BV part navigates to its own canonical source without seeking the current video', async () => {
    const env = fixture();
    const adapter = createPlayerAdapter(env);
    assert.deepEqual(await adapter.seek({ source: normalizeSource(`${URL_ONE}?p=2`), time: 40 }), { navigated: true });
    const destination = new URL(env.navigations[0]);
    assert.equal(destination.hostname, 'www.bilibili.com');
    assert.equal(destination.searchParams.get('p'), '2');
    assert.equal(destination.searchParams.get('bcm_seek'), '37');
    assert.equal(destination.searchParams.get('bcm_source'), `bv:${BV}:p:2`);
    assert.equal(env.media.currentTime, 123.5);
    await assert.rejects(adapter.seek({ source: { url: 'https://evil.test/' }, time: 40 }), { code: 'SOURCE_UNAVAILABLE' });
    adapter.dispose();
});

test('pending navigation resumes only after matching media is ready, then removes parameters', async () => {
    const url = new URL(`${URL_ONE}?p=2`);
    url.searchParams.set('bcm_seek', '37');
    url.searchParams.set('bcm_source', `bv:${BV}:p:2`);
    const env = fixture({ url: url.href, readyState: 0 });
    const adapter = createPlayerAdapter(env);
    const pending = adapter.resumePendingSeek();
    assert.equal(env.media.currentTime, 123.5);
    env.media.readyState = 1;
    env.document.dispatch('loadedmetadata');
    env.advance(100);
    assert.deepEqual(await pending, { resumed: true });
    assert.equal(env.media.currentTime, 37);
    assert.equal(new URL(env.window.location.href).searchParams.has('bcm_seek'), false);
    assert.equal(new URL(env.window.location.href).searchParams.get('p'), '2');
    adapter.dispose();
});

test('pending navigation cannot apply an episode timestamp to another episode', async () => {
    const env = fixture({ url: 'https://www.bilibili.com/bangumi/play/ep42?bcm_seek=30&bcm_source=ep%3A43' });
    const adapter = createPlayerAdapter(env);
    assert.deepEqual(await adapter.resumePendingSeek(), { resumed: false, reason: 'invalid-source-or-time' });
    assert.equal(env.media.currentTime, 123.5);
    adapter.dispose();
});

test('source changes cancel pending seeks instead of seeking the new video', async () => {
    const env = fixture({ readyState: 0 });
    const adapter = createPlayerAdapter(env);
    const pending = adapter.seek({ source: normalizeSource(URL_ONE), time: 40 });
    const rejection = assert.rejects(pending, { code: 'SOURCE_CHANGED' });
    env.window.history.pushState({}, '', `${URL_ONE}?p=2`);
    env.media.readyState = 1;
    env.advance(100);
    await rejection;
    assert.equal(env.media.currentTime, 123.5);
    adapter.dispose();
});

test('a reused ready video is not treated as the new source before its metadata arrives', async () => {
    const env = fixture();
    const adapter = createPlayerAdapter(env);
    env.window.history.pushState({}, '', `${URL_ONE}?p=2`);
    assert.equal(adapter.getTime(), null);
    assert.equal(adapter.getCurrent().sourceReady, false);
    await assert.rejects(adapter.capture(), { code: 'SOURCE_NOT_READY' });
    const pending = adapter.seek({ source: normalizeSource(`${URL_ONE}?p=2`), time: 40 });
    assert.equal(env.media.currentTime, 123.5);
    env.document.dispatch('loadedmetadata', { target: env.media });
    env.advance(100);
    await pending;
    assert.equal(env.media.currentTime, 37);
    assert.equal(adapter.getCurrent().sourceReady, true);
    adapter.dispose();
});

test('subscriptions coalesce DOM changes and only emit changed player identities', () => {
    const env = fixture();
    const originalHistory = env.window.history.pushState;
    const adapter = createPlayerAdapter(env);
    const seen = [];
    const unsubscribe = adapter.subscribe(snapshot => seen.push(snapshot?.identity.source.sourceId));
    for (let i = 0; i < 20; i++) env.observers[0].callback([]);
    assert.equal(env.timers.size, 1);
    env.advance(100);
    assert.equal(seen.length, 1);
    env.window.history.pushState({}, '', `${URL_ONE}?p=2`);
    env.advance(100);
    assert.deepEqual(seen, [`bv:${BV}:p:1`, `bv:${BV}:p:2`]);
    unsubscribe();
    adapter.dispose();
    assert.equal(env.window.history.pushState, originalHistory);
    assert.equal(env.timers.size, 0);
    assert.equal(env.window.listenerCount(), 0);
    assert.equal(env.document.listenerCount(), 0);
    assert.equal(env.observers[0].disconnected, true);
    assert.equal(adapter.getCurrent(), null);
});

test('readable JSON page state provides season identity without executing script text', () => {
    const env = fixture({ url: 'https://www.bilibili.com/bangumi/play/ep42' });
    env.scripts.push({ textContent: 'window.__INITIAL_STATE__={"mediaInfo":{"season_id":7},"epInfo":{"id":42}}; globalThis.shouldNeverRun=true;' });
    const adapter = createPlayerAdapter(env);
    assert.equal(adapter.getCurrent().identity.seriesId, 'season_7');
    assert.equal(globalThis.shouldNeverRun, undefined);
    adapter.dispose();
});

test('missing-player recovery is bounded and disposal cancels pending capture and seek work', async () => {
    const missing = fixture();
    missing.containers.length = 0;
    const emptyAdapter = createPlayerAdapter(missing);
    missing.advance(60_000);
    assert.equal(missing.timers.size, 0);
    emptyAdapter.dispose();

    const env = fixture({ toBlob() {} });
    const adapter = createPlayerAdapter(env);
    const capture = adapter.capture();
    env.media.readyState = 0;
    const seek = adapter.seek({ source: normalizeSource(URL_ONE), time: 10 });
    const captureRejected = assert.rejects(capture, { code: 'DISPOSED' });
    const seekRejected = assert.rejects(seek, { code: 'DISPOSED' });
    adapter.dispose();
    await Promise.all([captureRejected, seekRejected]);
    assert.equal(env.timers.size, 0);
});
