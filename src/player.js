const PLAYER_SELECTORS = [
    '.bpx-player-video-wrap', '.squirtle-video-wrap', '.bilibili-player-video-wrap',
    '.bilibili-player-video', '.bpx-player-video-area', '#playerWrap',
    '#player_module', '#bilibiliPlayer', '#bofqi'
];
const PLAYER_SELECTOR = PLAYER_SELECTORS.join(',');
const SEEK_PARAM = 'bcm_seek';
const SOURCE_PARAM = 'bcm_source';
const MAX_JSON_LENGTH = 2_000_000;

function playerError(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
}

function numericId(value, prefix) {
    const raw = String(value ?? '').replace(new RegExp(`^(?:${prefix}|${prefix === 'ss' ? 'season_' : 'episode_'})`), '');
    return /^[1-9]\d*$/.test(raw) ? raw : null;
}

function validPage(value) {
    const page = value == null || value === '' ? 1 : Number(value);
    return Number.isSafeInteger(page) && page > 0 ? page : null;
}

/** Return a canonical, navigable Bilibili source, or null for unsafe/ambiguous input. */
export function normalizeSource(value, baseUrl = 'https://www.bilibili.com/') {
    const supplied = typeof value === 'string' ? { url: value } : value;
    if (!supplied || typeof supplied !== 'object') return null;
    let inputUrl = supplied.url;
    if (!inputUrl) {
        if (/^BV[0-9A-Za-z]{10}$/.test(supplied.videoId ?? '')) {
            const page = validPage(supplied.page);
            if (!page) return null;
            inputUrl = `https://www.bilibili.com/video/${supplied.videoId}/?p=${page}`;
        } else {
            const ep = numericId(supplied.episodeId, 'ep');
            if (ep) inputUrl = `https://www.bilibili.com/bangumi/play/ep${ep}`;
        }
    }
    if (typeof inputUrl !== 'string') return null;
    let parsed;
    try { parsed = new URL(inputUrl, baseUrl); } catch { return null; }
    if (!/^https?:$/.test(parsed.protocol) ||
        !/(^|\.)bilibili\.com$/i.test(parsed.hostname) || parsed.username || parsed.password || parsed.port) return null;

    const videoMatch = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
    const episodeMatch = parsed.pathname.match(/^\/bangumi\/play\/(ep|ss)([1-9]\d*)\/?$/);
    let source;
    if (videoMatch) {
        const page = validPage(parsed.searchParams.get('p'));
        if (!page) return null;
        const videoId = videoMatch[1];
        source = {
            url: `https://www.bilibili.com/video/${videoId}/${page > 1 ? `?p=${page}` : ''}`,
            videoId, episodeId: null, page, sourceId: `bv:${videoId}:p:${page}`
        };
    } else if (episodeMatch) {
        const [, kind, id] = episodeMatch;
        source = {
            url: `https://www.bilibili.com/bangumi/play/${kind}${id}`,
            videoId: null, episodeId: kind === 'ep' ? `ep${id}` : null,
            page: 1, sourceId: `${kind}:${id}`
        };
    } else return null;

    if (supplied.videoId != null && supplied.videoId !== source.videoId) return null;
    if (supplied.episodeId != null && `ep${numericId(supplied.episodeId, 'ep')}` !== source.episodeId) return null;
    if (supplied.page != null && validPage(supplied.page) !== source.page) return null;
    if (supplied.sourceId != null && supplied.sourceId !== source.sourceId) return null;
    return source;
}

function cleanTitle(title) {
    return String(title ?? '').replace(/-(?:电视剧|番剧|电影|纪录片)-全集.*$/, '')
        .replace(/-高清正版在线观看.*$/, '').replace(/_哔哩哔哩(?:_bilibili)?.*$/, '').trim();
}

function unwrapState(state) {
    return state?.props?.pageProps?.initialState ?? state?.props?.pageProps?.__INITIAL_STATE__ ??
        state?.props?.pageProps ?? state?.initialState ?? state?.__INITIAL_STATE__ ?? state ?? {};
}

/** Resolve identities without relying on a page-world bridge or network request. */
export function resolveIdentity({ url, title = '', state = null, seasonId = null, episodeId = null, epTitle = '' } = {}) {
    let source = normalizeSource(url);
    if (!source) return null;
    const data = unwrapState(state);
    const info = data.epInfo ?? data.ep_info ?? {};
    const stateEpisodeId = numericId(info.id ?? info.ep_id ?? info.epid, 'ep');
    const stateSeasonId = numericId(data.mediaInfo?.season_id ?? data.seasonInfo?.season_id ?? data.season_id, 'ss');
    const explicitSeasonId = numericId(seasonId, 'ss');
    let seriesTitle = cleanTitle(title) || '未命名视频';
    let episodeTitle = String(epTitle ?? '').trim();
    let seriesId;

    if (source.videoId) {
        seriesId = `bv_${source.videoId}`;
        const videoData = data.videoData ?? {};
        if (videoData.bvid === source.videoId) {
            seriesTitle = cleanTitle(videoData.title) || seriesTitle;
            const part = Array.isArray(videoData.pages) ? videoData.pages.find(item => item.page === source.page) : null;
            episodeTitle ||= String(part?.part ?? '').trim();
        }
        episodeTitle ||= `P${source.page}`;
    } else {
        const pathSeasonId = source.sourceId.startsWith('ss:') ? source.sourceId.slice(3) : null;
        if (pathSeasonId) {
            const selectedEpisode = numericId(episodeId, 'ep') ||
                (stateSeasonId === pathSeasonId ? stateEpisodeId : null);
            if (selectedEpisode) source = normalizeSource({ episodeId: selectedEpisode });
        }
        const currentEpisodeId = numericId(source.episodeId, 'ep');
        const listedEpisodes = Array.isArray(data.epList) ? data.epList : [];
        const stateMatches = currentEpisodeId ? stateEpisodeId === currentEpisodeId ||
            listedEpisodes.some(item => numericId(item.id ?? item.ep_id, 'ep') === currentEpisodeId) :
            pathSeasonId === stateSeasonId;
        const season = pathSeasonId || explicitSeasonId || (stateMatches ? stateSeasonId : null);
        seriesId = season ? `season_${season}` : `bgm_${source.episodeId}`;
        if (stateMatches) {
            seriesTitle = cleanTitle(data.mediaInfo?.title ?? data.seasonInfo?.title) || seriesTitle;
            const episode = stateEpisodeId === currentEpisodeId ? info :
                listedEpisodes.find(item => numericId(item.id ?? item.ep_id, 'ep') === currentEpisodeId);
            episodeTitle ||= String(episode?.long_title ?? episode?.title ?? '').trim();
        }
        episodeTitle ||= source.episodeId ?? `ss${pathSeasonId}`;
    }
    return { seriesId, seriesTitle, epTitle: episodeTitle, source };
}

export function formatTime(seconds) {
    const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const remainder = total % 60;
    return `${hours ? `${hours}:` : ''}${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function positionOffset(token, freeSpace, axis) {
    if (token === 'left' || token === 'top') return 0;
    if (token === 'right' || token === 'bottom') return freeSpace;
    if (token === 'center' || !token) return freeSpace / 2;
    if (/^-?\d+(?:\.\d+)?%$/.test(token)) return freeSpace * parseFloat(token) / 100;
    if (/^-?\d+(?:\.\d+)?(?:px)?$/.test(token)) return parseFloat(token);
    return axis === 'x' || axis === 'y' ? freeSpace / 2 : 0;
}

/** Pixel rectangle of the video content, relative to its overlay container. */
export function getContainedRect({ containerRect, mediaRect = containerRect, videoWidth = 0, videoHeight = 0,
    objectFit = 'contain', objectPosition = '50% 50%' } = {}) {
    if (!containerRect || !mediaRect) return null;
    const boxWidth = Number(mediaRect.width);
    const boxHeight = Number(mediaRect.height);
    if (!(boxWidth > 0 && boxHeight > 0)) return null;
    let width = boxWidth;
    let height = boxHeight;
    if (videoWidth > 0 && videoHeight > 0 && objectFit !== 'fill') {
        const containScale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
        const scale = objectFit === 'cover' ? Math.max(boxWidth / videoWidth, boxHeight / videoHeight) :
            objectFit === 'none' ? 1 : objectFit === 'scale-down' ? Math.min(1, containScale) : containScale;
        width = videoWidth * scale;
        height = videoHeight * scale;
    }
    const position = String(objectPosition).trim().split(/\s+/);
    let [x = '50%', y = '50%'] = position;
    if (position.length === 1 && /^(top|bottom)$/.test(x)) [x, y] = ['50%', x];
    if (/^(top|bottom)$/.test(x) && /^(left|right|center)$/.test(y)) [x, y] = [y, x];
    const left = (Number(mediaRect.left) || 0) - (Number(containerRect.left) || 0) + positionOffset(x, boxWidth - width, 'x');
    const top = (Number(mediaRect.top) || 0) - (Number(containerRect.top) || 0) + positionOffset(y, boxHeight - height, 'y');
    return { left, top, width, height, right: left + width, bottom: top + height };
}

function parseJsonScript(text) {
    if (!text || text.length > MAX_JSON_LENGTH) return null;
    const trimmed = text.trim();
    try { return JSON.parse(trimmed); } catch { /* A readable inline state assignment may follow. */ }
    const match = /(?:window\.)?__INITIAL_STATE__\s*=\s*\{/.exec(trimmed);
    if (!match) return null;
    const start = match.index + match[0].lastIndexOf('{');
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i++) {
        const char = trimmed[i];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) {
            try { return JSON.parse(trimmed.slice(start, i + 1)); } catch { return null; }
        }
    }
    return null;
}

export function createPlayerAdapter({ window = globalThis.window, document = window?.document } = {}) {
    if (!window || !document) throw new Error('播放器需要浏览器 window 和 document');
    const listeners = new Set();
    const cleanups = [];
    const waiting = new Set();
    const pendingCaptures = new Set();
    const scriptCache = new WeakMap();
    const mediaBindings = new WeakMap();
    const setTimer = window.setTimeout?.bind(window) ?? globalThis.setTimeout;
    const clearTimer = window.clearTimeout?.bind(window) ?? globalThis.clearTimeout;
    let disposed = false;
    let scheduled = null;
    let recovery = null;
    let recoveryAttempts = 0;
    let lastSnapshot = null;
    let observedHref = window.location.href;
    let pendingResume = null;
    let identityCache = null;
    let identityDirty = true;

    function queryAll(root, selector) {
        try { return Array.from(root?.querySelectorAll?.(selector) ?? []); } catch { return []; }
    }

    function query(root, selector) {
        try { return root?.querySelector?.(selector) ?? null; } catch { return null; }
    }

    function styleOf(element) {
        try { return window.getComputedStyle(element); } catch { return {}; }
    }

    function rectOf(element) {
        try { return element?.getBoundingClientRect?.() ?? null; } catch { return null; }
    }

    function visible(element) {
        if (!element || element.isConnected === false) return false;
        const rect = rectOf(element);
        if (!rect || !(rect.width > 0 && rect.height > 0)) return false;
        const style = styleOf(element);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse';
    }

    function closestContainer(element) {
        for (const selector of PLAYER_SELECTORS) {
            const result = element?.closest?.(selector);
            if (result) return result;
        }
        return element?.parentElement ?? null;
    }

    function collectIdentity() {
        const href = window.location.href;
        if (!normalizeSource(href)) return null;
        let pageState = null;
        try { pageState = window.__INITIAL_STATE__; } catch { /* A readable script tag is enough in isolated sandboxes. */ }
        const title = document.title;
        if (!identityDirty && identityCache?.href === href && identityCache.title === title && identityCache.pageState === pageState) {
            return identityCache.identity;
        }
        let seasonId = null;
        const canonical = query(document, 'link[rel="canonical"]')?.href;
        const canonicalSource = canonical && normalizeSource(canonical, href);
        if (canonicalSource?.sourceId.startsWith('ss:')) seasonId = canonicalSource.sourceId.slice(3);
        if (!seasonId) {
            const metadataLinks = queryAll(document,
                '.media-info a[href*="/bangumi/play/ss"], .media-info-wrap a[href*="/bangumi/play/ss"], ' +
                '.bangumi-info a[href*="/bangumi/play/ss"], .bangumi-header a[href*="/bangumi/play/ss"], ' +
                '[class*="mediaInfo"] a[href*="/bangumi/play/ss"]');
            const ids = new Set(metadataLinks.map(link => normalizeSource(link.href, href)?.sourceId)
                .filter(id => id?.startsWith('ss:')));
            if (ids.size === 1) seasonId = [...ids][0].slice(3);
        }
        const selectedEpisode = query(document,
            'a.ep-item.active, a.ep-item.on, .ep-item.active a, .ep-item.on a, .ep-item.cursor a, .ep-list .active a');
        const episodeId = selectedEpisode && normalizeSource(selectedEpisode.href, href)?.episodeId;
        const selectedLabel = query(document, '.cur-page, .ep-item.cursor, .ep-item.active, .ep-item.on');
        const epTitle = String(selectedLabel?.textContent ?? '').trim().slice(0, 300);
        const options = { url: href, title, seasonId, episodeId, epTitle };
        let best = resolveIdentity(options);
        const states = [];
        if (pageState && typeof pageState === 'object') states.push(pageState);
        for (const script of queryAll(document, 'script')) {
            const content = script.textContent ?? '';
            if (script.type !== 'application/json' && script.id !== '__NEXT_DATA__' && !content.includes('__INITIAL_STATE__')) continue;
            let cached = scriptCache.get(script);
            if (!cached || cached.text !== content) {
                cached = { text: content, value: parseJsonScript(content) };
                scriptCache.set(script, cached);
            }
            if (cached.value) states.push(cached.value);
        }
        for (const state of states) {
            const candidate = resolveIdentity({ ...options, state });
            if (candidate?.seriesId.startsWith('season_') || !best?.seriesId.startsWith('season_')) best = candidate;
        }
        identityCache = { href, title, pageState, identity: best };
        identityDirty = false;
        return best;
    }

    function selectPlayer() {
        const containers = new Set();
        for (const media of queryAll(document, 'video, bwp-video')) {
            const container = closestContainer(media);
            if (container && visible(container)) containers.add(container);
        }
        for (const container of queryAll(document, PLAYER_SELECTOR)) {
            if (visible(container) && query(container, 'canvas')) containers.add(container);
        }
        let selected = null;
        let bestScore = -Infinity;
        for (const container of containers) {
            const allMedia = queryAll(container, 'video, bwp-video');
            const visibleMedia = allMedia.filter(visible);
            const videos = visibleMedia.filter(element => element.tagName?.toLowerCase() === 'video' && element.videoWidth > 0);
            const video = videos.find(element => !element.paused && !element.ended) ?? videos[0];
            const canvas = queryAll(container, 'canvas').find(element => visible(element) && element.width > 0 && element.height > 0);
            const media = (video && typeof video.currentTime === 'number' ? video : null) ??
                visibleMedia.find(element => typeof element.currentTime === 'number' && !element.paused) ??
                visibleMedia.find(element => typeof element.currentTime === 'number') ??
                allMedia.find(element => typeof element.currentTime === 'number' && !element.paused) ??
                allMedia.find(element => typeof element.currentTime === 'number') ?? null;
            const drawable = video ?? canvas ?? null;
            if (!visibleMedia.length && !canvas) continue;
            const rect = rectOf(drawable ?? visibleMedia[0] ?? container);
            const viewportWidth = window.innerWidth || rect.width;
            const viewportHeight = window.innerHeight || rect.height;
            const intersectWidth = Math.max(0, Math.min(rect.right ?? rect.left + rect.width, viewportWidth) - Math.max(rect.left, 0));
            const intersectHeight = Math.max(0, Math.min(rect.bottom ?? rect.top + rect.height, viewportHeight) - Math.max(rect.top, 0));
            let score = Math.log2(1 + rect.width * rect.height) + (intersectWidth * intersectHeight > 0 ? 20 : 0);
            if (media && !media.paused && !media.ended) score += 1;
            if (document.fullscreenElement?.contains?.(container)) score += 100;
            if (container.matches?.(PLAYER_SELECTOR)) score += 20;
            if (score > bestScore) { bestScore = score; selected = { container, media, drawable }; }
        }
        return selected;
    }

    function mediaResource(media) {
        return String(media?.currentSrc || media?.src || media?.getAttribute?.('src') || '');
    }

    function bindSource(player, identity) {
        if (!player.media) return false;
        const sourceId = identity.source.sourceId;
        const routeId = normalizeSource(window.location.href)?.sourceId;
        const resource = mediaResource(player.media);
        let binding = mediaBindings.get(player.media);
        if (!binding) {
            binding = { sourceId, routeId, resource, pending: false };
            mediaBindings.set(player.media, binding);
        } else if (binding.sourceId !== sourceId) {
            // A /ss page can resolve its episode after JSON hydration without changing playback.
            const resolvedSeasonAlias = binding.routeId === routeId && routeId?.startsWith('ss:') &&
                binding.sourceId.startsWith('ss:') && sourceId.startsWith('ep:');
            const changedResourceReady = resource && binding.resource && resource !== binding.resource &&
                typeof player.media.readyState === 'number' && player.media.readyState >= 1;
            if (resolvedSeasonAlias || changedResourceReady) {
                binding.sourceId = sourceId;
                binding.resource = resource;
                binding.pending = false;
            } else binding.pending = true;
            binding.routeId = routeId;
        } else {
            binding.routeId = routeId;
            if (!binding.pending) binding.resource = resource;
        }
        return !binding.pending && binding.sourceId === sourceId;
    }

    function getCurrent() {
        if (disposed) return null;
        const identity = collectIdentity();
        if (!identity) return null;
        const player = selectPlayer();
        return player ? { ...player, identity, sourceReady: bindSource(player, identity) } : null;
    }

    function getTime() {
        const snapshot = getCurrent();
        const time = ready(snapshot) ? snapshot.media?.currentTime : null;
        return Number.isFinite(time) && time >= 0 ? time : null;
    }

    function sameSnapshot(first, second) {
        if (!first || !second) return first === second;
        return first.container === second.container && first.media === second.media && first.drawable === second.drawable &&
            first.identity.source.sourceId === second.identity.source.sourceId && first.identity.seriesId === second.identity.seriesId &&
            first.sourceReady === second.sourceReady;
    }

    function ready(snapshot) {
        const media = snapshot?.media;
        return Boolean(snapshot?.sourceReady && media && typeof media.currentTime === 'number' &&
            (typeof media.readyState === 'number' ? media.readyState >= 1 : Number.isFinite(media.duration) && media.duration > 0));
    }

    function finishWaiter(waiter, error, snapshot) {
        waiting.delete(waiter);
        clearTimer(waiter.timer);
        if (error) waiter.reject(error);
        else waiter.resolve(snapshot);
    }

    function checkWaiters(snapshot) {
        const routeSource = normalizeSource(window.location.href);
        for (const waiter of [...waiting]) {
            const source = snapshot?.identity.source ?? routeSource;
            if (source && source.sourceId !== waiter.sourceId) {
                finishWaiter(waiter, playerError('SOURCE_CHANGED', '播放来源已切换，已取消定位'));
            } else if (snapshot?.identity.source.sourceId === waiter.sourceId && ready(snapshot)) finishWaiter(waiter, null, snapshot);
        }
    }

    function inspect() {
        if (disposed) return;
        clearTimer(scheduled);
        scheduled = null;
        if (observedHref !== window.location.href) {
            observedHref = window.location.href;
            recoveryAttempts = 0;
        }
        const snapshot = getCurrent();
        checkWaiters(snapshot);
        if (!sameSnapshot(lastSnapshot, snapshot)) {
            lastSnapshot = snapshot;
            for (const listener of [...listeners]) {
                try { listener(snapshot); } catch (error) { window.console?.warn?.('[字幕遮罩] 播放器订阅失败', error); }
            }
        }
        if (snapshot) {
            recoveryAttempts = 0;
            clearTimer(recovery);
            recovery = null;
        } else if (!recovery && recoveryAttempts < 10 && normalizeSource(window.location.href)) {
            // Bounded recovery covers delayed initial layout without a permanent polling loop.
            recovery = setTimer(() => { recovery = null; recoveryAttempts++; inspect(); }, 3000);
        }
    }

    function schedule() {
        identityDirty = true;
        if (!disposed && scheduled === null) scheduled = setTimer(inspect, 100);
    }

    function listen(target, type, callback, options) {
        target?.addEventListener?.(type, callback, options);
        cleanups.push(() => target?.removeEventListener?.(type, callback, options));
    }

    function waitForMedia(sourceId) {
        if (disposed) return Promise.reject(playerError('DISPOSED', '播放器已关闭'));
        const snapshot = getCurrent();
        const source = snapshot?.identity.source ?? normalizeSource(window.location.href);
        if (source && source.sourceId !== sourceId) return Promise.reject(playerError('SOURCE_CHANGED', '播放来源已切换，已取消定位'));
        if (snapshot?.identity.source.sourceId === sourceId && ready(snapshot)) return Promise.resolve(snapshot);
        return new Promise((resolve, reject) => {
            const waiter = { sourceId, resolve, reject, timer: null };
            waiter.timer = setTimer(() => finishWaiter(waiter, playerError('MEDIA_TIMEOUT', '播放器尚未就绪，请稍后重试定位')), 15000);
            waiting.add(waiter);
            schedule();
        });
    }

    async function capture() {
        const snapshot = getCurrent();
        if (!snapshot) throw playerError('PLAYER_UNAVAILABLE', '未找到当前视频播放器');
        const time = snapshot.media?.currentTime;
        if (!Number.isFinite(time) || time < 0) throw playerError('TIME_UNAVAILABLE', '当前播放器无法提供可靠的时间戳');
        if (!snapshot.sourceReady) throw playerError('SOURCE_NOT_READY', '视频正在切换，请画面就绪后再收藏');
        if (!ready(snapshot)) throw playerError('TIME_UNAVAILABLE', '播放器尚未就绪，请稍后收藏');
        const drawable = snapshot.drawable;
        if (!drawable) throw playerError('FRAME_UNAVAILABLE', '当前播放器暂不支持截图，可保存时间书签');
        if (drawable.tagName?.toLowerCase() === 'video' && typeof drawable.readyState === 'number' && drawable.readyState < 2) {
            throw playerError('FRAME_UNAVAILABLE', '当前视频画面尚未就绪，可保存时间书签');
        }
        const sourceWidth = drawable.videoWidth || drawable.width;
        const sourceHeight = drawable.videoHeight || drawable.height;
        if (!(sourceWidth > 0 && sourceHeight > 0)) throw playerError('FRAME_UNAVAILABLE', '当前视频画面尚未就绪');
        const scale = Math.min(1, 960 / sourceWidth);
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        try {
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Canvas 2D context unavailable');
            context.drawImage(drawable, 0, 0, width, height);
            const imageBlob = await new Promise((resolve, reject) => {
                const pending = { timer: null, cancel: null };
                const finish = (error, blob) => {
                    if (!pendingCaptures.delete(pending)) return;
                    clearTimer(pending.timer);
                    if (error) reject(error);
                    else resolve(blob);
                };
                pending.cancel = () => finish(playerError('DISPOSED', '播放器已关闭'));
                pendingCaptures.add(pending);
                pending.timer = setTimer(() => finish(playerError('CAPTURE_TIMEOUT', '截图编码超时，可改存时间书签')), 10000);
                try {
                    canvas.toBlob(blob => {
                        if (blob) finish(null, blob);
                        else finish(playerError('CAPTURE_FAILED', '浏览器未能生成截图，可改存时间书签'));
                    }, 'image/jpeg', 0.85);
                } catch (error) { finish(error); }
            });
            if (disposed) throw playerError('DISPOSED', '播放器已关闭');
            return { imageBlob, width, height, time, identity: snapshot.identity };
        } catch (error) {
            if (typeof error.code === 'string') throw error;
            throw playerError('CAPTURE_FAILED', '当前画面无法截图，可保存时间书签', error);
        }
    }

    function noteSource(note) {
        return normalizeSource(note?.source ?? note?.identity?.source ?? note?.url);
    }

    async function setTime(source, seconds) {
        const snapshot = await waitForMedia(source.sourceId);
        const current = getCurrent();
        if (!current || !current.sourceReady || current.identity.source.sourceId !== source.sourceId || current.media !== snapshot.media) {
            throw playerError('SOURCE_CHANGED', '播放来源已切换，已取消定位');
        }
        const duration = current.media.duration;
        const target = Number.isFinite(duration) && duration > 0 ? Math.min(seconds, Math.max(0, duration - 0.05)) : seconds;
        try { current.media.currentTime = Math.max(0, target); }
        catch (error) { throw playerError('SEEK_FAILED', '当前播放器暂时无法定位，请稍后重试', error); }
    }

    async function seek(note, { leadIn = 3 } = {}) {
        const source = noteSource(note);
        if (!source) throw playerError('SOURCE_UNAVAILABLE', '这条笔记没有可靠的播放来源，无法自动定位');
        if (!Number.isFinite(note?.time) || note.time < 0) throw playerError('INVALID_TIME', '笔记时间戳无效');
        if (disposed) throw playerError('DISPOSED', '播放器已关闭');
        const seconds = Math.max(0, note.time - (Number.isFinite(leadIn) ? Math.max(0, leadIn) : 3));
        const current = getCurrent()?.identity.source ?? normalizeSource(window.location.href);
        if (current?.sourceId === source.sourceId) {
            await setTime(source, seconds);
            return { navigated: false };
        }
        const destination = new URL(source.url);
        destination.searchParams.set(SEEK_PARAM, String(seconds));
        destination.searchParams.set(SOURCE_PARAM, source.sourceId);
        window.location.assign(destination.href);
        return { navigated: true };
    }

    function clearPendingParams() {
        const cleaned = new URL(window.location.href);
        cleaned.searchParams.delete(SEEK_PARAM);
        cleaned.searchParams.delete(SOURCE_PARAM);
        window.history?.replaceState?.(window.history.state, '', cleaned.href);
    }

    function resumePendingSeek() {
        if (pendingResume) return pendingResume;
        let parsed;
        try { parsed = new URL(window.location.href); } catch { return Promise.resolve({ resumed: false }); }
        if (!parsed.searchParams.has(SEEK_PARAM)) return Promise.resolve({ resumed: false });
        const seconds = Number(parsed.searchParams.get(SEEK_PARAM));
        const source = normalizeSource(parsed.href);
        if (!source || !Number.isFinite(seconds) || seconds < 0 || !parsed.searchParams.get(SEEK_PARAM)?.trim() ||
            parsed.searchParams.get(SOURCE_PARAM) !== source.sourceId) {
            clearPendingParams();
            return Promise.resolve({ resumed: false, reason: 'invalid-source-or-time' });
        }
        pendingResume = setTime(source, seconds).then(() => {
            clearPendingParams();
            return { resumed: true };
        }).finally(() => { pendingResume = null; });
        return pendingResume;
    }

    function getVideoRect() {
        const snapshot = getCurrent();
        if (!snapshot) return null;
        const element = visible(snapshot.drawable) ? snapshot.drawable : visible(snapshot.media) ? snapshot.media : snapshot.container;
        const style = styleOf(element);
        const naturalWidth = element.videoWidth || element.width || snapshot.media?.videoWidth || 0;
        const naturalHeight = element.videoHeight || element.height || snapshot.media?.videoHeight || 0;
        return getContainedRect({
            containerRect: rectOf(snapshot.container), mediaRect: rectOf(element),
            videoWidth: naturalWidth, videoHeight: naturalHeight,
            objectFit: style.objectFit || 'contain', objectPosition: style.objectPosition || '50% 50%'
        });
    }

    function subscribe(callback) {
        if (typeof callback !== 'function') throw new TypeError('subscribe 需要一个函数');
        if (disposed) return () => {};
        listeners.add(callback);
        callback(getCurrent());
        return () => listeners.delete(callback);
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        clearTimer(scheduled);
        clearTimer(recovery);
        for (const cleanup of cleanups.splice(0)) cleanup();
        for (const waiter of [...waiting]) finishWaiter(waiter, playerError('DISPOSED', '播放器已关闭'));
        for (const pending of [...pendingCaptures]) pending.cancel();
        listeners.clear();
        lastSnapshot = null;
        identityCache = null;
    }

    for (const type of ['popstate', 'hashchange', 'resize']) listen(window, type, schedule);
    for (const type of ['loadedmetadata', 'loadeddata']) listen(document, type, event => {
        const snapshot = getCurrent();
        if (snapshot?.media && (event.target === snapshot.media || snapshot.container.contains?.(event.target))) {
            mediaBindings.set(snapshot.media, {
                sourceId: snapshot.identity.source.sourceId,
                routeId: normalizeSource(window.location.href)?.sourceId,
                resource: mediaResource(snapshot.media), pending: false
            });
        }
        schedule();
    }, true);
    for (const type of ['emptied', 'play', 'durationchange', 'fullscreenchange', 'visibilitychange']) listen(document, type, schedule, true);
    const observer = window.MutationObserver ? new window.MutationObserver(schedule) : null;
    let observerStarted = false;
    function observeRoot() {
        const root = document.documentElement || document.body;
        if (observer && root && !observerStarted) {
            observer.observe(root, { childList: true, subtree: true });
            observerStarted = true;
        }
    }
    observeRoot();
    if (observer) cleanups.push(() => observer.disconnect());
    listen(document, 'DOMContentLoaded', () => { observeRoot(); schedule(); });
    // Keep native History behavior and restore only wrappers still owned by this instance.
    for (const method of ['pushState', 'replaceState']) {
        const original = window.history?.[method];
        if (typeof original !== 'function') continue;
        const wrapped = function (...args) {
            const result = original.apply(this, args);
            schedule();
            return result;
        };
        try {
            window.history[method] = wrapped;
            cleanups.push(() => { if (window.history[method] === wrapped) window.history[method] = original; });
        } catch { /* Read-only host objects still have DOM and media event recovery. */ }
    }
    inspect();
    return { getCurrent, getTime, capture, seek, resumePendingSeek, getVideoRect, subscribe, dispose };
}
