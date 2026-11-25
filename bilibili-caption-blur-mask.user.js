// ==UserScript==
// @name         Bilibili 剧集双语字幕羽化遮罩与生词本 (看剧学英语)
// @namespace    https://github.com/CaptionNoChinese
// @version      3.0.1
// @description  中文字幕遮罩、单键静默记录、按集整理备注，以及 JSON、Markdown 和 HTML 导出。
// @author       black-customer
// @homepageURL  https://github.com/black-customer/CaptionNoChinese
// @supportURL   https://github.com/black-customer/CaptionNoChinese/issues
// @updateURL    https://raw.githubusercontent.com/black-customer/CaptionNoChinese/main/bilibili-caption-blur-mask.user.js
// @downloadURL  https://raw.githubusercontent.com/black-customer/CaptionNoChinese/main/bilibili-caption-blur-mask.user.js
// @match        *://*.bilibili.com/*
// @match        *://bilibili.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==
(() => {
  // src/player.js
  var PLAYER_SELECTORS = [
    ".bpx-player-video-wrap",
    ".squirtle-video-wrap",
    ".bilibili-player-video-wrap",
    ".bilibili-player-video",
    ".bpx-player-video-area",
    "#playerWrap",
    "#player_module",
    "#bilibiliPlayer",
    "#bofqi"
  ];
  var PLAYER_SELECTOR = PLAYER_SELECTORS.join(",");
  var SEEK_PARAM = "bcm_seek";
  var SOURCE_PARAM = "bcm_source";
  var MAX_JSON_LENGTH = 2e6;
  function playerError(code, message, cause) {
    const error = new Error(message);
    error.code = code;
    if (cause) error.cause = cause;
    return error;
  }
  function numericId(value, prefix) {
    const raw = String(value ?? "").replace(new RegExp(`^(?:${prefix}|${prefix === "ss" ? "season_" : "episode_"})`), "");
    return /^[1-9]\d*$/.test(raw) ? raw : null;
  }
  function validPage(value) {
    const page = value == null || value === "" ? 1 : Number(value);
    return Number.isSafeInteger(page) && page > 0 ? page : null;
  }
  function normalizeSource(value, baseUrl = "https://www.bilibili.com/") {
    const supplied = typeof value === "string" ? { url: value } : value;
    if (!supplied || typeof supplied !== "object") return null;
    let inputUrl = supplied.url;
    if (!inputUrl) {
      if (/^BV[0-9A-Za-z]{10}$/.test(supplied.videoId ?? "")) {
        const page = validPage(supplied.page);
        if (!page) return null;
        inputUrl = `https://www.bilibili.com/video/${supplied.videoId}/?p=${page}`;
      } else {
        const ep = numericId(supplied.episodeId, "ep");
        if (ep) inputUrl = `https://www.bilibili.com/bangumi/play/ep${ep}`;
      }
    }
    if (typeof inputUrl !== "string") return null;
    let parsed;
    try {
      parsed = new URL(inputUrl, baseUrl);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(parsed.protocol) || !/(^|\.)bilibili\.com$/i.test(parsed.hostname) || parsed.username || parsed.password || parsed.port) return null;
    const videoMatch = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})\/?$/);
    const episodeMatch = parsed.pathname.match(/^\/bangumi\/play\/(ep|ss)([1-9]\d*)\/?$/);
    let source;
    if (videoMatch) {
      const page = validPage(parsed.searchParams.get("p"));
      if (!page) return null;
      const videoId = videoMatch[1];
      source = {
        url: `https://www.bilibili.com/video/${videoId}/${page > 1 ? `?p=${page}` : ""}`,
        videoId,
        episodeId: null,
        page,
        sourceId: `bv:${videoId}:p:${page}`
      };
    } else if (episodeMatch) {
      const [, kind, id] = episodeMatch;
      source = {
        url: `https://www.bilibili.com/bangumi/play/${kind}${id}`,
        videoId: null,
        episodeId: kind === "ep" ? `ep${id}` : null,
        page: 1,
        sourceId: `${kind}:${id}`
      };
    } else return null;
    if (supplied.videoId != null && supplied.videoId !== source.videoId) return null;
    if (supplied.episodeId != null && `ep${numericId(supplied.episodeId, "ep")}` !== source.episodeId) return null;
    if (supplied.page != null && validPage(supplied.page) !== source.page) return null;
    if (supplied.sourceId != null && supplied.sourceId !== source.sourceId) return null;
    return source;
  }
  function cleanTitle(title) {
    return String(title ?? "").replace(/-(?:电视剧|番剧|国创|电影|纪录片|综艺)-全集.*$/, "").replace(/-高清正版在线观看.*$/, "").replace(/_哔哩哔哩(?:_bilibili)?.*$/, "").trim();
  }
  function unwrapState(state) {
    return state?.props?.pageProps?.initialState ?? state?.props?.pageProps?.__INITIAL_STATE__ ?? state?.props?.pageProps ?? state?.initialState ?? state?.__INITIAL_STATE__ ?? state ?? {};
  }
  function readHydratedSeason(data, source) {
    const queries = data.dehydratedState?.queries;
    if (!Array.isArray(queries)) return null;
    const [kind, id] = source.sourceId.split(":");
    const parameter = kind === "ep" ? "ep_id" : "season_id";
    const match = queries.find((query) => query?.queryKey?.[0] === "pgc/view/web/simple/season" && String(query.queryKey[1]?.[parameter]) === id);
    const season = match?.state?.data;
    return numericId(season?.season_id, "ss") ? season : null;
  }
  function resolveIdentity({ url, title = "", state = null, seasonId = null, episodeId = null, epTitle = "" } = {}) {
    let source = normalizeSource(url);
    if (!source) return null;
    const data = unwrapState(state);
    const info = data.epInfo ?? data.ep_info ?? {};
    const stateEpisodeId = numericId(info.id ?? info.ep_id ?? info.epid, "ep");
    const stateSeasonId = numericId(data.mediaInfo?.season_id ?? data.seasonInfo?.season_id ?? data.season_id, "ss");
    const explicitSeasonId = numericId(seasonId, "ss");
    let seriesTitle2 = cleanTitle(title) || "未命名视频";
    let episodeTitle2 = String(epTitle ?? "").trim();
    let seriesId;
    if (source.videoId) {
      seriesId = `bv_${source.videoId}`;
      const videoData = data.videoData ?? {};
      if (videoData.bvid === source.videoId) {
        seriesTitle2 = cleanTitle(videoData.title) || seriesTitle2;
        const part = Array.isArray(videoData.pages) ? videoData.pages.find((item) => item.page === source.page) : null;
        episodeTitle2 ||= String(part?.part ?? "").trim();
      }
      episodeTitle2 ||= `P${source.page}`;
    } else {
      const pathSeasonId = source.sourceId.startsWith("ss:") ? source.sourceId.slice(3) : null;
      if (pathSeasonId) {
        const selectedEpisode = numericId(episodeId, "ep") || (stateSeasonId === pathSeasonId ? stateEpisodeId : null);
        if (selectedEpisode) source = normalizeSource({ episodeId: selectedEpisode });
      }
      const currentEpisodeId = numericId(source.episodeId, "ep");
      const listedEpisodes = Array.isArray(data.epList) ? data.epList : [];
      const stateMatches = currentEpisodeId ? stateEpisodeId === currentEpisodeId || listedEpisodes.some((item) => numericId(item.id ?? item.ep_id, "ep") === currentEpisodeId) : pathSeasonId === stateSeasonId;
      const hydratedSeason = readHydratedSeason(data, source);
      const hydratedSeasonId = numericId(hydratedSeason?.season_id, "ss");
      const season = pathSeasonId || explicitSeasonId || (stateMatches ? stateSeasonId : null) || hydratedSeasonId;
      seriesId = season ? `season_${season}` : `bgm_${source.episodeId}`;
      if (stateMatches) {
        seriesTitle2 = cleanTitle(data.mediaInfo?.title ?? data.seasonInfo?.title) || seriesTitle2;
        const episode = stateEpisodeId === currentEpisodeId ? info : listedEpisodes.find((item) => numericId(item.id ?? item.ep_id, "ep") === currentEpisodeId);
        episodeTitle2 ||= String(episode?.long_title ?? episode?.title ?? "").trim();
      }
      if (hydratedSeason && hydratedSeasonId === season) {
        const hydratedTitle = cleanTitle(hydratedSeason.title || hydratedSeason.season_title);
        if (hydratedTitle) {
          if (seriesTitle2.startsWith(hydratedTitle)) episodeTitle2 ||= seriesTitle2.slice(hydratedTitle.length).trim();
          seriesTitle2 = hydratedTitle;
        }
      }
      episodeTitle2 ||= source.episodeId ?? `ss${pathSeasonId}`;
    }
    return { seriesId, seriesTitle: seriesTitle2, epTitle: episodeTitle2, source };
  }
  function formatTime(seconds) {
    const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const remainder = total % 60;
    return `${hours ? `${hours}:` : ""}${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  }
  function positionOffset(token, freeSpace, axis) {
    if (token === "left" || token === "top") return 0;
    if (token === "right" || token === "bottom") return freeSpace;
    if (token === "center" || !token) return freeSpace / 2;
    if (/^-?\d+(?:\.\d+)?%$/.test(token)) return freeSpace * parseFloat(token) / 100;
    if (/^-?\d+(?:\.\d+)?(?:px)?$/.test(token)) return parseFloat(token);
    return axis === "x" || axis === "y" ? freeSpace / 2 : 0;
  }
  function getContainedRect({
    containerRect,
    mediaRect = containerRect,
    videoWidth = 0,
    videoHeight = 0,
    objectFit = "contain",
    objectPosition = "50% 50%"
  } = {}) {
    if (!containerRect || !mediaRect) return null;
    const boxWidth = Number(mediaRect.width);
    const boxHeight = Number(mediaRect.height);
    if (!(boxWidth > 0 && boxHeight > 0)) return null;
    let width = boxWidth;
    let height = boxHeight;
    if (videoWidth > 0 && videoHeight > 0 && objectFit !== "fill") {
      const containScale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
      const scale = objectFit === "cover" ? Math.max(boxWidth / videoWidth, boxHeight / videoHeight) : objectFit === "none" ? 1 : objectFit === "scale-down" ? Math.min(1, containScale) : containScale;
      width = videoWidth * scale;
      height = videoHeight * scale;
    }
    const position = String(objectPosition).trim().split(/\s+/);
    let [x = "50%", y = "50%"] = position;
    if (position.length === 1 && /^(top|bottom)$/.test(x)) [x, y] = ["50%", x];
    if (/^(top|bottom)$/.test(x) && /^(left|right|center)$/.test(y)) [x, y] = [y, x];
    const left = (Number(mediaRect.left) || 0) - (Number(containerRect.left) || 0) + positionOffset(x, boxWidth - width, "x");
    const top = (Number(mediaRect.top) || 0) - (Number(containerRect.top) || 0) + positionOffset(y, boxHeight - height, "y");
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  function parseJsonScript(text2) {
    if (!text2 || text2.length > MAX_JSON_LENGTH) return null;
    const trimmed = text2.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
    }
    const match = /(?:window\.)?__INITIAL_STATE__\s*=\s*\{/.exec(trimmed);
    if (!match) return null;
    const start2 = match.index + match[0].lastIndexOf("{");
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start2; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        try {
          return JSON.parse(trimmed.slice(start2, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  function createPlayerAdapter({ window: window2 = globalThis.window, document: document2 = window2?.document } = {}) {
    if (!window2 || !document2) throw new Error("播放器需要浏览器 window 和 document");
    const listeners = /* @__PURE__ */ new Set();
    const cleanups = [];
    const waiting = /* @__PURE__ */ new Set();
    const pendingCaptures = /* @__PURE__ */ new Set();
    const scriptCache = /* @__PURE__ */ new WeakMap();
    const mediaBindings = /* @__PURE__ */ new WeakMap();
    const setTimer = window2.setTimeout?.bind(window2) ?? globalThis.setTimeout;
    const clearTimer = window2.clearTimeout?.bind(window2) ?? globalThis.clearTimeout;
    let disposed = false;
    let scheduled = null;
    let recovery = null;
    let recoveryAttempts = 0;
    let lastSnapshot = null;
    let observedHref = window2.location.href;
    let pendingResume = null;
    let identityCache = null;
    let identityDirty = true;
    function queryAll(root, selector) {
      try {
        return Array.from(root?.querySelectorAll?.(selector) ?? []);
      } catch {
        return [];
      }
    }
    function query(root, selector) {
      try {
        return root?.querySelector?.(selector) ?? null;
      } catch {
        return null;
      }
    }
    function styleOf(element) {
      try {
        return window2.getComputedStyle(element);
      } catch {
        return {};
      }
    }
    function rectOf(element) {
      try {
        return element?.getBoundingClientRect?.() ?? null;
      } catch {
        return null;
      }
    }
    function visible(element) {
      if (!element || element.isConnected === false) return false;
      const rect = rectOf(element);
      if (!rect || !(rect.width > 0 && rect.height > 0)) return false;
      const style = styleOf(element);
      return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
    }
    function closestContainer(element) {
      for (const selector of PLAYER_SELECTORS) {
        const result = element?.closest?.(selector);
        if (result) return result;
      }
      return element?.parentElement ?? null;
    }
    function collectIdentity() {
      const href = window2.location.href;
      if (!normalizeSource(href)) return null;
      let pageState = null;
      try {
        pageState = window2.__INITIAL_STATE__;
      } catch {
      }
      const title = document2.title;
      if (!identityDirty && identityCache?.href === href && identityCache.title === title && identityCache.pageState === pageState) {
        return identityCache.identity;
      }
      let seasonId = null;
      const canonical = query(document2, 'link[rel="canonical"]')?.href;
      const canonicalSource = canonical && normalizeSource(canonical, href);
      if (canonicalSource?.sourceId.startsWith("ss:")) seasonId = canonicalSource.sourceId.slice(3);
      if (!seasonId) {
        const metadataLinks = queryAll(
          document2,
          '.media-info a[href*="/bangumi/play/ss"], .media-info-wrap a[href*="/bangumi/play/ss"], .bangumi-info a[href*="/bangumi/play/ss"], .bangumi-header a[href*="/bangumi/play/ss"], [class*="mediaInfo"] a[href*="/bangumi/play/ss"]'
        );
        const ids = new Set(metadataLinks.map((link) => normalizeSource(link.href, href)?.sourceId).filter((id) => id?.startsWith("ss:")));
        if (ids.size === 1) seasonId = [...ids][0].slice(3);
      }
      const selectedEpisode = query(
        document2,
        "a.ep-item.active, a.ep-item.on, .ep-item.active a, .ep-item.on a, .ep-item.cursor a, .ep-list .active a"
      );
      const episodeId = selectedEpisode && normalizeSource(selectedEpisode.href, href)?.episodeId;
      const selectedLabel = query(document2, ".cur-page, .ep-item.cursor, .ep-item.active, .ep-item.on");
      const epTitle = String(selectedLabel?.textContent ?? "").trim().slice(0, 300);
      const options = { url: href, title, seasonId, episodeId, epTitle };
      let best = resolveIdentity(options);
      const states = [];
      if (pageState && typeof pageState === "object") states.push(pageState);
      for (const script of queryAll(document2, "script")) {
        const content = script.textContent ?? "";
        if (script.type !== "application/json" && script.id !== "__NEXT_DATA__" && !content.includes("__INITIAL_STATE__")) continue;
        let cached = scriptCache.get(script);
        if (!cached || cached.text !== content) {
          cached = { text: content, value: parseJsonScript(content) };
          scriptCache.set(script, cached);
        }
        if (cached.value) states.push(cached.value);
      }
      for (const state of states) {
        const candidate = resolveIdentity({ ...options, state });
        if (candidate?.seriesId.startsWith("season_") || !best?.seriesId.startsWith("season_")) best = candidate;
      }
      identityCache = { href, title, pageState, identity: best };
      identityDirty = false;
      return best;
    }
    function selectPlayer() {
      const containers = /* @__PURE__ */ new Set();
      for (const media of queryAll(document2, "video, bwp-video")) {
        const container = closestContainer(media);
        if (container && visible(container)) containers.add(container);
      }
      for (const container of queryAll(document2, PLAYER_SELECTOR)) {
        if (visible(container) && query(container, "canvas")) containers.add(container);
      }
      let selected = null;
      let bestScore = -Infinity;
      for (const container of containers) {
        const allMedia = queryAll(container, "video, bwp-video");
        const visibleMedia = allMedia.filter(visible);
        const videos = visibleMedia.filter((element) => element.tagName?.toLowerCase() === "video" && element.videoWidth > 0);
        const video = videos.find((element) => !element.paused && !element.ended) ?? videos[0];
        const canvas = queryAll(container, "canvas").find((element) => visible(element) && element.width > 0 && element.height > 0);
        const media = (video && typeof video.currentTime === "number" ? video : null) ?? visibleMedia.find((element) => typeof element.currentTime === "number" && !element.paused) ?? visibleMedia.find((element) => typeof element.currentTime === "number") ?? allMedia.find((element) => typeof element.currentTime === "number" && !element.paused) ?? allMedia.find((element) => typeof element.currentTime === "number") ?? null;
        const drawable = video ?? canvas ?? null;
        if (!visibleMedia.length && !canvas) continue;
        const rect = rectOf(drawable ?? visibleMedia[0] ?? container);
        const viewportWidth = window2.innerWidth || rect.width;
        const viewportHeight = window2.innerHeight || rect.height;
        const intersectWidth = Math.max(0, Math.min(rect.right ?? rect.left + rect.width, viewportWidth) - Math.max(rect.left, 0));
        const intersectHeight = Math.max(0, Math.min(rect.bottom ?? rect.top + rect.height, viewportHeight) - Math.max(rect.top, 0));
        let score = Math.log2(1 + rect.width * rect.height) + (intersectWidth * intersectHeight > 0 ? 20 : 0);
        if (media && !media.paused && !media.ended) score += 1;
        if (document2.fullscreenElement?.contains?.(container)) score += 100;
        if (container.matches?.(PLAYER_SELECTOR)) score += 20;
        if (score > bestScore) {
          bestScore = score;
          selected = { container, media, drawable };
        }
      }
      return selected;
    }
    function mediaResource(media) {
      return String(media?.currentSrc || media?.src || media?.getAttribute?.("src") || "");
    }
    function bindSource(player, identity) {
      if (!player.media) return false;
      const sourceId = identity.source.sourceId;
      const routeId = normalizeSource(window2.location.href)?.sourceId;
      const resource = mediaResource(player.media);
      let binding = mediaBindings.get(player.media);
      if (!binding) {
        binding = { sourceId, routeId, resource, pending: false };
        mediaBindings.set(player.media, binding);
      } else if (binding.sourceId !== sourceId) {
        const resolvedSeasonAlias = binding.routeId === routeId && routeId?.startsWith("ss:") && binding.sourceId.startsWith("ss:") && sourceId.startsWith("ep:");
        const changedResourceReady = resource && binding.resource && resource !== binding.resource && typeof player.media.readyState === "number" && player.media.readyState >= 1;
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
      return first.container === second.container && first.media === second.media && first.drawable === second.drawable && first.identity.source.sourceId === second.identity.source.sourceId && first.identity.seriesId === second.identity.seriesId && first.sourceReady === second.sourceReady;
    }
    function ready(snapshot) {
      const media = snapshot?.media;
      return Boolean(snapshot?.sourceReady && media && typeof media.currentTime === "number" && (typeof media.readyState === "number" ? media.readyState >= 1 : Number.isFinite(media.duration) && media.duration > 0));
    }
    function finishWaiter(waiter, error, snapshot) {
      waiting.delete(waiter);
      clearTimer(waiter.timer);
      if (error) waiter.reject(error);
      else waiter.resolve(snapshot);
    }
    function checkWaiters(snapshot) {
      const routeSource = normalizeSource(window2.location.href);
      for (const waiter of [...waiting]) {
        const source = snapshot?.identity.source ?? routeSource;
        if (source && source.sourceId !== waiter.sourceId) {
          finishWaiter(waiter, playerError("SOURCE_CHANGED", "播放来源已切换，已取消定位"));
        } else if (snapshot?.identity.source.sourceId === waiter.sourceId && ready(snapshot)) finishWaiter(waiter, null, snapshot);
      }
    }
    function inspect() {
      if (disposed) return;
      clearTimer(scheduled);
      scheduled = null;
      if (observedHref !== window2.location.href) {
        observedHref = window2.location.href;
        recoveryAttempts = 0;
      }
      const snapshot = getCurrent();
      checkWaiters(snapshot);
      if (!sameSnapshot(lastSnapshot, snapshot)) {
        lastSnapshot = snapshot;
        for (const listener of [...listeners]) {
          try {
            listener(snapshot);
          } catch (error) {
            window2.console?.warn?.("[字幕遮罩] 播放器订阅失败", error);
          }
        }
      }
      if (snapshot) {
        recoveryAttempts = 0;
        clearTimer(recovery);
        recovery = null;
      } else if (!recovery && recoveryAttempts < 10 && normalizeSource(window2.location.href)) {
        recovery = setTimer(() => {
          recovery = null;
          recoveryAttempts++;
          inspect();
        }, 3e3);
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
      if (disposed) return Promise.reject(playerError("DISPOSED", "播放器已关闭"));
      const snapshot = getCurrent();
      const source = snapshot?.identity.source ?? normalizeSource(window2.location.href);
      if (source && source.sourceId !== sourceId) return Promise.reject(playerError("SOURCE_CHANGED", "播放来源已切换，已取消定位"));
      if (snapshot?.identity.source.sourceId === sourceId && ready(snapshot)) return Promise.resolve(snapshot);
      return new Promise((resolve, reject) => {
        const waiter = { sourceId, resolve, reject, timer: null };
        waiter.timer = setTimer(() => finishWaiter(waiter, playerError("MEDIA_TIMEOUT", "播放器尚未就绪，请稍后重试定位")), 15e3);
        waiting.add(waiter);
        schedule();
      });
    }
    async function capture() {
      const snapshot = getCurrent();
      if (!snapshot) throw playerError("PLAYER_UNAVAILABLE", "未找到当前视频播放器");
      const time = snapshot.media?.currentTime;
      if (!Number.isFinite(time) || time < 0) throw playerError("TIME_UNAVAILABLE", "当前播放器无法提供可靠的时间戳");
      if (!snapshot.sourceReady) throw playerError("SOURCE_NOT_READY", "视频正在切换，请画面就绪后再收藏");
      if (!ready(snapshot)) throw playerError("TIME_UNAVAILABLE", "播放器尚未就绪，请稍后收藏");
      const drawable = snapshot.drawable;
      if (!drawable) throw playerError("FRAME_UNAVAILABLE", "当前播放器暂不支持截图，可保存时间书签");
      if (drawable.tagName?.toLowerCase() === "video" && typeof drawable.readyState === "number" && drawable.readyState < 2) {
        throw playerError("FRAME_UNAVAILABLE", "当前视频画面尚未就绪，可保存时间书签");
      }
      const sourceWidth = drawable.videoWidth || drawable.width;
      const sourceHeight = drawable.videoHeight || drawable.height;
      if (!(sourceWidth > 0 && sourceHeight > 0)) throw playerError("FRAME_UNAVAILABLE", "当前视频画面尚未就绪");
      const scale = Math.min(1, 960 / sourceWidth);
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      const canvas = document2.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      try {
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D context unavailable");
        context.drawImage(drawable, 0, 0, width, height);
        const imageBlob = await new Promise((resolve, reject) => {
          const pending = { timer: null, cancel: null };
          const finish = (error, blob) => {
            if (!pendingCaptures.delete(pending)) return;
            clearTimer(pending.timer);
            if (error) reject(error);
            else resolve(blob);
          };
          pending.cancel = () => finish(playerError("DISPOSED", "播放器已关闭"));
          pendingCaptures.add(pending);
          pending.timer = setTimer(() => finish(playerError("CAPTURE_TIMEOUT", "截图编码超时，可改存时间书签")), 1e4);
          try {
            canvas.toBlob((blob) => {
              if (blob) finish(null, blob);
              else finish(playerError("CAPTURE_FAILED", "浏览器未能生成截图，可改存时间书签"));
            }, "image/jpeg", 0.85);
          } catch (error) {
            finish(error);
          }
        });
        if (disposed) throw playerError("DISPOSED", "播放器已关闭");
        return { imageBlob, width, height, time, identity: snapshot.identity };
      } catch (error) {
        if (typeof error.code === "string") throw error;
        throw playerError("CAPTURE_FAILED", "当前画面无法截图，可保存时间书签", error);
      }
    }
    function noteSource(note) {
      const source = note?.source ?? note?.identity?.source ?? note?.url;
      return normalizeSource(source) || !source?.sourceId && normalizeSource(source?.url);
    }
    async function setTime(source, seconds) {
      const snapshot = await waitForMedia(source.sourceId);
      const current = getCurrent();
      if (!current || !current.sourceReady || current.identity.source.sourceId !== source.sourceId || current.media !== snapshot.media) {
        throw playerError("SOURCE_CHANGED", "播放来源已切换，已取消定位");
      }
      const duration = current.media.duration;
      const target = Number.isFinite(duration) && duration > 0 ? Math.min(seconds, Math.max(0, duration - 0.05)) : seconds;
      try {
        current.media.currentTime = Math.max(0, target);
      } catch (error) {
        throw playerError("SEEK_FAILED", "当前播放器暂时无法定位，请稍后重试", error);
      }
    }
    async function seek(note, { leadIn = 3 } = {}) {
      const source = noteSource(note);
      if (!source) throw playerError("SOURCE_UNAVAILABLE", "这条笔记没有可靠的播放来源，无法自动定位");
      if (!Number.isFinite(note?.time) || note.time < 0) throw playerError("INVALID_TIME", "笔记时间戳无效");
      if (disposed) throw playerError("DISPOSED", "播放器已关闭");
      const seconds = Math.max(0, note.time - (Number.isFinite(leadIn) ? Math.max(0, leadIn) : 3));
      const current = getCurrent()?.identity.source ?? normalizeSource(window2.location.href);
      if (current?.sourceId === source.sourceId) {
        await setTime(source, seconds);
        return { navigated: false };
      }
      const destination = new URL(source.url);
      destination.searchParams.set(SEEK_PARAM, String(seconds));
      destination.searchParams.set(SOURCE_PARAM, source.sourceId);
      window2.location.assign(destination.href);
      return { navigated: true };
    }
    function clearPendingParams() {
      const cleaned = new URL(window2.location.href);
      cleaned.searchParams.delete(SEEK_PARAM);
      cleaned.searchParams.delete(SOURCE_PARAM);
      window2.history?.replaceState?.(window2.history.state, "", cleaned.href);
    }
    function resumePendingSeek() {
      if (pendingResume) return pendingResume;
      let parsed;
      try {
        parsed = new URL(window2.location.href);
      } catch {
        return Promise.resolve({ resumed: false });
      }
      if (!parsed.searchParams.has(SEEK_PARAM)) return Promise.resolve({ resumed: false });
      const seconds = Number(parsed.searchParams.get(SEEK_PARAM));
      const source = normalizeSource(parsed.href);
      if (!source || !Number.isFinite(seconds) || seconds < 0 || !parsed.searchParams.get(SEEK_PARAM)?.trim() || parsed.searchParams.get(SOURCE_PARAM) !== source.sourceId) {
        clearPendingParams();
        return Promise.resolve({ resumed: false, reason: "invalid-source-or-time" });
      }
      pendingResume = setTime(source, seconds).then(() => {
        clearPendingParams();
        return { resumed: true };
      }).finally(() => {
        pendingResume = null;
      });
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
        containerRect: rectOf(snapshot.container),
        mediaRect: rectOf(element),
        videoWidth: naturalWidth,
        videoHeight: naturalHeight,
        objectFit: style.objectFit || "contain",
        objectPosition: style.objectPosition || "50% 50%"
      });
    }
    function subscribe(callback) {
      if (typeof callback !== "function") throw new TypeError("subscribe 需要一个函数");
      if (disposed) return () => {
      };
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
      for (const waiter of [...waiting]) finishWaiter(waiter, playerError("DISPOSED", "播放器已关闭"));
      for (const pending of [...pendingCaptures]) pending.cancel();
      listeners.clear();
      lastSnapshot = null;
      identityCache = null;
    }
    for (const type of ["popstate", "hashchange", "resize"]) listen(window2, type, schedule);
    for (const type of ["loadedmetadata", "loadeddata"]) listen(document2, type, (event) => {
      const snapshot = getCurrent();
      if (snapshot?.media && (event.target === snapshot.media || snapshot.container.contains?.(event.target))) {
        mediaBindings.set(snapshot.media, {
          sourceId: snapshot.identity.source.sourceId,
          routeId: normalizeSource(window2.location.href)?.sourceId,
          resource: mediaResource(snapshot.media),
          pending: false
        });
      }
      schedule();
    }, true);
    for (const type of ["emptied", "play", "durationchange", "fullscreenchange", "visibilitychange"]) listen(document2, type, schedule, true);
    const observer = window2.MutationObserver ? new window2.MutationObserver(schedule) : null;
    let observerStarted = false;
    function observeRoot() {
      const root = document2.documentElement || document2.body;
      if (observer && root && !observerStarted) {
        observer.observe(root, { childList: true, subtree: true });
        observerStarted = true;
      }
    }
    observeRoot();
    if (observer) cleanups.push(() => observer.disconnect());
    listen(document2, "DOMContentLoaded", () => {
      observeRoot();
      schedule();
    });
    for (const method of ["pushState", "replaceState"]) {
      const original = window2.history?.[method];
      if (typeof original !== "function") continue;
      const wrapped = function(...args) {
        const result = original.apply(this, args);
        schedule();
        return result;
      };
      try {
        window2.history[method] = wrapped;
        cleanups.push(() => {
          if (window2.history[method] === wrapped) window2.history[method] = original;
        });
      } catch {
      }
    }
    inspect();
    return { getCurrent, getTime, capture, seek, resumePendingSeek, getVideoRect, subscribe, dispose };
  }

  // src/storage.js
  var DB_NAME = "BiliCaptionStudyDB";
  var DB_VERSION = 2;
  var LEGACY_KEY = "bili_caption_notes_v200";
  var MIGRATION_KEY = "legacy-v200-imported";
  var FORMAT = "caption-study-backup";
  var MAX_NOTES = 5e3;
  var MAX_IMAGE_BYTES = 10 * 1024 * 1024;
  var MAX_BACKUP_BYTES = 100 * 1024 * 1024;
  var IMAGE_TYPES = /* @__PURE__ */ new Set(["image/jpeg", "image/png", "image/webp"]);
  var REVIEW_STATES = /* @__PURE__ */ new Set(["new", "learning", "mastered"]);
  var BAD_KEYS = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
  function fail(message) {
    throw new Error(message);
  }
  function checkObject(value, label = "数据", seen = /* @__PURE__ */ new Set()) {
    if (value === null || typeof value !== "object" || value instanceof Blob) return;
    if (seen.has(value)) fail(`${label}不能包含循环引用`);
    if (seen.size > 20) fail(`${label}嵌套层级过深`);
    seen.add(value);
    if (!Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) fail(`${label}必须是普通 JSON 对象`);
    }
    for (const key of Object.keys(value)) {
      if (BAD_KEYS.has(key)) fail(`${label}包含不安全字段：${key}`);
      checkObject(value[key], label, seen);
    }
    seen.delete(value);
  }
  function text(value, fallback = "", max = 2e4, label = "文本") {
    if (value === void 0 || value === null) return fallback;
    if (typeof value !== "string" || value.length > max) fail(`${label}必须是长度不超过 ${max} 的文本`);
    return value;
  }
  function number(value, fallback, label, max = Number.MAX_SAFE_INTEGER) {
    if (value === void 0) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) fail(`${label}不是有效的非负数字`);
    return value;
  }
  function optionalTime(value, label) {
    return value === void 0 || value === null ? null : number(value, null, label);
  }
  function counter(value, label) {
    if (value === void 0 || value === null) return 0;
    if (!Number.isInteger(value) || value < 0 || value > 1e6) fail(`${label}必须是不超过 1000000 的非负整数`);
    return value;
  }
  function normalizeSource2(value) {
    if (value === void 0 || value === null) value = {};
    if (typeof value !== "object" || Array.isArray(value)) fail("视频来源格式无效");
    let url = text(value.url, "", 4096, "视频地址");
    if (url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        fail("视频地址无效");
      }
      const host = parsed.hostname.toLowerCase();
      if (!["http:", "https:"].includes(parsed.protocol) || !(host === "bilibili.com" || host.endsWith(".bilibili.com")) || parsed.username || parsed.password || parsed.port) fail("视频地址必须是 B 站的 HTTP/HTTPS 地址");
      parsed.protocol = "https:";
      url = parsed.href;
    }
    const page = number(value.page, 1, "视频分 P", 1e5);
    if (!Number.isInteger(page) || page < 1) fail("视频分 P 必须是正整数");
    return {
      url,
      videoId: text(value.videoId, "", 200, "视频 ID") || null,
      episodeId: text(value.episodeId, "", 200, "分集 ID") || null,
      page,
      sourceId: text(value.sourceId, "", 500, "来源 ID")
    };
  }
  function imageSize(url) {
    if (typeof url !== "string") fail("截图必须是图片 data URL");
    if (url.length > MAX_IMAGE_BYTES * 4 / 3 + 100) fail("单张截图不能超过 10 MiB");
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (!match || !match[2] || match[2].length % 4 !== 0) fail("截图只支持 JPEG、PNG 或 WebP 的 base64 data URL");
    const bytes = match[2].length / 4 * 3 - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) fail("单张截图不能超过 10 MiB");
    return bytes;
  }
  function splitNote(input, { legacy = false, seriesId } = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail("卡片格式无效");
    checkObject(input, "卡片");
    const id = text(input.id, "", 200, "卡片 ID");
    const sid = text(input.seriesId, seriesId || "", 300, "剧集 ID");
    if (!id.trim() || !sid.trim()) fail("卡片必须包含 ID 和剧集 ID");
    const createdAt = number(input.createdAt, legacy ? 0 : Date.now(), "创建时间");
    const time = number(input.time, 0, "视频时间", 31 * 24 * 3600);
    const reviewState = input.reviewState ?? "new";
    if (!REVIEW_STATES.has(reviewState)) fail("复习状态必须是 new、learning 或 mastered");
    const tags = input.tags ?? [];
    if (!Array.isArray(tags) || tags.length > 30) fail("标签必须是数组，且不能超过 30 个");
    const cleanedTags = [...new Set(tags.map((tag) => {
      if (typeof tag !== "string") fail("每个标签都必须是文本");
      return text(tag, "", 100, "标签").trim();
    }).filter(Boolean))];
    const interval = input.interval === void 0 || input.interval === null ? 0 : number(input.interval, 0, "复习间隔", 36500);
    let media = null;
    if (input.imageBlob !== void 0 && input.imageBlob !== null) {
      if (!(input.imageBlob instanceof Blob) || !IMAGE_TYPES.has(input.imageBlob.type) || input.imageBlob.size === 0) fail("截图 Blob 必须是 JPEG、PNG 或 WebP 图片");
      if (input.imageBlob.size > MAX_IMAGE_BYTES) fail("单张截图不能超过 10 MiB");
      media = { id, imageBlob: input.imageBlob };
    } else if (input.imageUrl !== void 0 && input.imageUrl !== null && input.imageUrl !== "") {
      imageSize(input.imageUrl);
      media = { id, imageUrl: input.imageUrl };
    }
    const note = {
      id,
      seriesId: sid,
      seriesTitle: text(input.seriesTitle, "未知剧集", 1e3, "剧集标题"),
      epTitle: text(input.epTitle, "", 1e3, "分集标题"),
      source: normalizeSource2(input.source),
      time,
      timeStr: text(input.timeStr, `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(Math.floor(time % 60)).padStart(2, "0")}`, 100, "时间显示"),
      userNote: text(input.userNote, "", 1e5, "笔记"),
      tags: cleanedTags,
      reviewState,
      dueAt: optionalTime(input.dueAt, "下次复习时间"),
      interval,
      reps: counter(input.reps, "复习次数"),
      lapses: counter(input.lapses, "忘记次数"),
      lastReviewedAt: optionalTime(input.lastReviewedAt, "最近复习时间"),
      createdAt,
      updatedAt: number(input.updatedAt, createdAt, "修改时间"),
      hasImage: Boolean(media)
    };
    return { note, media };
  }
  function storageError(error, fallback) {
    if (error?.name === "QuotaExceededError") return new Error("浏览器存储空间不足，请导出备份并清理空间后重试");
    if (error?.name === "AbortError") return new Error(`${fallback}：数据库事务已中止，请重试`);
    return new Error(`${fallback}${error?.message ? `：${error.message}` : ""}`);
  }
  function matchesScope(note, seriesId, sourceId) {
    return (seriesId === null || note.seriesId === seriesId) && (sourceId === null || note.source?.sourceId === sourceId || !note.source?.sourceId && normalizeSource(note.source?.url)?.sourceId === sourceId);
  }
  function filterNotes(seriesId, sourceId, query) {
    if (seriesId !== null) text(seriesId, "", 300, "剧集 ID");
    if (sourceId !== null) text(sourceId, "", 500, "来源 ID");
    const needle = text(query, "", 1e3, "搜索词").trim().toLocaleLowerCase();
    return (note) => matchesScope(note, seriesId, sourceId) && (!needle || [note.seriesTitle, note.epTitle, note.userNote, ...note.tags || []].join("\n").toLocaleLowerCase().includes(needle));
  }
  function timestampUrl(note) {
    const source = normalizeSource(note.source?.url) || normalizeSource(note.source);
    if (!source) return null;
    const url = new URL(source.url);
    url.searchParams.set("t", String(Math.floor(note.time)));
    return url.href;
  }
  async function blobToDataURL(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return `data:${blob.type};base64,${btoa(binary)}`;
  }
  function validateBackup(data) {
    if (!data || data.format !== FORMAT || data.schemaVersion !== 1 || !Array.isArray(data.notes)) fail("备份格式或版本不受支持");
    if (data.notes.length > MAX_NOTES) fail("单次导入不能超过 5000 张卡片");
    checkObject(data, "备份");
    let totalBytes = 0;
    const ids = /* @__PURE__ */ new Set();
    return data.notes.map((input) => {
      const required = ["id", "seriesId", "seriesTitle", "epTitle", "source", "time", "timeStr", "userNote", "tags", "reviewState", "createdAt", "updatedAt"];
      if (!input || required.some((key) => !Object.hasOwn(input, key))) fail("备份卡片缺少必要字段，请使用完整的 JSON 备份");
      for (const key of ["id", "seriesId", "seriesTitle", "epTitle", "timeStr", "userNote", "reviewState"]) {
        if (typeof input[key] !== "string") fail(`备份卡片的 ${key} 字段必须是文本`);
      }
      if (!Array.isArray(input.tags)) fail("备份卡片的标签必须是数组");
      for (const key of ["time", "createdAt", "updatedAt"]) {
        if (typeof input[key] !== "number") fail(`备份卡片的 ${key} 字段必须是数字`);
      }
      if (!input.source || typeof input.source !== "object" || Array.isArray(input.source)) fail("备份卡片的视频来源格式无效");
      if (input?.imageBlob !== void 0) fail("JSON 备份必须使用图片 data URL，不能使用 Blob");
      const entry = splitNote(input);
      if (ids.has(entry.note.id)) fail(`备份包含重复卡片 ID：${entry.note.id}`);
      ids.add(entry.note.id);
      totalBytes += JSON.stringify(entry.note).length * 2;
      if (entry.media) totalBytes += imageSize(entry.media.imageUrl);
      if (totalBytes > MAX_BACKUP_BYTES) fail("单次导入的数据不能超过 100 MiB");
      return entry;
    });
  }
  function createRepository(options = {}) {
    let idb;
    try {
      idb = Object.hasOwn(options, "indexedDB") ? options.indexedDB : globalThis.indexedDB;
    } catch {
      idb = null;
    }
    let db = null;
    let opening = null;
    let readiness = null;
    let closed = false;
    function open() {
      if (closed) return Promise.reject(new Error("数据库已关闭"));
      if (db) return Promise.resolve(db);
      if (opening) return opening;
      opening = new Promise((resolve, reject) => {
        if (!idb) return reject(new Error("当前浏览器无法使用 IndexedDB，卡片尚未保存"));
        let request;
        let settled = false;
        let upgradeError;
        try {
          request = idb.open(DB_NAME, DB_VERSION);
        } catch (error) {
          reject(storageError(error, "无法打开本地数据库"));
          return;
        }
        request.onblocked = () => {
          settled = true;
          reject(new Error("数据库升级被其他 B 站标签页阻止，请关闭旧标签页后重试"));
        };
        request.onupgradeneeded = (event) => {
          const database = request.result;
          const tx = request.transaction;
          if (settled || closed) {
            tx.abort();
            return;
          }
          try {
            const notes = database.objectStoreNames.contains("notes") ? tx.objectStore("notes") : database.createObjectStore("notes", { keyPath: "id" });
            if (!notes.indexNames.contains("by_series")) notes.createIndex("by_series", "seriesId");
            if (!notes.indexNames.contains("by_created")) notes.createIndex("by_created", "createdAt");
            const media = database.objectStoreNames.contains("media") ? tx.objectStore("media") : database.createObjectStore("media", { keyPath: "id" });
            if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
            if (event.oldVersion > 0 && event.oldVersion < 2) {
              const cursorRequest = notes.openCursor();
              cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (!cursor) return;
                try {
                  const entry = splitNote(cursor.value, { legacy: true });
                  if (entry.media) media.put(entry.media);
                  cursor.update(entry.note);
                  cursor.continue();
                } catch (error) {
                  upgradeError = error;
                  tx.abort();
                }
              };
            }
          } catch (error) {
            upgradeError = error;
            tx.abort();
          }
        };
        request.onerror = () => {
          settled = true;
          reject(storageError(upgradeError || request.error, "无法打开或升级本地数据库，原数据已保留"));
        };
        request.onsuccess = () => {
          if (settled || closed) {
            request.result.close();
            if (closed) reject(new Error("数据库已关闭"));
            return;
          }
          db = request.result;
          const connection = db;
          const forgetConnection = () => {
            if (db === connection) {
              db = null;
              opening = null;
              readiness = null;
            }
          };
          connection.onversionchange = () => {
            connection.close();
            forgetConnection();
          };
          connection.onclose = forgetConnection;
          resolve(db);
        };
      }).catch((error) => {
        opening = null;
        throw error;
      });
      return opening;
    }
    async function transaction(stores, mode, work, label = "数据库操作失败") {
      const database = await open();
      return new Promise((resolve, reject) => {
        let tx;
        let result;
        let cause;
        try {
          tx = database.transaction(stores, mode);
        } catch (error) {
          reject(storageError(error, label));
          return;
        }
        tx.oncomplete = () => resolve(result);
        tx.onerror = (event) => {
          cause ||= event.target?.error || tx.error;
        };
        tx.onabort = () => reject(storageError(cause || tx.error, label));
        const setResult = (value) => {
          result = value;
        };
        const abort = (error) => {
          cause = error;
          tx.abort();
        };
        try {
          work(tx, setResult, abort);
        } catch (error) {
          abort(error);
        }
      });
    }
    async function migrateLegacy() {
      const alreadyDone = await transaction(["meta"], "readonly", (tx, set) => {
        const request = tx.objectStore("meta").get(MIGRATION_KEY);
        request.onsuccess = () => set(Boolean(request.result));
      });
      if (alreadyDone) return;
      const sources = [];
      try {
        if (typeof options.gmGet === "function") sources.push(await options.gmGet(LEGACY_KEY, null));
        let local = options.localStorage;
        if (local === void 0) local = globalThis.localStorage;
        if (local) sources.push(local.getItem(LEGACY_KEY));
      } catch (error) {
        throw storageError(error, "无法读取历史卡片，原数据已保留");
      }
      const entries = /* @__PURE__ */ new Map();
      for (const raw of sources) {
        if (!raw) continue;
        let map;
        try {
          map = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch {
          fail("历史卡片格式损坏，原数据已保留");
        }
        checkObject(map, "历史卡片");
        if (!map || typeof map !== "object" || Array.isArray(map)) fail("历史卡片格式损坏，原数据已保留");
        for (const [seriesId, notes] of Object.entries(map)) {
          if (!Array.isArray(notes)) fail("历史剧集卡片必须是数组，原数据已保留");
          for (const input of notes) {
            const entry = splitNote(input, { legacy: true, seriesId });
            const prior = entries.get(entry.note.id);
            if (!prior || prior.note.updatedAt < entry.note.updatedAt) entries.set(entry.note.id, entry);
          }
        }
      }
      await transaction(["notes", "media", "meta"], "readwrite", (tx) => {
        const notes = tx.objectStore("notes");
        const media = tx.objectStore("media");
        const meta = tx.objectStore("meta");
        const marker = meta.get(MIGRATION_KEY);
        marker.onsuccess = () => {
          if (marker.result) return;
          for (const entry of entries.values()) {
            const existing = notes.getKey(entry.note.id);
            existing.onsuccess = () => {
              if (existing.result !== void 0) return;
              notes.add(entry.note);
              if (entry.media) media.add(entry.media);
            };
          }
          meta.put({ key: MIGRATION_KEY, completedAt: Date.now() });
        };
      }, "历史卡片迁移失败，原数据已保留");
    }
    function ready() {
      if (closed) return Promise.reject(new Error("数据库已关闭"));
      if (!readiness) readiness = open().then(migrateLegacy).catch((error) => {
        readiness = null;
        throw error;
      });
      return readiness;
    }
    async function list({ seriesId = null, sourceId = null, query = "", offset = 0, limit = 30 } = {}) {
      const matches = filterNotes(seriesId, sourceId, query);
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail("分页参数无效，单页最多 500 张卡片");
      await ready();
      return transaction(["notes"], "readonly", (tx, set) => {
        const page = [];
        let total = 0;
        const request = tx.objectStore("notes").index("by_created").openCursor(null, "prev");
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            set({ notes: page, total });
            return;
          }
          const note = cursor.value;
          if (matches(note)) {
            if (total >= offset && page.length < limit) page.push(note);
            total++;
          }
          cursor.continue();
        };
      });
    }
    async function get(id) {
      await ready();
      return transaction(["notes", "media"], "readonly", (tx, set) => {
        const request = tx.objectStore("notes").get(id);
        request.onsuccess = () => {
          if (!request.result) {
            set(null);
            return;
          }
          const image = tx.objectStore("media").get(id);
          image.onsuccess = () => {
            const { id: ignored, ...fields } = image.result || {};
            set({ ...request.result, ...fields });
          };
        };
      });
    }
    async function save(input) {
      const entry = splitNote(input);
      await ready();
      return transaction(["notes", "media"], "readwrite", (tx, set) => {
        tx.objectStore("notes").put(entry.note);
        if (entry.media) tx.objectStore("media").put(entry.media);
        else tx.objectStore("media").delete(entry.note.id);
        const { id: ignored, ...fields } = entry.media || {};
        set({ ...entry.note, ...fields });
      }, "保存卡片失败");
    }
    function applyPatch(tx, id, patch, set, abort) {
      const notes = tx.objectStore("notes");
      const media = tx.objectStore("media");
      const request = notes.get(id);
      request.onsuccess = () => {
        if (!request.result) {
          abort(new Error("卡片不存在，可能已被删除"));
          return;
        }
        const image = media.get(id);
        image.onsuccess = () => {
          try {
            const { id: ignored, ...oldImage } = image.result || {};
            const replacingImage = Object.hasOwn(patch, "imageBlob") || Object.hasOwn(patch, "imageUrl");
            const entry = splitNote({ ...request.result, ...replacingImage ? {} : oldImage, ...patch, id, updatedAt: Date.now() });
            notes.put(entry.note);
            if (entry.media) media.put(entry.media);
            else media.delete(id);
            const { id: ignoredAgain, ...newImage } = entry.media || {};
            set({ ...entry.note, ...newImage });
          } catch (error) {
            abort(error);
          }
        };
      };
    }
    async function update(id, patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) fail("卡片修改内容无效");
      checkObject(patch, "卡片修改");
      if (patch.id !== void 0 && patch.id !== id) fail("不能修改卡片 ID");
      patch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== void 0));
      await ready();
      return transaction(["notes", "media"], "readwrite", (tx, set, abort) => applyPatch(tx, id, patch, set, abort), "修改卡片失败");
    }
    async function remove(id) {
      await ready();
      return transaction(["notes", "media"], "readwrite", (tx, set) => {
        const notes = tx.objectStore("notes");
        const media = tx.objectStore("media");
        const request = notes.get(id);
        request.onsuccess = () => {
          if (!request.result) {
            set(null);
            return;
          }
          const image = media.get(id);
          image.onsuccess = () => {
            const { id: ignored, ...fields } = image.result || {};
            notes.delete(id);
            media.delete(id);
            set({ ...request.result, ...fields });
          };
        };
      }, "删除卡片失败");
    }
    async function restore(input) {
      const entry = splitNote(input);
      await ready();
      return transaction(["notes", "media"], "readwrite", (tx, set, abort) => {
        const notes = tx.objectStore("notes");
        const request = notes.getKey(entry.note.id);
        request.onsuccess = () => {
          if (request.result !== void 0) {
            abort(new Error("同 ID 卡片已存在，无法覆盖恢复"));
            return;
          }
          notes.add(entry.note);
          if (entry.media) tx.objectStore("media").add(entry.media);
          const { id: ignored, ...fields } = entry.media || {};
          set({ ...entry.note, ...fields });
        };
      }, "恢复卡片失败");
    }
    async function count(seriesId = null, sourceId = null) {
      const matches = filterNotes(seriesId, sourceId, "");
      await ready();
      return transaction(["notes"], "readonly", (tx, set) => {
        const notes = tx.objectStore("notes");
        if (sourceId === null) {
          const request2 = seriesId === null ? notes.count() : notes.index("by_series").count(seriesId);
          request2.onsuccess = () => set(request2.result);
          return;
        }
        let total = 0;
        const request = (seriesId === null ? notes : notes.index("by_series")).openCursor(seriesId);
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            set(total);
            return;
          }
          if (matches(cursor.value)) total++;
          cursor.continue();
        };
      });
    }
    async function exportBackup({ seriesId = null, sourceId = null, query = "", includeImages = true } = {}) {
      const matches = filterNotes(seriesId, sourceId, query);
      await ready();
      const entries = await transaction(includeImages ? ["notes", "media"] : ["notes"], "readonly", (tx, set) => {
        const result = [];
        const request = tx.objectStore("notes").openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            set(result);
            return;
          }
          const note = cursor.value;
          if (!matches(note)) {
            cursor.continue();
            return;
          }
          if (!includeImages) {
            result.push(note);
            cursor.continue();
            return;
          }
          const image = tx.objectStore("media").get(cursor.key);
          image.onsuccess = () => {
            const { id: ignored, ...fields } = image.result || {};
            result.push({ ...note, ...fields });
            cursor.continue();
          };
        };
      });
      const notes = [];
      for (const entry of entries) {
        const { imageBlob, hasImage, ...note } = entry;
        if (imageBlob) note.imageUrl = await blobToDataURL(imageBlob);
        note.timestampUrl = timestampUrl(note);
        notes.push(note);
      }
      return { format: FORMAT, schemaVersion: 1, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), notes };
    }
    async function previewImport(data) {
      const entries = validateBackup(data);
      await ready();
      return transaction(["notes"], "readonly", (tx, set) => {
        const result = { total: entries.length, existing: 0, newCount: entries.length };
        set(result);
        for (const entry of entries) {
          const request = tx.objectStore("notes").getKey(entry.note.id);
          request.onsuccess = () => {
            if (request.result !== void 0) {
              result.existing++;
              result.newCount--;
            }
          };
        }
      });
    }
    async function importBackup(data) {
      const entries = validateBackup(data);
      await ready();
      return transaction(["notes", "media"], "readwrite", (tx, set) => {
        const result = { imported: 0, skipped: 0 };
        set(result);
        const notes = tx.objectStore("notes");
        for (const entry of entries) {
          const request = notes.getKey(entry.note.id);
          request.onsuccess = () => {
            if (request.result !== void 0) {
              result.skipped++;
              return;
            }
            notes.add(entry.note);
            if (entry.media) tx.objectStore("media").add(entry.media);
            result.imported++;
          };
        }
      }, "导入备份失败，未完成的修改已撤销");
    }
    function close() {
      closed = true;
      db?.close();
      db = null;
    }
    return { ready, list, get, save, update, remove, restore, count, exportBackup, previewImport, importBackup, close };
  }

  // src/shortcuts.js
  var MODIFIER_ORDER = ["Ctrl", "Alt", "Shift", "Meta"];
  var MODIFIER_ALIAS = {
    ctrl: "Ctrl",
    control: "Ctrl",
    alt: "Alt",
    option: "Alt",
    shift: "Shift",
    meta: "Meta",
    cmd: "Meta",
    command: "Meta",
    win: "Meta",
    super: "Meta"
  };
  var MODIFIER_ONLY_KEYS = /* @__PURE__ */ new Set(["Ctrl", "Alt", "Shift"]);
  var SPECIAL_CODES = {
    Space: "Space",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
    Minus: "Minus",
    Equal: "Equal",
    BracketLeft: "BracketLeft",
    BracketRight: "BracketRight",
    Backslash: "Backslash",
    Semicolon: "Semicolon",
    Quote: "Quote",
    Backquote: "Backquote",
    Comma: "Comma",
    Period: "Period",
    Slash: "Slash"
  };
  var SPECIAL_KEYS = {
    " ": "Space",
    spacebar: "Space",
    space: "Space",
    enter: "Enter",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    del: "Delete",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    arrowup: "ArrowUp",
    up: "ArrowUp",
    arrowdown: "ArrowDown",
    down: "ArrowDown",
    arrowleft: "ArrowLeft",
    left: "ArrowLeft",
    arrowright: "ArrowRight",
    right: "ArrowRight",
    "-": "Minus",
    minus: "Minus",
    "=": "Equal",
    equal: "Equal",
    "[": "BracketLeft",
    bracketleft: "BracketLeft",
    "]": "BracketRight",
    bracketright: "BracketRight",
    "\\": "Backslash",
    backslash: "Backslash",
    ";": "Semicolon",
    semicolon: "Semicolon",
    "'": "Quote",
    quote: "Quote",
    "`": "Backquote",
    backquote: "Backquote",
    ",": "Comma",
    comma: "Comma",
    ".": "Period",
    period: "Period",
    "/": "Slash",
    slash: "Slash"
  };
  var DISPLAY_KEYS = {
    Space: "空格",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Minus: "-",
    Equal: "=",
    BracketLeft: "[",
    BracketRight: "]",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Comma: ",",
    Period: ".",
    Slash: "/"
  };
  var SHORTCUT_ACTIONS = Object.freeze([
    { id: "capture", label: "一键记录此句", scope: "global", allowModifierOnly: false },
    { id: "notebook", label: "开关记录库", scope: "global", allowModifierOnly: false },
    { id: "toggleMask", label: "开关遮罩", scope: "global", allowModifierOnly: false },
    { id: "editMask", label: "遮罩位置调节", scope: "global", allowModifierOnly: false },
    { id: "peek", label: "按住临时查看中文", scope: "global", allowModifierOnly: true }
  ]);
  var DEFAULT_SHORTCUTS = Object.freeze({
    capture: "C",
    notebook: "Alt+B",
    toggleMask: "Alt+A",
    editMask: "Alt+Z",
    peek: "Alt"
  });
  function normalizeMainKey(token) {
    if (typeof token !== "string") return null;
    if (token === " ") return "Space";
    const trimmed = token.trim();
    if (!trimmed) return null;
    if (/^[a-zA-Z]$/.test(trimmed)) return trimmed.toUpperCase();
    if (/^[0-9]$/.test(trimmed)) return trimmed;
    if (/^F([1-9]|1[0-2])$/i.test(trimmed)) return trimmed.toUpperCase();
    return SPECIAL_KEYS[trimmed.toLowerCase()] || null;
  }
  function normalizeShortcut(value, { allowModifierOnly = false } = {}) {
    if (typeof value !== "string") return null;
    const raw = value.trim();
    if (!raw) return "";
    if (raw.length > 64) return null;
    const parts = raw.split(/\s*\+\s*/);
    if (parts.some((part) => !part)) return null;
    if (parts.length === 1) {
      const mod = MODIFIER_ALIAS[parts[0].toLowerCase()];
      if (mod) return allowModifierOnly && MODIFIER_ONLY_KEYS.has(mod) ? mod : null;
      return normalizeMainKey(parts[0]);
    }
    const mods = /* @__PURE__ */ new Set();
    for (let i = 0; i < parts.length - 1; i++) {
      const mod = MODIFIER_ALIAS[parts[i].toLowerCase()];
      if (!mod || mods.has(mod)) return null;
      mods.add(mod);
    }
    const key = normalizeMainKey(parts[parts.length - 1]);
    if (!key) return null;
    const ordered = MODIFIER_ORDER.filter((mod) => mods.has(mod));
    return [...ordered, key].join("+");
  }
  function normalizeShortcutsMap(input) {
    const output = { ...DEFAULT_SHORTCUTS };
    if (!input || typeof input !== "object" || Array.isArray(input)) return output;
    const overrides = /* @__PURE__ */ new Map();
    for (const action of SHORTCUT_ACTIONS) {
      if (!Object.hasOwn(input, action.id)) continue;
      const normalized = normalizeShortcut(input[action.id], { allowModifierOnly: action.allowModifierOnly });
      if (normalized !== null) overrides.set(action.id, normalized);
    }
    const reserved = new Set(overrides.values());
    for (const { id } of SHORTCUT_ACTIONS) {
      output[id] = overrides.get(id) ?? (reserved.has(DEFAULT_SHORTCUTS[id]) ? "" : DEFAULT_SHORTCUTS[id]);
    }
    return output;
  }
  function keyTokenFromEvent(event) {
    const code = typeof event?.code === "string" ? event.code : "";
    if (/^Key([A-Z])$/.test(code)) return code.slice(3);
    if (/^(?:Digit|Numpad)([0-9])$/.test(code)) return code.slice(-1);
    if (/^F([1-9]|1[0-2])$/.test(code)) return code;
    if (SPECIAL_CODES[code]) return SPECIAL_CODES[code];
    const key = typeof event?.key === "string" ? event.key : "";
    if (!key) return null;
    const mod = MODIFIER_ALIAS[key.toLowerCase()];
    if (mod) return mod;
    return normalizeMainKey(key);
  }
  function eventToShortcut(event, { allowModifierOnly = false } = {}) {
    if (!event) return null;
    const token = keyTokenFromEvent(event);
    if (!token) return null;
    if (MODIFIER_ORDER.includes(token)) {
      if (!allowModifierOnly || !MODIFIER_ONLY_KEYS.has(token)) return null;
      const otherMods = token !== "Ctrl" && Boolean(event.ctrlKey) || token !== "Alt" && Boolean(event.altKey) || token !== "Shift" && Boolean(event.shiftKey) || Boolean(event.metaKey);
      return otherMods ? null : token;
    }
    const mods = [];
    if (event.ctrlKey) mods.push("Ctrl");
    if (event.altKey) mods.push("Alt");
    if (event.shiftKey) mods.push("Shift");
    if (event.metaKey) mods.push("Meta");
    return mods.length ? `${mods.join("+")}+${token}` : token;
  }
  function matchesPeekRelease(event, spec) {
    if (!spec) return false;
    const token = keyTokenFromEvent(event);
    if (!token) return false;
    if (MODIFIER_ONLY_KEYS.has(spec)) return token === spec;
    const parts = spec.split("+");
    return parts.includes(token);
  }
  function formatShortcut(spec) {
    if (!spec) return "已禁用";
    return spec.split("+").map((part) => DISPLAY_KEYS[part] || part).join(" + ");
  }
  function findShortcutConflict(shortcuts) {
    const seen = /* @__PURE__ */ new Map();
    for (const action of SHORTCUT_ACTIONS) {
      const value = shortcuts?.[action.id];
      if (!value) continue;
      if (seen.has(value)) {
        return { first: seen.get(value), second: action, shortcut: value };
      }
      seen.set(value, action);
    }
    return null;
  }

  // src/config.js
  var LEGACY_KEY2 = "bili_caption_mask_v200_cfg";
  var GLOBAL_KEY = "bili_caption_mask_v240_global";
  var SERIES_PREFIX = "bili_caption_mask_v240_series:";
  var SHORTCUT_META = new Map(SHORTCUT_ACTIONS.map((action) => [action.id, action]));
  var V250_GLOBAL_SHORTCUTS = { capture: "Alt+S", notebook: "Alt+B", toggleMask: "Alt+C", editMask: "Alt+Z", peek: "Alt" };
  var V250_REVIEW_SHORTCUTS = { reveal: "Space", rateAgain: "1", rateHard: "2", rateGood: "3" };
  var DEFAULTS = Object.freeze({
    enabled: true,
    left: 15,
    top: 84,
    width: 70,
    height: 7.2,
    blur: 14,
    mode: "blur",
    shortcuts: DEFAULT_SHORTCUTS
  });
  var GEOMETRY = /* @__PURE__ */ new Set(["left", "top", "width", "height"]);
  var LIMITS = {
    left: [0, 100],
    top: [0, 100],
    width: [5, 100],
    height: [2, 100],
    blur: [0, 40]
  };
  var UNSAFE = /* @__PURE__ */ new Set(["__proto__", "prototype", "constructor"]);
  function isPlain(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }
  function isSafe(value, seen = /* @__PURE__ */ new Set()) {
    if (value === null || typeof value !== "object") return true;
    if (!isPlain(value) || seen.has(value) || seen.size > 20) return false;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (UNSAFE.has(key) || !isSafe(value[key], seen)) return false;
    }
    seen.delete(value);
    return true;
  }
  function parse(value) {
    try {
      const object = typeof value === "string" ? JSON.parse(value) : value;
      return isPlain(object) && isSafe(object) ? object : null;
    } catch {
      return null;
    }
  }
  function usesV250ShortcutDefaults(stored) {
    const shortcuts = stored?.shortcuts;
    if (!isPlain(shortcuts)) return false;
    const review = Object.entries(V250_REVIEW_SHORTCUTS).filter(([id]) => Object.hasOwn(shortcuts, id));
    const legacy = review.length > 0 || ["singleKeys", "reviewBatch", "loopCount"].some((key) => Object.hasOwn(stored, key));
    return legacy && Object.entries(V250_GLOBAL_SHORTCUTS).every(([id, spec]) => shortcuts[id] === spec) && review.every(([id, spec]) => shortcuts[id] === spec);
  }
  function normalize(input) {
    const output = { ...DEFAULTS, shortcuts: { ...DEFAULT_SHORTCUTS } };
    for (const key of Object.keys(DEFAULTS)) {
      const value = input?.[key];
      if (key === "shortcuts") {
        output.shortcuts = normalizeShortcutsMap(value);
      } else if (key === "enabled") {
        if (typeof value === "boolean") output[key] = value;
      } else if (key === "mode") {
        if (value === "blur" || value === "solid") output[key] = value;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        const [min, max] = LIMITS[key];
        output[key] = Math.max(min, Math.min(max, value));
      }
    }
    output.left = Math.min(output.left, 100 - output.width);
    output.top = Math.min(output.top, 100 - output.height);
    return output;
  }
  function onlyGeometry(config) {
    return Object.fromEntries([...GEOMETRY].map((key) => [key, config[key]]));
  }
  function onlyGlobal(config) {
    return Object.fromEntries(Object.keys(DEFAULTS).filter((key) => !GEOMETRY.has(key)).map((key) => [
      key,
      key === "shortcuts" ? { ...config.shortcuts } : config[key]
    ]));
  }
  function createConfigStore(options = {}) {
    const gmGet = options.gmGet;
    const gmSet = options.gmSet;
    const useGM = typeof gmGet === "function" || typeof gmSet === "function";
    let disposed = false;
    function checkOpen() {
      if (disposed) throw new Error("设置存储已关闭");
    }
    function seriesKey(seriesId) {
      if (seriesId === void 0 || seriesId === null) seriesId = "global_default";
      if (typeof seriesId !== "string" || !seriesId.trim() || seriesId.length > 300) throw new Error("剧集标识无效");
      try {
        return SERIES_PREFIX + encodeURIComponent(seriesId);
      } catch {
        throw new Error("剧集标识无效");
      }
    }
    function local() {
      return Object.hasOwn(options, "localStorage") ? options.localStorage : globalThis.localStorage;
    }
    function localRead(key) {
      try {
        return parse(local()?.getItem(key));
      } catch {
        return null;
      }
    }
    function read(key) {
      if (!useGM) return localRead(key);
      try {
        if (typeof gmGet !== "function") return null;
        const value = gmGet(key, null);
        if (value && typeof value.then === "function") {
          Promise.resolve(value).catch(() => {
          });
          return null;
        }
        return parse(value);
      } catch {
        return null;
      }
    }
    function legacy() {
      return read(LEGACY_KEY2) || (useGM ? localRead(LEGACY_KEY2) : null) || {};
    }
    function get(seriesId) {
      checkOpen();
      const key = seriesKey(seriesId);
      const id = seriesId ?? "global_default";
      const old = legacy();
      const legacyGlobal = isPlain(old.global) ? old.global : {};
      const legacySeries = isPlain(old.series) && Object.hasOwn(old.series, id) && isPlain(old.series[id]) ? old.series[id] : {};
      const storedGlobal = read(GLOBAL_KEY);
      const mergedGlobal = { ...legacyGlobal, ...storedGlobal };
      if (usesV250ShortcutDefaults(storedGlobal)) mergedGlobal.shortcuts = DEFAULT_SHORTCUTS;
      const global = onlyGlobal(normalize(mergedGlobal));
      const geometry = onlyGeometry(normalize({ ...legacyGlobal, ...legacySeries, ...read(key) }));
      return { ...DEFAULTS, ...global, ...geometry };
    }
    function write(key, value) {
      try {
        const serialized = JSON.stringify(value);
        if (useGM) {
          if (typeof gmSet !== "function") throw new Error("GM 设置写入接口不可用");
          const result = gmSet(key, serialized);
          if (result && typeof result.then === "function") {
            Promise.resolve(result).catch(() => {
            });
            throw new Error("请使用同步 GM_setValue 接口保存设置");
          }
        } else {
          const storage = local();
          if (!storage || typeof storage.setItem !== "function") throw new Error("当前浏览器无法保存设置");
          storage.setItem(key, serialized);
        }
      } catch (error) {
        if (error?.name === "QuotaExceededError") throw new Error("设置保存失败：浏览器存储空间不足");
        throw new Error(`设置保存失败${error?.message ? `：${error.message}` : ""}`);
      }
    }
    function patch(seriesId, changes) {
      checkOpen();
      if (!isPlain(changes) || !isSafe(changes)) throw new Error("设置修改内容无效或包含不安全字段");
      const accepted = {};
      for (const [key, value] of Object.entries(changes)) {
        if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`不支持的设置项：${key}`);
        if (value === void 0) continue;
        if (key === "shortcuts") {
          if (!isPlain(value)) throw new Error("快捷键设置必须是对象");
          const normalized = {};
          for (const [action, spec] of Object.entries(value)) {
            const meta = SHORTCUT_META.get(action);
            if (!meta) throw new Error(`不支持的快捷键项：${action}`);
            if (spec === void 0) continue;
            const canonical = normalizeShortcut(spec, { allowModifierOnly: meta.allowModifierOnly });
            if (canonical === null) throw new Error(`快捷键 ${action} 格式无效`);
            normalized[action] = canonical;
          }
          accepted.shortcuts = normalized;
        } else if (key === "enabled") {
          if (typeof value !== "boolean") throw new Error(`设置 ${key} 必须是开关值`);
          accepted[key] = value;
        } else if (key === "mode") {
          if (value !== "blur" && value !== "solid") throw new Error("遮罩模式必须是 blur 或 solid");
          accepted[key] = value;
        } else if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`设置 ${key} 必须是有效数字`);
        } else {
          accepted[key] = value;
        }
      }
      const current = get(seriesId);
      const merged = { ...current, ...accepted };
      if (accepted.shortcuts) merged.shortcuts = { ...current.shortcuts, ...accepted.shortcuts };
      const result = normalize(merged);
      const keys = Object.keys(accepted);
      if (keys.some((key) => GEOMETRY.has(key))) write(seriesKey(seriesId), onlyGeometry(result));
      if (keys.some((key) => !GEOMETRY.has(key))) write(GLOBAL_KEY, onlyGlobal(result));
      return result;
    }
    function reset(seriesId) {
      return patch(seriesId, onlyGeometry(DEFAULTS));
    }
    function dispose() {
      disposed = true;
    }
    return { get, patch, reset, dispose };
  }

  // src/editable.js
  function getDeepActiveElement(doc = typeof document !== "undefined" ? document : null) {
    let active = doc?.activeElement;
    while (active?.shadowRoot?.activeElement) {
      active = active.shadowRoot.activeElement;
    }
    return active;
  }
  function isEditableNode(node2) {
    if (!node2) return false;
    const el2 = node2.nodeType === 3 ? node2.parentElement : node2.nodeType === 1 || typeof node2.tagName === "string" ? node2 : null;
    if (!el2) return false;
    if (el2.isContentEditable) return true;
    const tag = (el2.tagName || "").toLowerCase();
    if (tag === "input" && el2.type !== "range" || tag === "textarea" || tag === "select") return true;
    const role = el2.getAttribute?.("role") ?? el2.attributes?.get?.("role");
    if (role === "textbox" || role === "searchbox" || role === "combobox") return true;
    const ce = el2.getAttribute?.("contenteditable") ?? el2.attributes?.get?.("contenteditable");
    if (ce != null && ce !== "false") return true;
    if (tag === "bili-comment-box" || tag === "bili-comment-reply-box" || tag === "bili-comments-box-root" || tag === "bili-comment-editor") return true;
    if (el2.classList?.contains?.("ProseMirror") || el2.classList?.contains?.("comment-send-box") || el2.classList?.contains?.("reply-box") || el2.classList?.contains?.("bili-comment-box")) return true;
    if (el2.closest?.('input:not([type="range"]),textarea,select,[role="textbox"],[role="searchbox"],[role="combobox"],[contenteditable]:not([contenteditable="false"]),bili-comment-box,bili-comment-reply-box,bili-comments-box-root,.comment-send-box,.reply-box,.bili-comment-box')) return true;
    return false;
  }
  function isEditableEvent(targetOrEvent, doc = typeof document !== "undefined" ? document : null) {
    if (!targetOrEvent) return false;
    if (doc) {
      if (isEditableNode(getDeepActiveElement(doc))) return true;
      if (isEditableNode(doc.activeElement)) return true;
    }
    if (typeof targetOrEvent.composedPath === "function" || "target" in targetOrEvent) {
      const event = targetOrEvent;
      if (isEditableNode(event.target)) return true;
      if (typeof event.composedPath === "function") {
        const path = event.composedPath();
        for (let i = 0; i < path.length; i++) {
          if (isEditableNode(path[i])) return true;
        }
      }
      return false;
    }
    return isEditableNode(targetOrEvent);
  }

  // src/notebook.js
  var PAGE_SIZE = 30;
  var SAVE_DELAY = 550;
  var LEAD_IN = 2;
  var SCOPES = [
    ["episode", "当前本集"],
    ["series", "当前整部剧"],
    ["all", "全部记录"]
  ];
  var scopeLabels = new Map(SCOPES);
  var scopeCounts = { episode: "本集", series: "本剧", all: "全部" };
  var formatCount = new Intl.NumberFormat("zh-CN");
  var formatDate = new Intl.DateTimeFormat("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit" });
  var formatDateTime = new Intl.DateTimeFormat("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  function node(tag, className, text2) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text2 !== void 0) element.textContent = String(text2);
    return element;
  }
  function button(text2, handler, className = "") {
    const element = node("button", `bcm-button ${className}`.trim(), text2);
    element.type = "button";
    if (handler) element.addEventListener("click", handler);
    return element;
  }
  function field(labelText, control, className = "") {
    const label = node("label", `bcm-field ${className}`.trim());
    label.append(node("span", "bcm-label", labelText), control);
    return label;
  }
  function select(options, label) {
    const element = node("select", "bcm-select");
    element.setAttribute("aria-label", label);
    for (const [value, text2] of options) {
      const option = node("option", "", text2);
      option.value = value;
      element.append(option);
    }
    return element;
  }
  function readableError(error) {
    return error instanceof Error ? error.message : String(error || "请稍后重试");
  }
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = node("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  }
  var seriesTitle = (note) => note.seriesTitle || "未知剧集";
  var episodeTitle = (note) => note.epTitle || (note.source?.episodeId ?? (note.source?.videoId ? `P${note.source.page}` : "未标注分集"));
  var timeLabel = (note) => note.timeStr || formatTime(note.time);
  function escapeMarkdown(value) {
    return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replace(/[\\`*_\[\]~]/g, "\\$&");
  }
  function exportMarkdown({ notes, exportedAt }, scopeLabel) {
    const lines = [
      "# 场景学习记录",
      "",
      `- 导出日期：${formatDate.format(new Date(exportedAt))}`,
      `- 导出范围：${scopeLabel}（共 ${notes.length} 条）`
    ];
    const series = /* @__PURE__ */ new Map();
    for (const note of notes) {
      const title = seriesTitle(note);
      const part = episodeTitle(note);
      if (!series.has(title)) series.set(title, /* @__PURE__ */ new Map());
      const episodes = series.get(title);
      if (!episodes.has(part)) episodes.set(part, []);
      episodes.get(part).push(note);
    }
    const heading = (text2) => escapeMarkdown(text2.replace(/\s+/g, " ").trim()).replace(/#+$/, (match) => "\\" + match);
    const compareTitles = ([left], [right]) => left.localeCompare(right, "zh-CN", { numeric: true });
    for (const [title, episodes] of [...series].sort(compareTitles)) {
      lines.push("", `## ${heading(title)}`);
      for (const [part, records] of [...episodes].sort(compareTitles)) {
        lines.push("", `### ${heading(part)}`, "");
        records.sort((a, b) => a.time - b.time || a.createdAt - b.createdAt);
        for (const note of records) {
          const link = note.timestampUrl ? ` · [打开原片段](${note.timestampUrl})` : "";
          lines.push(`- **${escapeMarkdown(timeLabel(note).replace(/\s+/g, " "))}**${link}`);
          if (note.userNote?.trim()) {
            const [first, ...rest] = note.userNote.replace(/\r\n?/g, "\n").split("\n");
            lines.push(`  > 备注：${escapeMarkdown(first)}`);
            for (const line of rest) {
              const literal = escapeMarkdown(line).replace(/^(\d*)([#>+!.)-])/, "$1\\$2");
              lines.push(`  > ${literal}`);
            }
          }
          if (note.createdAt > 0 && note.createdAt <= 864e13) {
            lines.push(`  > 记录时间：${formatDateTime.format(note.createdAt)}`);
          }
        }
      }
    }
    return lines.join("\n") + "\n";
  }
  function exportHtml({ notes, exportedAt }, scopeLabel) {
    const output = document.implementation.createHTMLDocument("场景学习记录");
    output.documentElement.lang = "zh-CN";
    const charset = output.createElement("meta");
    charset.setAttribute("charset", "utf-8");
    const viewport = output.createElement("meta");
    viewport.name = "viewport";
    viewport.content = "width=device-width, initial-scale=1";
    const policy = output.createElement("meta");
    policy.httpEquiv = "Content-Security-Policy";
    policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
    const style = output.createElement("style");
    style.textContent = [
      ":root{color-scheme:light}body{font:16px/1.65 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#fff;color:#111827;overflow-wrap:anywhere}",
      "article{padding:22px 0;border-top:1px solid #e5e7eb}h1{font-size:28px}h2{font-size:18px;margin:0 0 12px}p{white-space:pre-wrap}",
      "img{display:block;width:100%;height:auto;border-radius:10px;background:#f7f8fa}a{color:#18181b}small{color:#6b7280}"
    ].join("");
    output.head.prepend(charset, viewport, policy);
    output.head.append(style);
    output.body.append(node("h1", "", "场景学习记录"), node("p", "", `${formatDate.format(new Date(exportedAt))} · ${scopeLabel} · 共 ${notes.length} 条`));
    for (const note of notes) {
      const article = node("article");
      article.append(node("h2", "", `${seriesTitle(note)} · ${episodeTitle(note)}`));
      if (note.timestampUrl) {
        const link = node("a", "", `${timeLabel(note)} · 打开原片段`);
        link.href = note.timestampUrl;
        article.append(link);
      } else article.append(node("small", "", timeLabel(note)));
      if (/^data:image\/(jpeg|png|webp);base64,/.test(note.imageUrl || "")) {
        const image = node("img");
        image.loading = "lazy";
        image.src = note.imageUrl;
        image.alt = `${episodeTitle(note)} ${timeLabel(note)} 的记录画面`;
        article.append(image);
      }
      if (note.userNote) article.append(node("p", "", note.userNote));
      output.body.append(article);
    }
    return "<!doctype html>\n" + output.documentElement.outerHTML;
  }
  function createNotebook({ repo, player, notify = () => {
  }, version = "3.0.1", onChange = () => {
  }, onHelp, onSettings }) {
    let opened = false;
    let disposed = false;
    let offset = 0;
    let total = 0;
    let refreshGeneration = 0;
    let renderGeneration = 0;
    let searchTimer;
    let closing;
    let returnFocus = null;
    let undoNote = null;
    let importData = null;
    const drafts = /* @__PURE__ */ new Map();
    const controls = /* @__PURE__ */ new Map();
    const imageUrls = /* @__PURE__ */ new Set();
    const element = node("aside", "bcm-notebook");
    element.setAttribute("aria-label", "场景记录库");
    element.dataset.version = version;
    element.tabIndex = -1;
    element.hidden = true;
    element.inert = true;
    const header = node("header", "bcm-notebook-header");
    const heading = node("div", "bcm-heading-row");
    const title = node("h2", "bcm-notebook-title", "场景记录库");
    const closeButton = button("关闭", () => close(), "bcm-button-quiet");
    closeButton.setAttribute("aria-label", "关闭记录库");
    const subtitle = node("p", "bcm-subtitle", "看剧随手记，看完再整理导出。");
    const headerActions = node("div", "bcm-toolbar");
    for (const [format, extension, mime, serialize] of [
      ["JSON", "json", "application/json", (data) => JSON.stringify(data, null, 2)],
      ["Markdown", "md", "text/markdown", exportMarkdown],
      ["HTML", "html", "text/html", exportHtml]
    ]) {
      const action = button(`导出 ${format}`, () => download(format, extension, mime, serialize, action), format === "JSON" ? "bcm-button-primary" : "");
      headerActions.append(action);
    }
    const importButton = button("导入备份", () => fileInput.click());
    headerActions.append(importButton);
    const utilities = node("div", "bcm-header-tools");
    if (onSettings) utilities.append(button("设置", onSettings, "bcm-button-quiet"));
    if (onHelp) utilities.append(button("帮助", onHelp, "bcm-button-quiet"));
    utilities.append(closeButton);
    heading.append(title, utilities);
    header.append(heading, subtitle, headerActions);
    const scroll = node("div", "bcm-notebook-scroll");
    const filters = node("section", "bcm-filters");
    filters.setAttribute("aria-label", "筛选记录");
    const searchInput = node("input", "bcm-input");
    searchInput.type = "search";
    searchInput.placeholder = "搜索标题或备注";
    searchInput.autocomplete = "off";
    searchInput.maxLength = 1e3;
    searchInput.setAttribute("aria-label", "搜索记录");
    const scopeSelect = select(SCOPES, "记录范围");
    const filterRow = node("div", "bcm-filter-row");
    filterRow.append(scopeSelect, searchInput);
    const resultSummary = node("p", "bcm-result-summary");
    resultSummary.setAttribute("role", "status");
    filters.append(filterRow, resultSummary);
    const notices = node("div", "bcm-notices");
    notices.setAttribute("aria-live", "polite");
    const noticeText = node("span");
    const retryDrafts = button("重试保存", async () => {
      const ok = await flushDrafts();
      if (ok) {
        setNotice("备注已保存。");
        await refresh();
      }
    });
    const retryLoading = button("重新加载", () => refresh());
    retryLoading.hidden = true;
    retryDrafts.hidden = true;
    notices.append(noticeText, retryDrafts, retryLoading);
    notices.hidden = true;
    const undoRegion = node("div", "bcm-undo");
    undoRegion.hidden = true;
    undoRegion.setAttribute("role", "status");
    const undoText = node("span", "", "记录已删除。");
    const undoButton = button("撤销删除", async () => {
      if (!undoNote) return;
      const restoring = undoNote;
      undoButton.disabled = true;
      try {
        await repo.restore(restoring);
        if (undoNote === restoring) {
          undoNote = null;
          undoRegion.hidden = true;
        }
        signalChange();
        await refresh();
        notify("已恢复记录");
      } catch (error) {
        setNotice(`恢复失败：${readableError(error)}。可以再次撤销。`, true);
      } finally {
        undoButton.disabled = false;
      }
    });
    undoRegion.append(undoText, undoButton);
    const importRegion = node("section", "bcm-import-preview");
    importRegion.hidden = true;
    importRegion.setAttribute("aria-label", "备份导入预览");
    const importText = node("p");
    const importActions = node("div", "bcm-toolbar");
    const confirmImportButton = button("确认导入", () => confirmImport(), "bcm-button-primary");
    const cancelImportButton = button("取消", () => {
      importData = null;
      importRegion.hidden = true;
    });
    importActions.append(confirmImportButton, cancelImportButton);
    importRegion.append(node("h3", "", "检查备份"), importText, importActions);
    const list = node("div", "bcm-note-list");
    list.setAttribute("aria-label", "场景记录列表");
    const pagination = node("nav", "bcm-pagination");
    pagination.setAttribute("aria-label", "记录分页");
    const previousButton = button("上一页", async () => {
      offset = Math.max(0, offset - PAGE_SIZE);
      await refresh();
      scroll.scrollTop = 0;
    });
    const pageLabel = node("span", "bcm-page-label");
    const nextButton = button("下一页", async () => {
      offset += PAGE_SIZE;
      await refresh();
      scroll.scrollTop = 0;
    });
    pagination.append(previousButton, pageLabel, nextButton);
    pagination.hidden = true;
    const footer = node("p", "bcm-storage-note", "记录保存在当前浏览器。清理站点数据前，请导出 JSON 备份。");
    scroll.append(filters, notices, undoRegion, importRegion, list, pagination, footer);
    const fileInput = node("input");
    fileInput.type = "file";
    fileInput.accept = ".json,application/json";
    fileInput.hidden = true;
    element.append(header, scroll, fileInput);
    const observer = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        loadImage(entry.target, entry.target.dataset.noteId, Number(entry.target.dataset.generation));
      }
    }, { root: scroll, rootMargin: "200px" }) : null;
    function setNotice(message, error = false) {
      noticeText.textContent = message;
      notices.hidden = !message;
      notices.classList.toggle("bcm-notice-error", error);
      retryLoading.hidden = true;
      retryDrafts.hidden = ![...drafts.values()].some((draft) => draft.dirty && draft.error);
    }
    function signalChange() {
      Promise.resolve().then(() => onChange()).catch((error) => console.warn("[场景记录库] 计数刷新失败", error));
    }
    function updateSaveState(id) {
      const view = controls.get(id);
      if (!view) return;
      const draft = drafts.get(id);
      const text2 = draft?.error ? "保存失败，草稿已保留" : draft?.saving ? "保存中…" : draft?.dirty ? "等待保存…" : "已保存";
      view.saveState.textContent = text2;
      view.saveState.classList.toggle("bcm-save-error", Boolean(draft?.error));
    }
    function queueDraft(id, patch) {
      const draft = drafts.get(id) || { patch: {}, values: {}, revision: 0, dirty: false, saving: null, timer: null, error: null };
      draft.patch = { ...draft.patch, ...patch };
      draft.values = { ...draft.values, ...patch };
      draft.revision += 1;
      draft.dirty = true;
      draft.error = null;
      drafts.set(id, draft);
      clearTimeout(draft.timer);
      draft.timer = setTimeout(() => saveDraft(id), SAVE_DELAY);
      updateSaveState(id);
    }
    async function saveDraft(id) {
      const draft = drafts.get(id);
      if (!draft) return true;
      clearTimeout(draft.timer);
      if (draft.saving) return draft.saving;
      if (!draft.dirty) return true;
      draft.error = null;
      draft.saving = (async () => {
        await Promise.resolve();
        try {
          while (draft.dirty) {
            const revision = draft.revision;
            const patch = { ...draft.patch };
            const saved = await repo.update(id, patch);
            if (draft.revision === revision) {
              draft.savedAt = saved?.updatedAt;
              draft.dirty = false;
              draft.patch = {};
            }
          }
          return true;
        } catch (error) {
          draft.error = error;
          setNotice(`备注保存失败：${readableError(error)}。草稿仍保留在当前页面，请重试保存。`, true);
          return false;
        } finally {
          draft.saving = null;
          updateSaveState(id);
        }
      })();
      updateSaveState(id);
      return draft.saving;
    }
    async function flushDrafts() {
      const results = await Promise.all([...drafts.keys()].map((id) => saveDraft(id)));
      retryDrafts.hidden = ![...drafts.values()].some((draft) => draft.dirty && draft.error);
      return results.every(Boolean);
    }
    function clearImages() {
      observer?.disconnect();
      for (const url of imageUrls) URL.revokeObjectURL(url);
      imageUrls.clear();
    }
    function imageSource(note) {
      if (note?.imageBlob instanceof Blob && /^image\/(jpeg|png|webp)$/i.test(note.imageBlob.type)) {
        const url = URL.createObjectURL(note.imageBlob);
        imageUrls.add(url);
        return url;
      }
      return /^data:image\/(jpeg|png|webp);base64,/i.test(note?.imageUrl || "") ? note.imageUrl : null;
    }
    function showImage(container, note) {
      const src = imageSource(note);
      if (!src) {
        container.textContent = "图片不可用，仍可回听原视频。";
        return;
      }
      const image = node("img", "bcm-note-image");
      image.alt = `${episodeTitle(note)} ${timeLabel(note)} 的记录画面`;
      image.loading = "lazy";
      image.decoding = "async";
      image.addEventListener("error", () => {
        container.textContent = "图片无法显示，仍可回听原视频。";
      });
      image.src = src;
      container.replaceChildren(image);
    }
    async function loadImage(container, id, generation) {
      if (disposed || generation !== renderGeneration || container.dataset.loaded) return;
      container.dataset.loaded = "true";
      try {
        const note = await repo.get(id);
        if (disposed || generation !== renderGeneration || !container.isConnected) return;
        showImage(container, note);
      } catch {
        if (!disposed && generation === renderGeneration) container.textContent = "图片无法加载，仍可回听原视频。";
      }
    }
    async function playNote(note, control) {
      control.disabled = true;
      try {
        if (!await flushDrafts()) {
          setNotice("请先重试保存备注，再回听，以免切换视频时丢失草稿。", true);
          return;
        }
        const result = await player.seek(note, { leadIn: LEAD_IN });
        if (result?.navigated) return;
        const current = player.getCurrent?.();
        const sourceId = note.source?.sourceId || normalizeSource(note.source?.url)?.sourceId;
        if (!current?.sourceReady || sourceId && current.identity?.source?.sourceId !== sourceId) {
          throw new Error("视频正在切换，请画面就绪后重试");
        }
        if (typeof current.media?.play !== "function") throw new Error("播放器暂时无法播放，请手动继续");
        await current.media.play();
      } catch (error) {
        const message = `回听失败：${readableError(error)}`;
        setNotice(message, true);
        notify(message, { kind: "error" });
      } finally {
        control.disabled = false;
      }
    }
    function renderNote(note) {
      let draft = drafts.get(note.id);
      if (draft && !draft.dirty && !draft.saving && (note.updatedAt > draft.savedAt || note.userNote === draft.values.userNote)) {
        drafts.delete(note.id);
        draft = null;
      }
      const data = { ...note, ...draft?.values || {} };
      const article = node("article", "bcm-note");
      article.dataset.noteId = note.id;
      const tags = node("div", "bcm-meta-tags");
      tags.append(node("span", "bcm-tag-series", seriesTitle(note)), node("span", "bcm-tag-episode", episodeTitle(note)));
      const removeButton = button("删除", async () => {
        removeButton.disabled = true;
        try {
          if (!await saveDraft(note.id)) return;
          const previous = await repo.remove(note.id);
          drafts.delete(note.id);
          if (previous) {
            undoNote = previous;
            undoRegion.hidden = false;
          }
          signalChange();
          await refresh();
        } catch (error) {
          setNotice(`删除失败：${readableError(error)}。请重试。`, true);
        } finally {
          removeButton.disabled = false;
        }
      }, "bcm-button-quiet bcm-delete");
      removeButton.setAttribute("aria-label", `删除 ${timeLabel(note)} 的记录`);
      const imageContainer = node("div", "bcm-image-placeholder", "正在载入场景…");
      imageContainer.dataset.noteId = note.id;
      imageContainer.dataset.generation = String(renderGeneration);
      const playback = node("div", "bcm-playback-row");
      const playButton = button(`${timeLabel(note)} · 回听此句`, () => playNote(note, playButton), "bcm-button bcm-play-button");
      playButton.title = `提前 ${LEAD_IN} 秒回听`;
      playback.append(playButton, removeButton);
      const noteInput = node("textarea", "bcm-input bcm-note-input");
      noteInput.rows = 2;
      noteInput.maxLength = 1e5;
      noteInput.setAttribute("aria-label", `${episodeTitle(note)} ${timeLabel(note)} 的备注`);
      noteInput.placeholder = "写下这句想学的词、短语或表达，方便导出后给 AI 整理制卡…";
      noteInput.value = data.userNote || "";
      noteInput.addEventListener("input", () => queueDraft(note.id, { userNote: noteInput.value }));
      noteInput.addEventListener("blur", () => saveDraft(note.id));
      const saveState = node("span", "bcm-save-state");
      saveState.setAttribute("role", "status");
      article.append(tags);
      if (note.hasImage || note.imageUrl || note.imageBlob) {
        article.append(imageContainer);
        if (observer) observer.observe(imageContainer);
        else setTimeout(() => loadImage(imageContainer, note.id, Number(imageContainer.dataset.generation)), 0);
      }
      article.append(playback, field("备注", noteInput), saveState);
      controls.set(note.id, { saveState, noteInput });
      updateSaveState(note.id);
      return article;
    }
    function scopeFilter() {
      const scope = scopeSelect.value;
      const identity = player.getCurrent?.()?.identity;
      if (scope === "all") return {};
      if (!identity?.seriesId) return null;
      if (scope === "series") return { seriesId: identity.seriesId };
      return identity.source?.sourceId ? { sourceId: identity.source.sourceId } : null;
    }
    async function refresh() {
      if (disposed) return;
      const generation = ++refreshGeneration;
      await flushDrafts();
      if (disposed || generation !== refreshGeneration || !opened) return;
      const filters2 = scopeFilter();
      const query = searchInput.value.trim();
      list.setAttribute("aria-busy", "true");
      previousButton.disabled = true;
      nextButton.disabled = true;
      if (!resultSummary.textContent) resultSummary.textContent = "正在加载记录…";
      try {
        const [result, scopeTotal] = filters2 ? await Promise.all([
          repo.list({ ...filters2, query, offset, limit: PAGE_SIZE }),
          query ? repo.count(filters2.seriesId, filters2.sourceId) : null
        ]) : [{ notes: [], total: 0 }, null];
        if (disposed || generation !== refreshGeneration || !opened) return;
        total = result.total;
        if (offset > 0 && offset >= total) {
          offset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
          return refresh();
        }
        renderGeneration += 1;
        clearImages();
        const active = getDeepActiveElement();
        const editing = [...controls.entries()].find(([, view]) => view.noteInput === active)?.[0];
        controls.clear();
        const fragment = document.createDocumentFragment();
        for (const note of result.notes) fragment.append(renderNote(note));
        if (!result.notes.length) {
          const empty = node("div", "bcm-empty");
          empty.append(node("h3", "", !filters2 ? "当前没有可用的视频" : query ? "没有匹配的记录" : "还没有场景记录"));
          empty.append(node("p", "", !filters2 ? "切换到「全部记录」查看历史，或打开一个视频。" : query ? "试试其他关键词，或扩大查看范围。" : "遇到想再听的片段，点播放器上方的「记录」。"));
          fragment.append(empty);
        }
        list.replaceChildren(fragment);
        const resumedInput = controls.get(editing)?.noteInput;
        if (resumedInput) {
          resumedInput.focus({ preventScroll: true });
          resumedInput.setSelectionRange?.(active.selectionStart, active.selectionEnd);
        }
        resultSummary.textContent = `${scopeCounts[scopeSelect.value]}共 ${formatCount.format(scopeTotal ?? total)} 条记录${query ? ` · 匹配 ${formatCount.format(total)} 条` : ""}`;
        pageLabel.textContent = `${Math.floor(offset / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))}`;
        previousButton.disabled = offset === 0;
        nextButton.disabled = offset + PAGE_SIZE >= total;
        pagination.hidden = total <= PAGE_SIZE;
      } catch (error) {
        if (generation === refreshGeneration) {
          resultSummary.textContent = "记录加载失败";
          setNotice(`无法读取记录：${readableError(error)}。请重新加载。`, true);
          retryLoading.hidden = false;
        }
      } finally {
        if (generation === refreshGeneration) list.removeAttribute("aria-busy");
      }
    }
    function refreshSource() {
      if (!opened || scopeSelect.value === "all") return;
      offset = 0;
      void refresh();
    }
    async function download(format, extension, mime, serialize, action) {
      const filters2 = scopeFilter();
      if (!filters2) {
        setNotice("当前没有可用的视频。请选择「全部记录」再导出。", true);
        return;
      }
      const scopeLabel = scopeLabels.get(scopeSelect.value);
      const query = searchInput.value.trim();
      action.disabled = true;
      try {
        if (!await flushDrafts()) throw new Error("请先重试保存备注");
        const data = await repo.exportBackup({ ...filters2, query, includeImages: extension !== "md" });
        if (disposed) return;
        if (data.notes.length === 0) {
          setNotice("当前范围没有可导出的记录。");
          return;
        }
        const blob = new Blob([serialize(data, scopeLabel)], { type: `${mime};charset=utf-8` });
        downloadBlob(blob, `B站场景记录_${scopeLabel}_${formatDate.format(new Date(data.exportedAt))}.${extension}`);
        setNotice(`已导出 ${data.notes.length} 条记录 · ${format}`);
      } catch (error) {
        setNotice(`${format} 导出失败：${readableError(error)}`, true);
      } finally {
        action.disabled = false;
      }
    }
    async function previewFile() {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (!file) return;
      importButton.disabled = true;
      importButton.textContent = "正在检查…";
      importData = null;
      importRegion.hidden = true;
      try {
        if (file.size > 150 * 1024 * 1024) throw new Error("文件超过 150 MiB，请使用较小的完整备份");
        const data = JSON.parse(await file.text());
        const preview = await repo.previewImport(data);
        if (disposed) return;
        importData = data;
        importText.textContent = `${file.name} · 共 ${preview.total} 条，新增 ${preview.newCount} 条，保留已有 ${preview.existing} 条。`;
        confirmImportButton.disabled = preview.newCount === 0;
        importRegion.hidden = false;
        if (opened) confirmImportButton.focus();
      } catch (error) {
        setNotice(`备份无法导入：${readableError(error)}。请选择此工具导出的完整 JSON 备份。`, true);
      } finally {
        importButton.disabled = false;
        importButton.textContent = "导入备份";
      }
    }
    async function confirmImport() {
      if (!importData) return;
      confirmImportButton.disabled = true;
      cancelImportButton.disabled = true;
      importButton.disabled = true;
      confirmImportButton.textContent = "正在导入…";
      try {
        if (!await flushDrafts()) throw new Error("请先重试保存备注");
        const result = await repo.importBackup(importData);
        importData = null;
        importRegion.hidden = true;
        setNotice(`导入完成：新增 ${result.imported} 条，保留已有 ${result.skipped} 条。`);
        signalChange();
        offset = 0;
        await refresh();
      } catch (error) {
        setNotice(`导入失败：${readableError(error)}。可以重试。`, true);
      } finally {
        confirmImportButton.disabled = false;
        cancelImportButton.disabled = false;
        importButton.disabled = false;
        confirmImportButton.textContent = "确认导入";
      }
    }
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        offset = 0;
        refresh();
      }, 250);
    });
    scopeSelect.addEventListener("change", () => {
      offset = 0;
      return refresh();
    });
    fileInput.addEventListener("change", previewFile);
    function protectDrafts(event) {
      if (![...drafts.values()].some((draft) => draft.dirty || draft.saving)) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", protectDrafts);
    async function open() {
      if (disposed) return;
      if (!opened) returnFocus = getDeepActiveElement();
      opened = true;
      element.hidden = false;
      element.inert = false;
      element.focus({ preventScroll: true });
      await refresh();
    }
    function close() {
      if (closing) return closing;
      if (!opened) return Promise.resolve();
      closing = (async () => {
        const saved = await flushDrafts();
        opened = false;
        refreshGeneration += 1;
        renderGeneration += 1;
        clearImages();
        clearTimeout(searchTimer);
        element.hidden = true;
        element.inert = true;
        if (returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus({ preventScroll: true });
        if (!saved) notify("备注尚未保存，草稿保留在当前页面。请重新打开记录库重试。");
      })().finally(() => {
        closing = null;
      });
      return closing;
    }
    async function dispose() {
      await flushDrafts();
      disposed = true;
      opened = false;
      refreshGeneration += 1;
      renderGeneration += 1;
      clearTimeout(searchTimer);
      window.removeEventListener("beforeunload", protectDrafts);
      for (const draft of drafts.values()) clearTimeout(draft.timer);
      clearImages();
      controls.clear();
      element.remove();
    }
    return { element, open, close, toggle: () => opened ? close() : open(), refresh, refreshSource, dispose, isOpen: () => opened, flushDrafts };
  }

  // src/app.css
  var app_default = '.bcm-root, .bcm-theme {\n  --bcm-bg: #ffffff;\n  --bcm-subtle: #f7f8fa;\n  --bcm-hover: #f0f2f5;\n  --bcm-line: #e5e7eb;\n  --bcm-line-strong: #d1d5db;\n  --bcm-text: #111827;\n  --bcm-muted: #6b7280;\n  --bcm-primary: #18181b;\n  --bcm-primary-hover: #27272a;\n  --bcm-primary-ink: #ffffff;\n  --bcm-focus: #2563eb;\n  --bcm-danger: #b91c1c;\n  --bcm-danger-bg: #fef2f2;\n  --bcm-shadow: 0 12px 32px rgb(15 23 42 / 10%), 0 2px 6px rgb(15 23 42 / 5%);\n  --bcm-dock-right: 176px;\n  color-scheme: light;\n}\n\n.bcm-root {\n  position: fixed;\n  inset: 0;\n  z-index: 2147483000;\n  pointer-events: none;\n  color: var(--bcm-text);\n  font: 14px/1.5 system-ui, "Microsoft YaHei", sans-serif;\n  text-align: start;\n}\n\n.bcm-root [hidden], .bcm-dock[hidden], .bcm-mask[hidden] { display: none !important; }\n.bcm-root *, .bcm-dock, .bcm-dock *, .bcm-mask * { box-sizing: border-box; }\n.bcm-root :focus-visible, .bcm-theme :focus-visible { outline: 2px solid var(--bcm-focus); outline-offset: 2px; }\n.bcm-root button, .bcm-root input, .bcm-root select, .bcm-root textarea, .bcm-theme button { font: inherit; }\n.bcm-root ::selection { background: #dbeafe; color: var(--bcm-text); }\n.bcm-root button:disabled { opacity: .55; cursor: default; }\n.bcm-root .bcm-notebook { z-index: 10; }\n.bcm-root .bcm-panel { z-index: 20; }\n.bcm-root .bcm-notification { z-index: 30; }\n\n.bcm-mask {\n  position: absolute !important;\n  z-index: 25 !important;\n  box-sizing: border-box !important;\n  user-select: none;\n  touch-action: none;\n  cursor: pointer;\n  pointer-events: auto;\n  background: transparent;\n  backdrop-filter: blur(var(--bcm-blur, 14px));\n  -webkit-backdrop-filter: blur(var(--bcm-blur, 14px));\n  mask-image: linear-gradient(to right, transparent, #000 5%, #000 95%, transparent),\n    linear-gradient(to bottom, transparent, #000 16%, #000 84%, transparent);\n  mask-composite: intersect;\n  -webkit-mask-image: linear-gradient(to right, transparent, #000 5%, #000 95%, transparent),\n    linear-gradient(to bottom, transparent, #000 16%, #000 84%, transparent);\n  -webkit-mask-composite: source-in;\n}\n\n.bcm-mask.bcm-solid { background: var(--bcm-primary); backdrop-filter: none; -webkit-backdrop-filter: none; }\n.bcm-mask:not(.bcm-edit):not(.bcm-wheeling):hover, .bcm-mask.bcm-peek:not(.bcm-edit):not(.bcm-wheeling) {\n  background: transparent;\n  backdrop-filter: none;\n  -webkit-backdrop-filter: none;\n  mask-image: none;\n  -webkit-mask-image: none;\n}\n\n.bcm-mask.bcm-edit, .bcm-mask.bcm-wheeling {\n  mask-image: none;\n  -webkit-mask-image: none;\n  outline: 1.5px solid var(--bcm-focus);\n  background: rgb(255 255 255 / 18%);\n  backdrop-filter: blur(3px);\n  cursor: move;\n}\n\n.bcm-mask .bcm-mask-tools {\n  position: absolute;\n  bottom: calc(100% + 8px);\n  right: 0;\n  display: none;\n  align-items: center;\n  gap: 8px;\n  width: max-content;\n  padding: 4px 6px 4px 10px;\n  border: 1px solid var(--bcm-line);\n  border-radius: 8px;\n  background: var(--bcm-bg);\n  color: var(--bcm-text);\n  box-shadow: var(--bcm-shadow);\n  font: 12px/1.5 system-ui, "Microsoft YaHei", sans-serif;\n}\n\n.bcm-mask.bcm-edit .bcm-mask-tools { display: flex; }\n.bcm-mask-tools button, .bcm-dock button {\n  appearance: none;\n  margin: 0;\n  min-height: 30px;\n  padding: 5px 8px;\n  border: 0;\n  border-radius: 5px;\n  background: transparent;\n  color: inherit;\n  white-space: nowrap;\n  cursor: pointer;\n}\n.bcm-mask-tools button { background: var(--bcm-subtle); }\n.bcm-dock button:hover, .bcm-mask-tools button:hover, .bcm-dock button[aria-pressed="true"] { background: var(--bcm-hover); }\n.bcm-handle {\n  display: none;\n  position: absolute;\n  width: 12px;\n  height: 12px;\n  background: var(--bcm-bg);\n  border: 1px solid var(--bcm-primary);\n  border-radius: 4px;\n}\n.bcm-edit .bcm-handle { display: block; }\n.bcm-handle[data-handle="n"] { top: -6px; left: calc(50% - 6px); cursor: ns-resize; }\n.bcm-handle[data-handle="s"] { bottom: -6px; left: calc(50% - 6px); cursor: ns-resize; }\n.bcm-handle[data-handle="e"] { right: -6px; top: calc(50% - 6px); cursor: ew-resize; }\n.bcm-handle[data-handle="w"] { left: -6px; top: calc(50% - 6px); cursor: ew-resize; }\n.bcm-handle[data-handle="nw"] { top: -6px; left: -6px; cursor: nwse-resize; }\n.bcm-handle[data-handle="ne"] { top: -6px; right: -6px; cursor: nesw-resize; }\n.bcm-handle[data-handle="sw"] { bottom: -6px; left: -6px; cursor: nesw-resize; }\n.bcm-handle[data-handle="se"] { bottom: -6px; right: -6px; cursor: nwse-resize; }\n\n.bcm-dock {\n  position: absolute;\n  top: 12px;\n  right: var(--bcm-dock-right, 176px);\n  z-index: 100;\n  display: flex;\n  flex-wrap: nowrap;\n  align-items: center;\n  gap: 2px;\n  max-width: calc(100% - 24px);\n  padding: 4px 6px;\n  border: 1px solid rgb(15 23 42 / 8%);\n  border-radius: 10px;\n  background: rgb(255 255 255 / 92%);\n  color: var(--bcm-primary);\n  backdrop-filter: blur(12px);\n  box-shadow: 0 4px 14px rgb(15 23 42 / 10%);\n  font: 12px/1.4 system-ui, "Microsoft YaHei", sans-serif;\n  font-variant-numeric: tabular-nums;\n  transition: opacity .2s ease;\n  pointer-events: auto;\n}\n.bcm-dock.bcm-idle:not(:hover):not(:focus-within) { opacity: 0; pointer-events: none; }\n.bcm-dock .bcm-version-button { color: var(--bcm-muted); }\n\n.bcm-notification {\n  position: absolute;\n  top: 16px;\n  left: 50%;\n  transform: translateX(-50%);\n  width: max-content;\n  max-width: min(620px, var(--bcm-toast-max-width, calc(100% - 32px)));\n  padding: 8px 14px;\n  border: 1px solid var(--bcm-line);\n  border-radius: 20px;\n  background: var(--bcm-bg);\n  color: var(--bcm-text);\n  box-shadow: var(--bcm-shadow);\n  overflow-wrap: anywhere;\n  pointer-events: none;\n}\n.bcm-notification[data-kind="success"] { font-size: 13px; font-variant-numeric: tabular-nums; }\n.bcm-notification[data-kind="error"] { color: var(--bcm-danger); }\n\n.bcm-panel {\n  position: absolute;\n  top: 14px;\n  right: 14px;\n  width: min(414px, calc(100% - 28px));\n  max-height: calc(100% - 28px);\n  overflow: auto;\n  overscroll-behavior: contain;\n  padding: 22px;\n  border: 1px solid var(--bcm-line);\n  border-radius: 14px;\n  background: var(--bcm-bg);\n  color: var(--bcm-text);\n  box-shadow: var(--bcm-shadow);\n  pointer-events: auto;\n}\n.bcm-panel h2 { margin: 0 0 8px; font-size: 21px; font-weight: 700; }\n.bcm-panel p { margin: 8px 0 16px; color: var(--bcm-muted); }\n.bcm-panel form > label {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(0, 142px);\n  align-items: center;\n  gap: 8px;\n  margin: 10px 0;\n}\n.bcm-panel input, .bcm-panel select {\n  width: 100%;\n  min-width: 0;\n  min-height: 36px;\n  margin: 0;\n  padding: 6px 8px;\n  border: 1px solid var(--bcm-line-strong);\n  border-radius: 6px;\n  background: var(--bcm-bg);\n  color: var(--bcm-text);\n}\n.bcm-panel button {\n  min-height: 34px;\n  margin: 0;\n  padding: 6px 11px;\n  border: 1px solid var(--bcm-line-strong);\n  border-radius: 6px;\n  background: var(--bcm-bg);\n  color: var(--bcm-text);\n  cursor: pointer;\n}\n.bcm-panel button:hover { background: var(--bcm-hover); }\n.bcm-panel .bcm-primary {\n  border-color: var(--bcm-primary);\n  background: var(--bcm-primary);\n  color: var(--bcm-primary-ink);\n}\n.bcm-panel .bcm-primary:hover { background: var(--bcm-primary-hover); }\n.bcm-panel-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }\n\n.bcm-shortcut-section {\n  min-width: 0;\n  margin: 20px 0 0;\n  padding: 12px 0 0;\n  border: 0;\n  border-top: 1px solid var(--bcm-line);\n}\n.bcm-shortcut-section legend { padding: 0 8px 0 0; font-size: 15px; font-weight: 650; }\n.bcm-shortcut-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }\n.bcm-panel .bcm-shortcut-hint { margin: 0; font-size: 12px; }\n.bcm-panel .bcm-shortcut-reset, .bcm-panel .bcm-shortcut-clear { padding-inline: 8px; font-size: 12px; }\n.bcm-shortcut-row {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(0, 176px);\n  align-items: center;\n  gap: 8px;\n  margin: 8px 0;\n}\n.bcm-shortcut-label { font-size: 13px; overflow-wrap: anywhere; }\n.bcm-shortcut-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; align-items: center; }\n.bcm-panel .bcm-shortcut-input, .bcm-panel kbd {\n  background: var(--bcm-subtle);\n  font: 12px/1.5 ui-monospace, Consolas, "Microsoft YaHei", monospace;\n  text-align: center;\n}\n.bcm-panel .bcm-shortcut-input { cursor: pointer; }\n.bcm-panel .bcm-shortcut-input[data-recording="true"] { border-color: var(--bcm-focus); background: var(--bcm-bg); }\n.bcm-panel kbd { display: inline-block; padding: 2px 6px; border: 1px solid var(--bcm-line); border-radius: 4px; }\n.bcm-panel dl {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);\n  align-items: baseline;\n  gap: 10px 8px;\n  margin: 12px 0 16px;\n  padding: 12px 0;\n  border-block: 1px solid var(--bcm-line);\n}\n.bcm-panel dt { font-weight: 600; }\n.bcm-panel dd { margin: 0; color: var(--bcm-muted); }\n\n@media (max-width: 640px) {\n  .bcm-dock { top: 48px; right: 12px; flex-wrap: wrap; }\n}\n@media (max-width: 440px) {\n  .bcm-panel { padding: 16px; }\n  .bcm-shortcut-row { grid-template-columns: minmax(0, 1fr) minmax(0, 55%); }\n}\n@media (prefers-reduced-motion: reduce) { .bcm-dock { transition: none; } }\n';

  // src/notebook.css
  var notebook_default = ".bcm-notebook {\n  position: absolute;\n  inset-block: 0;\n  inset-inline-end: 0;\n  display: flex;\n  flex-direction: column;\n  box-sizing: border-box;\n  width: min(432px, 100%);\n  overflow: hidden;\n  border-inline-start: 1px solid var(--bcm-line);\n  background: var(--bcm-bg);\n  color: var(--bcm-text);\n  box-shadow: -12px 0 32px rgb(15 23 42 / 10%);\n  pointer-events: auto;\n}\n.bcm-notebook:focus { outline: none; }\n.bcm-notebook h2, .bcm-notebook h3, .bcm-notebook p { margin: 0; padding: 0; }\n.bcm-notebook-header {\n  flex: none;\n  padding: 18px 18px 16px;\n  border-block-end: 1px solid var(--bcm-line);\n  background: var(--bcm-bg);\n}\n.bcm-heading-row, .bcm-header-tools, .bcm-toolbar {\n  display: flex;\n  align-items: center;\n  flex-wrap: wrap;\n  gap: 6px;\n}\n.bcm-notebook .bcm-notebook-title {\n  margin-inline-end: auto;\n  font-size: 21px;\n  line-height: 1.3;\n  font-weight: 700;\n}\n.bcm-notebook .bcm-subtitle { margin-block: 4px 14px; color: var(--bcm-muted); }\n.bcm-notebook .bcm-button {\n  appearance: none;\n  min-height: 34px;\n  max-width: 100%;\n  margin: 0;\n  padding: 6px 8px;\n  border: 1px solid var(--bcm-line-strong);\n  border-radius: 6px;\n  background: var(--bcm-bg);\n  color: var(--bcm-text);\n  font-size: 13px;\n  line-height: 1.35;\n  text-align: center;\n  overflow-wrap: anywhere;\n  cursor: pointer;\n  touch-action: manipulation;\n}\n.bcm-notebook .bcm-button:hover:not(:disabled) { background: var(--bcm-hover); }\n.bcm-notebook .bcm-button-primary {\n  border-color: var(--bcm-primary);\n  background: var(--bcm-primary);\n  color: var(--bcm-primary-ink);\n  font-weight: 600;\n}\n.bcm-notebook .bcm-button-primary:hover:not(:disabled) { background: var(--bcm-primary-hover); }\n.bcm-notebook .bcm-button-quiet { background: transparent; border-color: transparent; }\n.bcm-notebook .bcm-delete { color: var(--bcm-muted); }\n.bcm-notebook .bcm-delete:hover:not(:disabled) { color: var(--bcm-danger); background: var(--bcm-danger-bg); }\n\n.bcm-notebook-scroll {\n  flex: 1;\n  min-height: 0;\n  overflow: auto;\n  overscroll-behavior: contain;\n  scrollbar-color: var(--bcm-line-strong) var(--bcm-bg);\n  scrollbar-width: thin;\n}\n.bcm-filters { display: grid; gap: 8px; padding: 16px 18px 12px; }\n.bcm-field { display: grid; gap: 6px; min-width: 0; }\n.bcm-label { color: var(--bcm-muted); font-size: 12px; line-height: 1.4; }\n.bcm-filter-row { display: grid; grid-template-columns: minmax(0, 132px) minmax(0, 1fr); gap: 8px; }\n.bcm-notebook .bcm-input, .bcm-notebook .bcm-select {\n  appearance: auto;\n  display: block;\n  width: 100%;\n  min-width: 0;\n  min-height: 38px;\n  margin: 0;\n  padding: 7px 9px;\n  border: 1px solid var(--bcm-line-strong);\n  border-radius: 7px;\n  background: var(--bcm-bg);\n  color: var(--bcm-text);\n}\n.bcm-notebook .bcm-input::placeholder { color: var(--bcm-muted); opacity: 1; }\n.bcm-notebook textarea.bcm-input { min-height: 66px; resize: vertical; overflow-wrap: anywhere; background: var(--bcm-subtle); }\n.bcm-notebook textarea.bcm-input:focus { background: var(--bcm-bg); }\n.bcm-result-summary, .bcm-page-label, .bcm-save-state {\n  color: var(--bcm-muted);\n  font-size: 12px;\n  font-variant-numeric: tabular-nums;\n}\n.bcm-notices, .bcm-undo, .bcm-import-preview {\n  margin: 0 18px 12px;\n  padding: 10px 12px;\n  border: 1px solid var(--bcm-line);\n  border-radius: 8px;\n  background: var(--bcm-subtle);\n  overflow-wrap: anywhere;\n}\n.bcm-notices, .bcm-undo { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }\n.bcm-notices > span, .bcm-undo > span { flex: 1 1 180px; }\n.bcm-notice-error { color: var(--bcm-danger); background: var(--bcm-danger-bg); }\n.bcm-notebook .bcm-import-preview h3 { font-size: 15px; margin-block-end: 6px; }\n.bcm-notebook .bcm-import-preview p { margin-block-end: 10px; }\n\n.bcm-note-list { padding-inline: 18px; }\n.bcm-note {\n  display: grid;\n  min-width: 0;\n  gap: 10px;\n  padding-block: 16px 18px;\n  border-block-start: 1px solid var(--bcm-line);\n}\n.bcm-meta-tags { display: flex; flex-wrap: wrap; gap: 5px; min-width: 0; }\n.bcm-tag-series, .bcm-tag-episode {\n  max-width: 100%;\n  padding: 3px 8px;\n  border: 1px solid var(--bcm-line);\n  border-radius: 14px;\n  background: var(--bcm-subtle);\n  color: #374151;\n  font-size: 12px;\n  overflow-wrap: anywhere;\n}\n.bcm-tag-series { font-weight: 600; }\n.bcm-tag-episode { background: var(--bcm-bg); }\n.bcm-image-placeholder {\n  display: grid;\n  place-items: center;\n  aspect-ratio: 16 / 9;\n  overflow: hidden;\n  border-radius: 8px;\n  background: var(--bcm-subtle);\n  color: var(--bcm-muted);\n  font-size: 13px;\n  text-align: center;\n}\n.bcm-note-image { display: block; width: 100%; height: 100%; min-height: 0; object-fit: contain; }\n.bcm-playback-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }\n.bcm-notebook .bcm-play-button { font-variant-numeric: tabular-nums; font-weight: 600; }\n.bcm-save-state { text-align: end; }\n.bcm-save-error { color: var(--bcm-danger); }\n.bcm-empty { padding: 26px 0; border-block-start: 1px solid var(--bcm-line); color: var(--bcm-muted); }\n.bcm-notebook .bcm-empty h3 { margin-block-end: 6px; color: var(--bcm-text); font-size: 16px; }\n.bcm-pagination {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  flex-wrap: wrap;\n  gap: 8px;\n  padding: 12px 18px;\n  border-block-start: 1px solid var(--bcm-line);\n}\n.bcm-notebook .bcm-storage-note { padding: 12px 18px 18px; color: var(--bcm-muted); font-size: 12px; }\n\n@media (max-width: 440px) {\n  .bcm-notebook-header, .bcm-filters, .bcm-note-list, .bcm-pagination { padding-inline: 12px; }\n  .bcm-notebook-header .bcm-toolbar .bcm-button { padding-inline: 6px; font-size: 12px; }\n  .bcm-notices, .bcm-undo, .bcm-import-preview { margin-inline: 12px; }\n  .bcm-notebook .bcm-input, .bcm-notebook .bcm-select { font-size: 16px; }\n}\n@media (max-height: 420px) {\n  .bcm-notebook-header { padding-block: 8px; }\n  .bcm-notebook .bcm-subtitle { display: none; }\n  .bcm-notebook-header .bcm-toolbar { margin-block-start: 6px; }\n}\n@media (forced-colors: active) {\n  .bcm-notebook { border-color: CanvasText; }\n  .bcm-notebook .bcm-button { border-color: ButtonText; }\n}\n";

  // src/main.js
  var VERSION = "3.0.1";
  var clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  var BUTTON_LIKE = 'button, a[href], summary, [role="button"], [role="link"]';
  var SLIDER_LIKE = 'input[type="range"], [role="slider"]';
  var SLIDER_KEYS = /* @__PURE__ */ new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);
  function yieldsToFocusedControl(event, spec) {
    const selector = spec === "Space" || spec === "Enter" ? BUTTON_LIKE : SLIDER_KEYS.has(spec) ? SLIDER_LIKE : null;
    return selector && (getDeepActiveElement()?.closest?.(selector) || event.composedPath().some((node2) => node2.matches?.(selector)));
  }
  function el(tag, className, text2) {
    const node2 = document.createElement(tag);
    if (className) node2.className = className;
    if (text2 !== void 0) node2.textContent = text2;
    return node2;
  }
  function button2(text2, action, className = "") {
    const node2 = el("button", className, text2);
    node2.type = "button";
    node2.addEventListener("click", (event) => {
      event.stopPropagation();
      action(event);
    });
    return node2;
  }
  function start() {
    if (document.getElementById("bcm-app")) return;
    const root = el("div", "bcm-root");
    root.id = "bcm-app";
    root.dataset.version = VERSION;
    const style = el("style");
    style.id = "bcm-styles";
    style.textContent = app_default + "\n" + notebook_default;
    (document.head || document.documentElement).append(style);
    document.body.append(root);
    let local;
    try {
      local = window.localStorage;
    } catch {
    }
    const gmGet = typeof GM_getValue === "function" ? GM_getValue : void 0;
    const gmSet = typeof GM_setValue === "function" ? GM_setValue : void 0;
    const repo = createRepository({ localStorage: local, gmGet, gmSet });
    const settings = createConfigStore({ localStorage: local, gmGet, gmSet, window });
    const player = createPlayerAdapter({ window, document });
    let snapshot = null, config, container, mask, dock, resizeObserver, mountAbort;
    let edit = false, peek = false, wheeling = false, captureBusy = false, initialized = false;
    let hideTimer, wheelTimer, saveTimer, toastTimer, frame, drag, configSeries;
    let countGeneration = 0, panelReturnFocus;
    let geometryDirty = false;
    const notification = el("div", "bcm-notification");
    notification.hidden = true;
    notification.setAttribute("role", "status");
    notification.setAttribute("aria-live", "polite");
    root.append(notification);
    function positionNotification() {
      if (notification.hidden) return;
      const viewport = root.getBoundingClientRect();
      const playerBox = container?.getBoundingClientRect();
      const inset = 8;
      if (playerBox && container.isConnected && getComputedStyle(container).visibility === "visible") {
        const left = Math.max(playerBox.left, viewport.left);
        const right = Math.min(playerBox.right, viewport.right);
        const top = Math.max(playerBox.top, viewport.top);
        const bottom = Math.min(playerBox.bottom, viewport.bottom);
        if (right - left > 32 && bottom - top > 32) {
          notification.style.setProperty("--bcm-toast-max-width", `${right - left - inset * 2}px`);
          const { width, height } = notification.getBoundingClientRect();
          const center = clamp(playerBox.left + playerBox.width / 2, left + width / 2 + inset, right - width / 2 - inset);
          const topLimit = Math.max(top, bottom - height - inset);
          notification.style.left = `${center - viewport.left}px`;
          notification.style.top = `${clamp(playerBox.top + 56, top, topLimit) - viewport.top}px`;
          return;
        }
      }
      notification.style.removeProperty("--bcm-toast-max-width");
      notification.style.removeProperty("left");
      notification.style.removeProperty("top");
    }
    function notify(message, { kind = "info", duration = kind === "error" ? 7e3 : 3e3 } = {}) {
      notification.textContent = message;
      notification.dataset.kind = kind;
      notification.hidden = false;
      positionNotification();
      notification.getAnimations().forEach((animation) => animation.cancel());
      if (duration === 1600 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        notification.animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: 0.88 }, { opacity: 0 }], duration);
      }
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        notification.hidden = true;
      }, duration);
    }
    const fail2 = (error) => notify(error?.message || "操作失败，请重试。", { kind: "error" });
    const panel = el("section", "bcm-panel");
    panel.hidden = true;
    panel.inert = true;
    root.append(panel);
    function closePanel() {
      panel.hidden = true;
      panel.inert = true;
      if (panelReturnFocus?.isConnected) panelReturnFocus.focus();
      wakeDock();
    }
    function showPanel(title) {
      panelReturnFocus = getDeepActiveElement();
      panel.replaceChildren(el("h2", "", title));
      panel.setAttribute("aria-label", title);
      panel.hidden = false;
      panel.inert = false;
      wakeDock();
    }
    function showHelp() {
      const shortcuts = settings.get(snapshot?.identity.seriesId).shortcuts;
      showPanel("操作帮助");
      const captureHint = shortcuts.capture ? `按 ${formatShortcut(shortcuts.capture)}` : "点击「记录」";
      panel.append(el("p", "", `看剧时${captureHint}即可静默记录。看完一集，打开记录库回听、写备注，再导出 JSON 或 Markdown。`));
      const list = el("dl");
      for (const { id, label } of SHORTCUT_ACTIONS) {
        const description = el("dd");
        description.append(el("kbd", "", formatShortcut(shortcuts[id])));
        if (id === "peek") description.append(" 也可悬停在遮罩上");
        list.append(el("dt", "", label), description);
      }
      list.append(el("dt", "", "微调遮罩高度"), el("dd", "", "在播放器内按 Alt + 滚轮"));
      panel.append(list, el("p", "", "记录保存在当前浏览器。JSON 含截图并可重新导入，Markdown 用于整理文字，HTML 可离线查看截图和备注。"));
      const done = button2("关闭", closePanel, "bcm-primary");
      panel.append(done);
      done.focus();
    }
    function showSettings() {
      if (!snapshot) return;
      config = settings.get(snapshot.identity.seriesId);
      showPanel("设置");
      panel.append(el("p", "", "遮罩位置按剧集保存，其他设置全局生效。"));
      const form = el("form");
      const inputs = /* @__PURE__ */ new Map();
      const add = (key, label, type, min, max, step) => {
        const row = el("label");
        row.append(el("span", "", label));
        const input = el(type === "select" ? "select" : "input");
        input.name = key;
        if (type === "select") {
          for (const [value, text2] of [["blur", "羽化模糊"], ["solid", "不透明遮挡"]]) {
            const opt = el("option", "", text2);
            opt.value = value;
            input.append(opt);
          }
          input.value = config[key];
        } else {
          input.type = type;
          input.value = config[key];
          input.min = min;
          input.max = max;
          input.step = step ?? 1;
          input.required = true;
        }
        row.append(input);
        form.append(row);
        inputs.set(key, input);
      };
      add("mode", "遮挡方式", "select");
      add("blur", "模糊强度", "number", 0, 40);
      const shortcutDrafts = { ...DEFAULT_SHORTCUTS, ...config.shortcuts || {} };
      const shortcutInputs = /* @__PURE__ */ new Map();
      const shortcutSection = el("fieldset", "bcm-shortcut-section");
      const shortcutHeader = el("div", "bcm-shortcut-header");
      shortcutSection.append(el("legend", "", "快捷键"));
      shortcutHeader.append(el("p", "bcm-shortcut-hint", "点击按键框录入，按 Esc 取消。"), button2("恢复默认快捷键", () => {
        Object.assign(shortcutDrafts, DEFAULT_SHORTCUTS);
        for (const action of SHORTCUT_ACTIONS) {
          const input = shortcutInputs.get(action.id);
          if (input) input.value = formatShortcut(shortcutDrafts[action.id]);
        }
      }, "bcm-shortcut-reset"));
      shortcutSection.append(shortcutHeader);
      for (const action of SHORTCUT_ACTIONS) {
        const row = el("div", "bcm-shortcut-row");
        const id = `bcm-shortcut-${action.id}`;
        const label = el("label", "bcm-shortcut-label", action.label);
        label.htmlFor = id;
        const control = el("div", "bcm-shortcut-control");
        const input = el("input", "bcm-shortcut-input");
        input.id = id;
        input.type = "text";
        input.readOnly = true;
        input.dataset.shortcutAction = action.id;
        input.setAttribute("aria-label", `${action.label}快捷键`);
        input.value = formatShortcut(shortcutDrafts[action.id]);
        let pendingModifier = null;
        input.addEventListener("focus", () => {
          pendingModifier = null;
          input.dataset.recording = "true";
          input.value = "请按下快捷键…";
        });
        input.addEventListener("blur", () => {
          delete input.dataset.recording;
          input.value = formatShortcut(shortcutDrafts[action.id]);
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Escape") {
            input.blur();
            return;
          }
          if (event.isComposing || event.repeat) return;
          const spec = eventToShortcut(event, { allowModifierOnly: action.allowModifierOnly });
          if (!spec) return;
          if (action.allowModifierOnly && ["Alt", "Shift", "Ctrl"].includes(spec)) {
            pendingModifier = spec;
            input.value = formatShortcut(spec);
          } else {
            pendingModifier = null;
            shortcutDrafts[action.id] = spec;
            input.blur();
          }
        });
        input.addEventListener("keyup", (event) => {
          if (pendingModifier && matchesPeekRelease(event, pendingModifier) && input.dataset.recording === "true") {
            event.preventDefault();
            event.stopPropagation();
            shortcutDrafts[action.id] = pendingModifier;
            pendingModifier = null;
            input.blur();
          }
        });
        const clearBtn = button2("禁用", () => {
          shortcutDrafts[action.id] = "";
          input.value = formatShortcut("");
        }, "bcm-shortcut-clear");
        clearBtn.setAttribute("aria-label", `禁用${action.label}快捷键`);
        control.append(input, clearBtn);
        row.append(label, control);
        shortcutSection.append(row);
        shortcutInputs.set(action.id, input);
      }
      form.append(shortcutSection);
      const actions = el("div", "bcm-panel-actions");
      const submit = el("button", "bcm-primary", "保存设置");
      submit.type = "submit";
      actions.append(submit, button2("重置本剧位置", () => {
        try {
          config = settings.reset(snapshot.identity.seriesId);
          paint();
          notify("本剧遮罩已恢复默认位置");
        } catch (error) {
          fail2(error);
        }
      }), button2("关闭", closePanel));
      form.append(actions);
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const patch = {};
        for (const [key, input] of inputs) patch[key] = input.tagName === "SELECT" ? input.value : Number(input.value);
        const conflict = findShortcutConflict(shortcutDrafts);
        if (conflict) {
          notify(`快捷键冲突：「${conflict.first.label}」与「${conflict.second.label}」不能同为 ${formatShortcut(conflict.shortcut)}`, { kind: "error" });
          return;
        }
        patch.shortcuts = { ...shortcutDrafts };
        try {
          config = settings.patch(snapshot.identity.seriesId, patch);
          peek = false;
          paint();
          closePanel();
          notify("设置已保存");
        } catch (error) {
          fail2(error);
        }
      });
      panel.append(form);
      inputs.get("mode").focus();
    }
    const notebook = createNotebook({
      repo,
      player,
      notify,
      version: VERSION,
      onChange: updateCount,
      onHelp: showHelp,
      onSettings: showSettings
    });
    root.append(notebook.element);
    async function updateCount() {
      const generation = ++countGeneration;
      const sid = snapshot?.identity.seriesId;
      if (!sid) return;
      try {
        const total = await repo.count(sid);
        if (generation === countGeneration && dock) dock.querySelector('[data-action="notebook"]').textContent = `记录库 ${total}`;
      } catch {
      }
    }
    function saveGeometry() {
      clearTimeout(saveTimer);
      saveTimer = null;
      if (!geometryDirty || !config || !configSeries) return;
      try {
        config = settings.patch(configSeries, { left: config.left, top: config.top, width: config.width, height: config.height });
        geometryDirty = false;
      } catch (error) {
        fail2(error);
      }
    }
    function paint() {
      frame = null;
      positionNotification();
      if (!mask || !snapshot || !config) return;
      const rect = player.getVideoRect();
      if (!rect) return;
      Object.assign(mask.style, {
        left: `${rect.left + rect.width * config.left / 100}px`,
        top: `${rect.top + rect.height * config.top / 100}px`,
        width: `${rect.width * config.width / 100}px`,
        height: `${rect.height * config.height / 100}px`
      });
      mask.style.setProperty("--bcm-blur", `${config.blur}px`);
      mask.hidden = !config.enabled;
      for (const [name, active] of [["bcm-edit", edit], ["bcm-peek", peek], ["bcm-wheeling", wheeling], ["bcm-solid", config.mode === "solid"]]) mask.classList.toggle(name, active);
      if (dock) {
        dock.querySelector('[data-action="toggle"]').textContent = config.enabled ? "遮罩 开" : "遮罩 关";
        dock.querySelector('[data-action="edit"]').textContent = edit ? "完成调节" : "调节";
        dock.querySelector('[data-action="toggle"]').setAttribute("aria-pressed", String(config.enabled));
        dock.querySelector('[data-action="edit"]').setAttribute("aria-pressed", String(edit));
      }
    }
    function schedulePaint() {
      if (frame == null) frame = requestAnimationFrame(paint);
    }
    function wakeDock() {
      if (!dock) return;
      dock.classList.remove("bcm-idle");
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (dock && !edit && !notebook.isOpen() && panel.hidden && !dock.matches(":hover,:focus-within")) dock.classList.add("bcm-idle");
      }, 2500);
    }
    function toggleEdit() {
      if (!snapshot) return;
      edit = !edit;
      if (edit && !config.enabled) config = settings.patch(configSeries, { enabled: true });
      paint();
      wakeDock();
      notify(edit ? "拖动遮罩或边缘手柄调整，完成后点击「完成调节」" : "遮罩已锁定");
    }
    function toggleMask() {
      if (snapshot) {
        config = settings.patch(configSeries, { enabled: !config.enabled });
        paint();
        wakeDock();
      }
    }
    async function capture() {
      if (captureBusy || !snapshot) return;
      captureBusy = true;
      try {
        const current = player.getCurrent();
        const time = player.getTime();
        let shot;
        try {
          shot = await player.capture();
        } catch (error) {
          if (!["FRAME_UNAVAILABLE", "CAPTURE_FAILED", "CAPTURE_TIMEOUT"].includes(error.code)) throw error;
          if (!current || time === null || !current.sourceReady) throw error;
          shot = { identity: current.identity, time, imageBlob: null };
        }
        const note = {
          id: `note_${crypto.randomUUID()}`,
          ...shot.identity,
          time: shot.time,
          timeStr: formatTime(shot.time),
          userNote: "",
          createdAt: Date.now()
        };
        if (shot.imageBlob) note.imageBlob = shot.imageBlob;
        await repo.save(note);
        notify(shot.imageBlob ? `已记录 ${note.timeStr}` : `已记录 ${note.timeStr}，截图不可用`, { kind: "success", duration: 1600 });
        void updateCount();
        if (notebook.isOpen()) void notebook.refresh();
      } catch (error) {
        fail2(error);
      } finally {
        captureBusy = false;
      }
    }
    function cancelDrag(save = true) {
      if (!drag) return;
      const pointer = drag.pointerId;
      drag = null;
      try {
        if (mask?.hasPointerCapture(pointer)) mask.releasePointerCapture(pointer);
      } catch {
      }
      if (save) saveGeometry();
    }
    function mount(current) {
      cancelDrag();
      mountAbort?.abort();
      resizeObserver?.disconnect();
      clearTimeout(hideTimer);
      mask?.remove();
      dock?.remove();
      mask = dock = null;
      if (container?.dataset.bcmPositionOwner === VERSION) {
        container.style.position = container.dataset.bcmPreviousPosition || "";
        delete container.dataset.bcmPositionOwner;
        delete container.dataset.bcmPreviousPosition;
      }
      container = current?.container;
      if (!container) return;
      mountAbort = new AbortController();
      const signal = mountAbort.signal;
      if (getComputedStyle(container).position === "static") {
        container.dataset.bcmPreviousPosition = container.style.position;
        container.dataset.bcmPositionOwner = VERSION;
        container.style.position = "relative";
      }
      mask = el("div", "bcm-mask bcm-theme");
      mask.setAttribute("aria-label", "中文字幕遮罩");
      const tools = el("div", "bcm-mask-tools");
      tools.append(el("span", "", "调整字幕区域"), button2("完成", toggleEdit));
      mask.append(tools);
      for (const pos of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) {
        const h = el("span", "bcm-handle");
        h.dataset.handle = pos;
        mask.append(h);
      }
      mask.addEventListener("dblclick", (event) => {
        event.stopPropagation();
        toggleEdit();
      }, { signal });
      mask.addEventListener("click", (event) => {
        event.stopPropagation();
        if (!edit && !event.target.closest("button")) {
          const media = player.getCurrent()?.media;
          if (media?.paused) media.play?.().catch(fail2);
          else media?.pause?.();
        }
      }, { signal });
      mask.addEventListener("pointerdown", (event) => {
        if (!edit || event.button !== 0 || event.target.closest("button")) return;
        event.preventDefault();
        event.stopPropagation();
        const rect = player.getVideoRect();
        if (!rect?.width || !rect?.height) return;
        drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, initial: { ...config }, handle: event.target.dataset.handle || "" };
        mask.setPointerCapture(event.pointerId);
      }, { signal });
      mask.addEventListener("pointermove", (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = (event.clientX - drag.x) / drag.rect.width * 100, dy = (event.clientY - drag.y) / drag.rect.height * 100;
        let { left, top, width, height } = drag.initial;
        if (!drag.handle) {
          left = clamp(left + dx, 0, 100 - width);
          top = clamp(top + dy, 0, 100 - height);
        } else {
          if (drag.handle.includes("w")) {
            const next = clamp(left + dx, 0, left + width - 5);
            width += left - next;
            left = next;
          }
          if (drag.handle.includes("e")) width = clamp(width + dx, 5, 100 - left);
          if (drag.handle.includes("n")) {
            const next = clamp(top + dy, 0, top + height - 2);
            height += top - next;
            top = next;
          }
          if (drag.handle.includes("s")) height = clamp(height + dy, 2, 100 - top);
        }
        Object.assign(config, { left, top, width, height });
        geometryDirty = true;
        schedulePaint();
      }, { signal });
      for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) mask.addEventListener(type, () => cancelDrag(), { signal });
      dock = el("div", "bcm-dock bcm-theme");
      dock.setAttribute("role", "toolbar");
      dock.setAttribute("aria-label", `看剧学英语 v${VERSION}`);
      for (const [name, title, action] of [
        ["version", `v${VERSION}`, showSettings],
        ["toggle", "遮罩 开", toggleMask],
        ["edit", "调节", toggleEdit],
        ["capture", "记录", capture],
        ["notebook", "记录库", () => notebook.toggle().catch(fail2)],
        ["help", "帮助", showHelp]
      ]) {
        const b = button2(title, () => {
          try {
            action();
          } catch (error) {
            fail2(error);
          }
        }, name === "version" ? "bcm-version-button" : "");
        b.dataset.action = name;
        dock.append(b);
      }
      container.append(mask, dock);
      container.addEventListener("pointermove", wakeDock, { signal, passive: true });
      container.addEventListener("pointerenter", wakeDock, { signal, passive: true });
      dock.addEventListener("focusin", wakeDock, { signal });
      if (window.ResizeObserver) {
        resizeObserver = new ResizeObserver(schedulePaint);
        resizeObserver.observe(container);
        if (current.media) resizeObserver.observe(current.media);
      }
      paint();
      wakeDock();
      updateCount();
    }
    function fullscreen() {
      const full = document.fullscreenElement;
      const parent = full && !["VIDEO", "CANVAS", "BWP-VIDEO"].includes(full.tagName) ? full : document.body;
      if (root.parentElement !== parent) parent.append(root);
      schedulePaint();
    }
    const unsubscribe = player.subscribe((current) => {
      const prev = snapshot;
      if (current?.identity.seriesId !== configSeries) {
        if (drag || saveTimer) {
          cancelDrag();
          saveGeometry();
        }
        configSeries = current?.identity.seriesId;
        if (configSeries) config = settings.get(configSeries);
        edit = peek = wheeling = false;
      }
      snapshot = current;
      if (!current || current.container !== container || current.media !== prev?.media) mount(current);
      else paint();
      if (current?.identity.seriesId !== prev?.identity.seriesId) {
        dock?.querySelector('[data-action="notebook"]').replaceChildren("记录库");
        updateCount();
      }
      if (current?.identity.seriesId !== prev?.identity.seriesId || current?.identity.source.sourceId !== prev?.identity.source.sourceId) notebook.refreshSource();
      if (current && !initialized) {
        initialized = true;
        repo.ready().then(updateCount).catch(fail2);
        player.resumePendingSeek().then((result) => {
          if (result.resumed) {
            notify("已定位记录片段");
            player.getCurrent()?.media.play?.().catch(() => notify("已定位记录片段，点击播放继续"));
          }
        }).catch(fail2);
      }
      fullscreen();
    });
    const events = new AbortController();
    window.addEventListener("wheel", (event) => {
      if (!snapshot || !panel.hidden || !event.altKey || event.ctrlKey || event.metaKey || !config.enabled || edit || isEditableEvent(event) || !container.contains(event.target) || !event.deltaY) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      config.top = clamp(config.top + (event.deltaY > 0 ? 0.5 : -0.5), 0, 100 - config.height);
      geometryDirty = true;
      wheeling = true;
      paint();
      wakeDock();
      clearTimeout(wheelTimer);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveGeometry, 180);
      wheelTimer = setTimeout(() => {
        wheeling = false;
        paint();
      }, 600);
    }, { capture: true, passive: false, signal: events.signal });
    window.addEventListener("keydown", (event) => {
      if (event.target?.dataset?.shortcutAction) return;
      if (event.key === "Escape") {
        if (!panel.hidden) {
          event.stopPropagation();
          closePanel();
        } else if (notebook.isOpen()) {
          event.stopPropagation();
          notebook.close().catch(fail2);
        } else if (edit) {
          edit = false;
          cancelDrag();
          paint();
        }
        return;
      }
      if (!snapshot || !panel.hidden || isEditableEvent(event) || event.isComposing) return;
      const spec = eventToShortcut(event, { allowModifierOnly: true });
      if (!spec || yieldsToFocusedControl(event, spec)) return;
      const shortcuts = config.shortcuts || DEFAULT_SHORTCUTS;
      if (spec === shortcuts.peek) {
        if (!peek) {
          peek = true;
          paint();
        }
        if (!["Alt", "Shift", "Ctrl"].includes(shortcuts.peek)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
        return;
      }
      if (event.repeat) return;
      let action;
      if (spec === shortcuts.capture) action = capture;
      else if (spec === shortcuts.notebook) action = () => notebook.toggle().catch(fail2);
      else if (spec === shortcuts.toggleMask) action = toggleMask;
      else if (spec === shortcuts.editMask) action = toggleEdit;
      if (action) {
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
          action();
        } catch (error) {
          fail2(error);
        }
        if (action !== capture) wakeDock();
      }
    }, { capture: true, signal: events.signal });
    window.addEventListener("keyup", (event) => {
      if (peek && matchesPeekRelease(event, config?.shortcuts?.peek ?? DEFAULT_SHORTCUTS.peek)) {
        peek = false;
        paint();
      }
    }, { signal: events.signal });
    window.addEventListener("blur", () => {
      peek = false;
      cancelDrag();
      paint();
    }, { signal: events.signal });
    document.addEventListener("fullscreenchange", fullscreen, { signal: events.signal });
    window.addEventListener("resize", schedulePaint, { passive: true, signal: events.signal });
    window.addEventListener("scroll", () => {
      if (!notification.hidden) schedulePaint();
    }, { capture: true, passive: true, signal: events.signal });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && snapshot) {
        config = settings.get(configSeries);
        peek = false;
        paint();
        updateCount();
        if (notebook.isOpen()) void notebook.refresh();
      }
    }, { signal: events.signal });
    window.addEventListener("pagehide", () => {
      saveGeometry();
    }, { signal: events.signal });
    window.addEventListener("unload", () => {
      unsubscribe();
      player.dispose();
      notebook.dispose();
      settings.dispose();
      repo.close();
      events.abort();
      mountAbort?.abort();
      resizeObserver?.disconnect();
      for (const timer of [hideTimer, wheelTimer, saveTimer, toastTimer]) clearTimeout(timer);
      if (frame != null) cancelAnimationFrame(frame);
    }, { once: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
