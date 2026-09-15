import test from 'node:test';
import assert from 'node:assert/strict';
import { createReviewController } from '../src/review.js';
import { normalizeSource } from '../src/player.js';

const SOURCE = normalizeSource('https://www.bilibili.com/video/BV1xx411c7mD/');
const OTHER_SOURCE = normalizeSource('https://www.bilibili.com/video/BV1xx411c7mD/?p=2');
const NOTE = { source: SOURCE, time: 50 };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function fixture({ paused = true, time = 20, rate = 1.25, duration = 600, deferredSeeks = false } = {}) {
    let now = 0;
    let timerId = 0;
    const timers = new Map();
    const subscribers = new Set();
    const states = [];
    const messages = [];
    const seeks = [];
    const mediaClock = {
        setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay }); return id; },
        clearTimeout(id) { timers.delete(id); }
    };
    function makeMedia(options = {}) {
        let position = options.time ?? time;
        const listeners = new Map();
        const media = {
            paused: options.paused ?? paused, playbackRate: options.rate ?? rate,
            duration: options.duration ?? duration, ended: false, playCalls: 0, pauseCalls: 0, timeWrites: [],
            ownerDocument: { defaultView: mediaClock },
            addEventListener(type, callback) {
                if (!listeners.has(type)) listeners.set(type, new Set());
                listeners.get(type).add(callback);
            },
            removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
            emit(type) { for (const callback of [...listeners.get(type) ?? []]) callback({ target: media }); },
            get currentTime() { return position; },
            set currentTime(value) {
                position = value;
                media.timeWrites.push(value);
                media.ended = false;
                media.emit('seeking');
                media.emit('seeked');
            },
            play() {
                media.playCalls++;
                const changed = media.paused;
                media.paused = false;
                if (changed) media.emit('play');
                return Promise.resolve();
            },
            pause() {
                media.pauseCalls++;
                const changed = !media.paused;
                media.paused = true;
                if (changed) media.emit('pause');
            },
            progress(value) { position = value; media.emit('timeupdate'); },
            seekBeforeEvent(value) { position = value; media.seeking = true; media.emit('timeupdate'); },
            finish() {
                position = media.duration;
                media.ended = true;
                media.paused = true;
                media.emit('pause');
                media.emit('ended');
            },
            userPause() { media.paused = true; media.emit('pause'); },
            listenerCount() { return [...listeners.values()].reduce((sum, set) => sum + set.size, 0); }
        };
        return media;
    }
    const media = makeMedia();
    let snapshot = { media, identity: { source: SOURCE }, sourceReady: true };
    const player = {
        getCurrent() { return snapshot; },
        getTime() { return snapshot?.sourceReady ? snapshot.media.currentTime : null; },
        subscribe(callback) { subscribers.add(callback); callback(snapshot); return () => subscribers.delete(callback); },
        seek(note, { leadIn }) {
            const request = { note, leadIn, media: snapshot?.media, deferred: null };
            seeks.push(request);
            const apply = () => {
                if (note.source.sourceId !== snapshot?.identity.source.sourceId) return { navigated: true };
                snapshot.media.currentTime = Math.max(0, note.time - leadIn);
                return { navigated: false };
            };
            if (!deferredSeeks) return Promise.resolve(apply());
            request.deferred = deferred();
            request.resolve = () => request.deferred.resolve(apply());
            return request.deferred.promise;
        }
    };
    const controller = createReviewController({ player, onState: value => states.push(value), notify: message => messages.push(message) });
    function changeSource(source = OTHER_SOURCE, targetMedia = media) {
        snapshot = source ? { media: targetMedia, identity: { source }, sourceReady: true } : null;
        for (const subscriber of [...subscribers]) subscriber(snapshot);
    }
    function advance(ms) {
        const target = now + ms;
        for (;;) {
            const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
            if (!next) break;
            now = next[1].at;
            timers.delete(next[0]);
            next[1].callback();
        }
        now = target;
    }
    return { controller, player, media, states, messages, timers, seeks, subscribers, makeMedia, changeSource, advance };
}

test('three iterations restore the original position, speed and paused state', async () => {
    const env = fixture();
    await env.controller.start(NOTE);
    assert.equal(env.media.currentTime, 47);
    assert.equal(env.media.playbackRate, 1);
    assert.equal(env.media.paused, false);
    assert.equal(env.controller.getState().iteration, 1);
    env.media.progress(53);
    assert.equal(env.controller.getState().iteration, 2);
    assert.equal(env.media.currentTime, 47);
    env.media.progress(53);
    assert.equal(env.controller.getState().iteration, 3);
    env.media.progress(53);
    await env.controller.stop();
    assert.equal(env.controller.getState().active, false);
    assert.equal(env.controller.getState().reason, 'completed');
    assert.equal(env.media.currentTime, 20);
    assert.equal(env.media.playbackRate, 1.25);
    assert.equal(env.media.paused, true);
    assert.equal(env.media.listenerCount(), 0);
    assert.equal(env.messages.length, 1);
    env.controller.dispose();
});

test('explicit stop restores a previously playing video', async () => {
    const env = fixture({ paused: false, time: 18, rate: 1.5 });
    await env.controller.start(NOTE, { rate: 0.75 });
    env.media.progress(49);
    await env.controller.stop();
    assert.equal(env.media.currentTime, 18);
    assert.equal(env.media.playbackRate, 1.5);
    assert.equal(env.media.paused, false);
    env.controller.dispose();
});

test('gap pauses and resumes only the current loop after the configured delay', async () => {
    const env = fixture();
    await env.controller.start(NOTE, { count: 2, gap: 2 });
    env.media.progress(53);
    assert.equal(env.controller.getState().phase, 'gap');
    assert.equal(env.media.paused, true);
    assert.equal(env.timers.size, 1);
    env.advance(1999);
    assert.equal(env.controller.getState().iteration, 1);
    env.advance(1);
    assert.equal(env.controller.getState().iteration, 2);
    assert.equal(env.media.currentTime, 47);
    assert.equal(env.media.paused, false);
    await env.controller.stop();
    env.controller.dispose();
});

test('a user pause during the gap cancels the timer and never resumes playback', async () => {
    const env = fixture();
    await env.controller.start(NOTE, { gap: 2 });
    env.media.progress(53);
    env.media.userPause();
    const plays = env.media.playCalls;
    assert.equal(env.timers.size, 0);
    env.advance(10_000);
    await env.controller.stop();
    assert.equal(env.media.playCalls, plays);
    assert.equal(env.media.paused, true);
    assert.equal(env.media.currentTime, 53);
    assert.equal(env.controller.getState().reason, 'user-pause');
    env.controller.dispose();
});

test('user playback during a gap takes control without a delayed restart', async () => {
    const env = fixture();
    await env.controller.start(NOTE, { gap: 2 });
    env.media.progress(53);
    await env.media.play();
    env.advance(10_000);
    await env.controller.stop();
    assert.equal(env.controller.getState().active, false);
    assert.equal(env.media.currentTime, 53);
    assert.equal(env.media.paused, false);
    assert.equal(env.timers.size, 0);
    env.controller.dispose();
});

test('manual seeking outside the interval preserves the new position', async () => {
    const env = fixture();
    await env.controller.start(NOTE);
    env.media.currentTime = 200;
    await env.controller.stop();
    assert.equal(env.media.currentTime, 200);
    assert.equal(env.media.paused, false);
    assert.equal(env.media.playbackRate, 1.25);
    assert.equal(env.controller.getState().reason, 'user-seek');
    env.controller.dispose();
});

test('manual seeking inside the interval continues, and owned boundary seeks are ignored', async () => {
    const env = fixture();
    await env.controller.start(NOTE);
    env.media.currentTime = 49;
    assert.equal(env.controller.getState().active, true);
    env.media.progress(53);
    assert.equal(env.media.currentTime, 47);
    assert.equal(env.controller.getState().active, true);
    assert.equal(env.controller.getState().iteration, 2);
    await env.controller.stop();
    env.controller.dispose();
});

test('the end of the video clips the range and natural pause/ended events count once', async () => {
    const env = fixture({ duration: 100 });
    await env.controller.start({ ...NOTE, time: 98 }, { count: 2 });
    assert.equal(env.controller.getState().start, 95);
    assert.equal(env.controller.getState().end, 100);
    env.media.finish();
    assert.equal(env.controller.getState().iteration, 2);
    assert.equal(env.media.currentTime, 95);
    env.media.finish();
    await env.controller.stop();
    assert.equal(env.controller.getState().reason, 'completed');
    assert.equal(env.media.currentTime, 20);
    env.controller.dispose();
});

test('a natural end does not leave a stale flag that swallows the next user pause', async () => {
    const env = fixture({ duration: 100 });
    await env.controller.start({ ...NOTE, time: 98 }, { count: 3 });
    env.media.finish();
    env.media.userPause();
    await env.controller.stop();
    assert.equal(env.controller.getState().reason, 'user-pause');
    assert.equal(env.media.currentTime, 95);
    assert.equal(env.media.paused, true);
    env.controller.dispose();
});

test('an outside seek is preserved even when timeupdate arrives before seeking', async () => {
    const env = fixture();
    await env.controller.start(NOTE);
    env.media.seekBeforeEvent(200);
    await env.controller.stop();
    assert.equal(env.controller.getState().reason, 'user-seek');
    assert.equal(env.media.currentTime, 200);
    env.controller.dispose();
});

test('loop count, speed and interval are bounded', async () => {
    const env = fixture();
    await env.controller.start(NOTE, { count: 99.5, rate: 4, gap: 100 });
    const state = env.controller.getState();
    assert.equal(state.count, 20);
    assert.equal(state.rate, 2);
    assert.equal(state.gap, 10);
    await env.controller.stop();
    await env.controller.start(NOTE, { count: -2, rate: 0.1, gap: -1 });
    assert.equal(env.controller.getState().count, 1);
    assert.equal(env.controller.getState().rate, 0.5);
    assert.equal(env.controller.getState().gap, 0);
    await env.controller.stop();
    env.controller.dispose();
});

test('an empty range restores state and reports an actionable error', async () => {
    const env = fixture();
    await assert.rejects(env.controller.start(NOTE, { before: 0, after: 0 }), /循环区间为空/);
    assert.equal(env.media.currentTime, 20);
    assert.equal(env.media.playbackRate, 1.25);
    assert.equal(env.controller.getState().active, false);
    assert.equal(env.media.listenerCount(), 0);
    env.controller.dispose();
});

test('cross-source cards navigate without starting an automatic cross-page loop', async () => {
    const env = fixture();
    assert.deepEqual(await env.controller.start({ source: OTHER_SOURCE, time: 40 }), { navigated: true });
    assert.equal(env.media.currentTime, 20);
    assert.equal(env.media.playCalls, 0);
    assert.equal(env.media.playbackRate, 1.25);
    assert.equal(env.controller.getState().reason, 'navigated');
    assert.match(env.messages[0], /再点一次循环/);
    env.controller.dispose();
});

test('a source change on a reused element never restores the previous source time', async () => {
    const env = fixture();
    await env.controller.start(NOTE, { rate: 0.5, gap: 2 });
    env.media.progress(53);
    const writesBeforeSwitch = env.media.timeWrites.length;
    env.changeSource();
    env.advance(10_000);
    await env.controller.stop();
    assert.equal(env.media.timeWrites.length, writesBeforeSwitch);
    assert.equal(env.media.playbackRate, 1.25);
    assert.equal(env.media.paused, true);
    assert.equal(env.timers.size, 0);
    assert.equal(env.controller.getState().reason, 'source-changed');
    env.controller.dispose();
});

test('replaced players and unmounted players clean up the old media', async () => {
    const env = fixture();
    await env.controller.start(NOTE, { rate: 2 });
    const replacement = env.makeMedia({ time: 100, rate: 0.75 });
    env.changeSource(SOURCE, replacement);
    await env.controller.stop();
    assert.equal(env.media.playbackRate, 1.25);
    assert.equal(env.media.listenerCount(), 0);
    assert.equal(replacement.currentTime, 100);
    assert.equal(replacement.playbackRate, 0.75);
    await env.controller.start(NOTE);
    env.changeSource(null);
    await env.controller.stop();
    assert.equal(replacement.listenerCount(), 0);
    env.controller.dispose();
});

test('stop during an asynchronous initial seek waits and restores the saved original position', async () => {
    const env = fixture({ deferredSeeks: true });
    const starting = env.controller.start(NOTE);
    await flush();
    const stopping = env.controller.stop();
    assert.equal(env.controller.getState().active, false);
    env.seeks[0].resolve();
    assert.deepEqual(await starting, { cancelled: true });
    await stopping;
    assert.equal(env.media.currentTime, 20);
    assert.equal(env.media.listenerCount(), 0);
    assert.equal(env.media.playCalls, 0);
    env.controller.dispose();
});

test('interleaved starts serialize initial seeks and only the latest request becomes active', async () => {
    const env = fixture({ deferredSeeks: true });
    const first = env.controller.start(NOTE);
    await flush();
    const second = env.controller.start({ ...NOTE, time: 80 }, { rate: 0.75 });
    assert.equal(env.seeks.length, 1);
    env.seeks[0].resolve();
    await flush();
    assert.equal(env.seeks.length, 2);
    assert.equal(env.media.currentTime, 20);
    env.seeks[1].resolve();
    assert.deepEqual(await first, { cancelled: true });
    await second;
    assert.equal(env.controller.getState().start, 77);
    assert.equal(env.media.currentTime, 77);
    assert.equal(env.media.playbackRate, 0.75);
    assert.equal(env.media.playCalls, 1);
    await env.controller.stop();
    assert.equal(env.media.currentTime, 20);
    env.controller.dispose();
});

test('cancelling a queued replacement loop still restores the original pre-loop position', async () => {
    const env = fixture({ deferredSeeks: true });
    const first = env.controller.start(NOTE);
    await flush();
    const second = env.controller.start({ ...NOTE, time: 80 });
    const stopping = env.controller.stop();
    env.seeks[0].resolve();
    await Promise.all([first, second, stopping]);
    assert.equal(env.seeks.length, 1);
    assert.equal(env.media.currentTime, 20);
    assert.equal(env.media.playCalls, 0);
    assert.equal(env.controller.getState().active, false);
    env.controller.dispose();
});

test('late rejection from a cancelled start cannot turn off a newer loop', async () => {
    const env = fixture({ deferredSeeks: true });
    const first = env.controller.start(NOTE);
    await flush();
    const second = env.controller.start({ ...NOTE, time: 80 });
    env.seeks[0].deferred.reject(new Error('old seek failed'));
    await flush();
    env.seeks[1].resolve();
    await Promise.all([first, second]);
    assert.equal(env.controller.getState().active, true);
    assert.equal(env.controller.getState().start, 77);
    await env.controller.stop();
    env.controller.dispose();
});

test('dispose clears timers, media listeners and subscriptions without restarting playback', async () => {
    const env = fixture();
    await env.controller.start(NOTE, { gap: 2, rate: 2 });
    env.media.progress(53);
    const playCalls = env.media.playCalls;
    env.controller.dispose();
    env.advance(10_000);
    assert.equal(env.media.playCalls, playCalls);
    assert.equal(env.media.playbackRate, 1.25);
    assert.equal(env.media.listenerCount(), 0);
    assert.equal(env.subscribers.size, 0);
    assert.equal(env.timers.size, 0);
    await assert.rejects(env.controller.start(NOTE), /已关闭/);
});

test('dispose invalidates an unresolved start before it can attach controls or play', async () => {
    const env = fixture({ deferredSeeks: true });
    const starting = env.controller.start(NOTE);
    await flush();
    env.controller.dispose();
    env.seeks[0].resolve();
    assert.deepEqual(await starting, { cancelled: true });
    assert.equal(env.media.playCalls, 0);
    assert.equal(env.media.listenerCount(), 0);
    assert.equal(env.media.playbackRate, 1.25);
    assert.equal(env.subscribers.size, 0);
});
