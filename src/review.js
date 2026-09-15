import { normalizeSource } from './player.js';

function bounded(value, fallback, min, max = Infinity) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function reviewError(message) {
    const error = new Error(message);
    error.code = 'REVIEW_UNAVAILABLE';
    return error;
}

function sourceOf(note) {
    return normalizeSource(note?.source ?? note?.identity?.source ?? note?.url);
}

/** A cancellable, source-bound review loop. The player adapter owns navigation and initial seeking. */
export function createReviewController({ player, onState = () => {}, notify = () => {} } = {}) {
    if (!player?.getCurrent || !player?.seek || !player?.subscribe) throw new TypeError('循环播放需要 player adapter');
    let disposed = false;
    let generation = 0;
    let currentRun = null;
    let operations = Promise.resolve();
    let state = {
        active: false, phase: 'idle', iteration: 0, count: 0,
        start: 0, end: 0, gap: 0, rate: 1, sourceId: null, reason: null
    };

    function getState() { return { ...state }; }

    function publish(update) {
        state = { ...state, ...update };
        try { onState(getState()); } catch { /* A view callback must not leave a player listener running. */ }
    }

    function announce(message) {
        try { notify(message); } catch { /* Notification failures must not change playback. */ }
    }

    function owns(run) { return !disposed && currentRun === run && run.generation === generation && !run.cancelled; }

    function enqueue(operation) {
        const result = operations.then(operation, operation);
        operations = result.catch(() => {});
        return result;
    }

    function samePlayback(run, snapshot = player.getCurrent()) {
        return snapshot?.identity?.source?.sourceId === run.source.sourceId && snapshot.media === run.media && snapshot.sourceReady !== false;
    }

    function restoreRate(run) {
        if (!run?.rateChanged || !run.original?.media) return;
        try { run.original.media.playbackRate = run.original.rate; } catch { /* The old media may have been destroyed by navigation. */ }
        run.rateChanged = false;
    }

    function cleanup(run) {
        if (!run) return;
        run.cancelled = true;
        if (run.timer !== null) run.clearTimer(run.timer);
        run.timer = null;
        for (const remove of run.listeners.splice(0)) remove();
        run.expectedSeek = null;
        restoreRate(run);
    }

    function restorePlayback(run, restore) {
        restoreRate(run);
        const original = run?.original;
        if (!restore || !original) return;
        const snapshot = player.getCurrent();
        if (!snapshot || snapshot.media !== original.media || snapshot.identity?.source?.sourceId !== original.sourceId || snapshot.sourceReady === false) return;
        const media = original.media;
        if (Number.isFinite(original.time)) {
            const duration = media.duration;
            const target = Number.isFinite(duration) && duration > 0 ? Math.min(original.time, Math.max(0, duration - 0.05)) : original.time;
            try { media.currentTime = Math.max(0, target); } catch { /* Restoring play state still helps if this media cannot seek. */ }
        }
        try {
            if (original.paused) media.pause?.();
            else {
                const result = media.play?.();
                result?.catch?.(() => announce('已恢复位置与倍速，请手动继续播放'));
            }
        } catch { announce('已恢复位置与倍速，请手动继续播放'); }
    }

    function terminate(run, { restore = true, reason = 'stopped', message = null } = {}) {
        if (!run || currentRun !== run) return Promise.resolve();
        generation++;
        currentRun = null;
        cleanup(run);
        publish({ active: false, phase: 'idle', reason });
        // Serialize with an in-flight adapter.seek: a late seek cannot overwrite a newer loop.
        return enqueue(() => {
            if (!disposed) restorePlayback(run, restore);
            if (message && !disposed) announce(message);
        });
    }

    function stop({ restore = true } = {}) {
        if (!currentRun) return operations.then(() => undefined);
        return terminate(currentRun, { restore, reason: 'stopped' });
    }

    function interrupt(run, reason, message) {
        if (!owns(run)) return;
        void terminate(run, { restore: false, reason, message });
    }

    function ensureSource(run) {
        if (!owns(run)) return false;
        if (samePlayback(run)) return true;
        interrupt(run, 'source-changed', '视频已切换，循环已停止');
        return false;
    }

    function play(run) {
        if (!ensureSource(run)) return;
        try {
            const result = run.media.play?.();
            result?.catch?.(() => {
                if (owns(run)) interrupt(run, 'play-blocked', '浏览器未能开始播放，循环已停止，请手动播放后重试');
            });
        } catch {
            interrupt(run, 'play-blocked', '当前播放器无法开始播放，循环已停止');
        }
    }

    function jumpToStart(run) {
        if (!ensureSource(run)) return false;
        run.expectedSeek = run.start;
        try { run.media.currentTime = run.start; }
        catch {
            interrupt(run, 'seek-failed', '播放器暂时无法定位，循环已停止');
            return false;
        }
        return owns(run);
    }

    function nextIteration(run) {
        if (!ensureSource(run)) return;
        run.phase = 'playing';
        run.iteration++;
        publish({ phase: 'playing', iteration: run.iteration });
        if (jumpToStart(run)) play(run);
    }

    function reachEnd(run, origin = 'timeupdate') {
        if (!owns(run) || run.phase !== 'playing' || run.transitioning) return;
        if (!ensureSource(run)) return;
        run.transitioning = true;
        if (run.iteration >= run.options.count) {
            void terminate(run, {
                restore: true, reason: 'completed', message: `已完成 ${run.options.count} 次循环，已恢复原播放状态`
            });
            return;
        }
        if (run.media.ended && origin === 'timeupdate') run.expectedPause = true;
        if (run.options.gap === 0) {
            run.transitioning = false;
            nextIteration(run);
            return;
        }
        run.phase = 'gap';
        publish({ phase: 'gap' });
        if (!run.media.paused) {
            run.expectedPause = true;
            try { run.media.pause?.(); }
            catch {
                run.transitioning = false;
                interrupt(run, 'pause-failed', '播放器暂时无法暂停，循环已停止');
                return;
            }
        }
        run.transitioning = false;
        if (!owns(run)) return;
        run.timer = run.setTimer(() => {
            run.timer = null;
            if (!ensureSource(run) || run.phase !== 'gap') return;
            if (!run.media.paused) {
                interrupt(run, 'user-control', '已保留你的播放操作，循环已停止');
                return;
            }
            nextIteration(run);
        }, run.options.gap * 1000);
    }

    function attach(run) {
        const listen = (type, handler) => {
            run.media.addEventListener(type, handler);
            run.listeners.push(() => run.media.removeEventListener(type, handler));
        };
        listen('timeupdate', () => {
            if (!owns(run) || run.phase !== 'playing') return;
            const time = run.media.currentTime;
            if (run.media.seeking && (!Number.isFinite(run.expectedSeek) || Math.abs(time - run.expectedSeek) > 0.1)) {
                if (time < run.start - 0.1 || time > run.end + 0.1) interrupt(run, 'user-seek', '已保留你的播放位置，循环已停止');
                return;
            }
            if (time >= run.end) reachEnd(run);
        });
        listen('ended', () => {
            if (run.media.ended || run.media.currentTime >= run.end) reachEnd(run, 'ended');
        });
        listen('seeking', () => {
            if (!owns(run)) return;
            const time = run.media.currentTime;
            if (Number.isFinite(run.expectedSeek) && Math.abs(time - run.expectedSeek) <= 0.1) return;
            run.expectedSeek = null;
            if (run.phase === 'gap' || !Number.isFinite(time) || time < run.start - 0.1 || time > run.end + 0.1) {
                interrupt(run, 'user-seek', '已保留你的播放位置，循环已停止');
            }
        });
        listen('seeked', () => { run.expectedSeek = null; });
        listen('pause', () => {
            if (!owns(run)) return;
            if (run.expectedPause) { run.expectedPause = false; return; }
            if (run.media.ended && run.media.currentTime >= run.end) {
                if (run.phase === 'playing') reachEnd(run, 'pause');
                return;
            }
            interrupt(run, 'user-pause', '已保留暂停状态，循环已停止');
        });
        listen('play', () => {
            if (!owns(run)) return;
            if (run.phase === 'gap') interrupt(run, 'user-control', '已保留你的播放操作，循环已停止');
        });
    }

    function start(note, { before = 3, after = 3, count = 3, gap = 0, rate = 1 } = {}) {
        if (disposed) return Promise.reject(reviewError('循环播放器已关闭'));
        const source = sourceOf(note);
        if (!source) return Promise.reject(reviewError('这条笔记缺少可靠的播放来源，无法循环'));
        if (!Number.isFinite(note?.time) || note.time < 0) return Promise.reject(reviewError('这条笔记的时间戳无效'));
        const options = {
            before: bounded(before, 3, 0), after: bounded(after, 3, 0),
            count: Math.floor(bounded(count, 3, 1, 20)), gap: bounded(gap, 0, 0, 10), rate: bounded(rate, 1, 0.5, 2)
        };
        const previous = currentRun;
        cleanup(previous);
        const run = {
            generation: ++generation, source, note, options, cancelled: false, listeners: [],
            phase: 'starting', iteration: 1, start: Math.max(0, note.time - options.before), end: note.time + options.after,
            media: null, original: previous?.original ?? null, rateChanged: false, expectedPause: false, expectedSeek: null,
            timer: null, setTimer: globalThis.setTimeout, clearTimer: globalThis.clearTimeout,
            watchSourceId: null, transitioning: false
        };
        currentRun = run;
        publish({
            active: true, phase: 'starting', iteration: 1, count: options.count,
            start: run.start, end: run.end, gap: options.gap, rate: options.rate, sourceId: source.sourceId, reason: null
        });

        return enqueue(async () => {
            if (!owns(run)) return { cancelled: true };
            if (previous) restorePlayback(previous, true);
            if (!owns(run)) return { cancelled: true };
            const initial = player.getCurrent();
            if (initial?.identity?.source?.sourceId === source.sourceId && initial.media) {
                const oldTime = player.getTime?.();
                run.media = initial.media;
                run.watchSourceId = source.sourceId;
                run.original = {
                    sourceId: source.sourceId, media: initial.media,
                    time: Number.isFinite(oldTime) ? oldTime : null,
                    paused: Boolean(initial.media.paused), rate: Number.isFinite(initial.media.playbackRate) ? initial.media.playbackRate : 1
                };
            }
            try {
                const result = await player.seek(note, { leadIn: options.before });
                if (!owns(run)) return { cancelled: true };
                if (result?.navigated) {
                    generation++;
                    currentRun = null;
                    cleanup(run);
                    publish({ active: false, phase: 'idle', reason: 'navigated' });
                    announce('已跳转到原视频；页面就绪后，再点一次循环');
                    return { navigated: true };
                }
                const snapshot = player.getCurrent();
                if (!snapshot?.media || snapshot.identity?.source?.sourceId !== source.sourceId || snapshot.sourceReady === false) {
                    throw reviewError('视频已切换，无法开始循环');
                }
                if (run.original && snapshot.media !== run.original.media) throw reviewError('播放器已更换，请重新开始循环');
                run.media = snapshot.media;
                run.watchSourceId = source.sourceId;
                if (!run.original) {
                    run.original = {
                        sourceId: source.sourceId, media: snapshot.media, time: null,
                        paused: Boolean(snapshot.media.paused), rate: Number.isFinite(snapshot.media.playbackRate) ? snapshot.media.playbackRate : 1
                    };
                }
                const duration = snapshot.media.duration;
                if (!(duration > 0)) throw reviewError('视频时长尚未就绪，请稍后重试循环');
                run.end = Math.min(duration, note.time + options.after);
                if (!(run.start < run.end)) throw reviewError('循环区间为空，请调整卡片时间或前后秒数');
                const mediaWindow = snapshot.media.ownerDocument?.defaultView;
                run.setTimer = mediaWindow?.setTimeout?.bind(mediaWindow) ?? globalThis.setTimeout;
                run.clearTimer = mediaWindow?.clearTimeout?.bind(mediaWindow) ?? globalThis.clearTimeout;
                run.media.playbackRate = options.rate;
                run.rateChanged = true;
                run.phase = 'playing';
                attach(run);
                publish({ phase: 'playing', start: run.start, end: run.end });
                play(run);
                return { navigated: false };
            } catch (error) {
                if (!owns(run)) return { cancelled: true };
                generation++;
                currentRun = null;
                cleanup(run);
                restorePlayback(run, true);
                publish({ active: false, phase: 'idle', reason: 'error' });
                throw error;
            }
        });
    }

    const unsubscribe = player.subscribe(snapshot => {
        const run = currentRun;
        if (!run || !run.watchSourceId) return;
        if (snapshot?.identity?.source?.sourceId !== run.watchSourceId || snapshot.media !== run.media ||
            (run.phase !== 'starting' && snapshot.sourceReady === false)) {
            interrupt(run, 'source-changed', '视频已切换，循环已停止');
        }
    });

    function dispose() {
        if (disposed) return;
        disposed = true;
        generation++;
        const run = currentRun;
        currentRun = null;
        cleanup(run);
        unsubscribe?.();
        publish({ active: false, phase: 'idle', reason: 'disposed' });
    }

    return { start, stop, getState, dispose };
}
