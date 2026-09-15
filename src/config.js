const LEGACY_KEY = 'bili_caption_mask_v200_cfg';
const GLOBAL_KEY = 'bili_caption_mask_v240_global';
const SERIES_PREFIX = 'bili_caption_mask_v240_series:';
const DEFAULTS = Object.freeze({
    enabled: true, left: 15, top: 84, width: 70, height: 7.2,
    blur: 14, mode: 'blur', singleKeys: true, leadIn: 3,
    loopBefore: 3, loopAfter: 3, loopCount: 3, loopGap: 0, playbackRate: 1
});
const GEOMETRY = new Set(['left', 'top', 'width', 'height']);
const BOOLEANS = new Set(['enabled', 'singleKeys']);
const LIMITS = {
    left: [0, 100], top: [0, 100], width: [5, 100], height: [2, 100],
    blur: [0, 40], leadIn: [0, 30], loopBefore: [0, 60], loopAfter: [0, 60],
    loopCount: [1, 20], loopGap: [0, 30], playbackRate: [0.25, 3]
};
const UNSAFE = new Set(['__proto__', 'prototype', 'constructor']);

function isPlain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isSafe(value, seen = new Set()) {
    if (value === null || typeof value !== 'object') return true;
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
        const object = typeof value === 'string' ? JSON.parse(value) : value;
        return isPlain(object) && isSafe(object) ? object : null;
    } catch { return null; }
}

function normalize(input) {
    const output = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
        const value = input?.[key];
        if (BOOLEANS.has(key)) {
            if (typeof value === 'boolean') output[key] = value;
        } else if (key === 'mode') {
            if (value === 'blur' || value === 'solid') output[key] = value;
        } else if (typeof value === 'number' && Number.isFinite(value)) {
            const [min, max] = LIMITS[key];
            output[key] = Math.max(min, Math.min(max, value));
            if (key === 'loopCount') output[key] = Math.round(output[key]);
        }
    }
    output.left = Math.min(output.left, 100 - output.width);
    output.top = Math.min(output.top, 100 - output.height);
    return output;
}

function onlyGeometry(config) {
    return Object.fromEntries([...GEOMETRY].map(key => [key, config[key]]));
}

function onlyGlobal(config) {
    return Object.fromEntries(Object.keys(DEFAULTS).filter(key => !GEOMETRY.has(key)).map(key => [key, config[key]]));
}

/** Synchronous settings using GM_getValue/GM_setValue, or localStorage. */
export function createConfigStore(options = {}) {
    const gmGet = options.gmGet;
    const gmSet = options.gmSet;
    const useGM = typeof gmGet === 'function' || typeof gmSet === 'function';
    let disposed = false;

    function checkOpen() { if (disposed) throw new Error('设置存储已关闭'); }

    function seriesKey(seriesId) {
        if (seriesId === undefined || seriesId === null) seriesId = 'global_default';
        if (typeof seriesId !== 'string' || !seriesId.trim() || seriesId.length > 300) throw new Error('剧集标识无效');
        try { return SERIES_PREFIX + encodeURIComponent(seriesId); } catch { throw new Error('剧集标识无效'); }
    }

    function local() {
        return Object.hasOwn(options, 'localStorage') ? options.localStorage : globalThis.localStorage;
    }

    function localRead(key) {
        try { return parse(local()?.getItem(key)); } catch { return null; }
    }

    function read(key) {
        if (!useGM) return localRead(key);
        try {
            if (typeof gmGet !== 'function') return null;
            const value = gmGet(key, null);
            if (value && typeof value.then === 'function') {
                Promise.resolve(value).catch(() => {});
                return null;
            }
            return parse(value);
        } catch { return null; }
    }

    function legacy() {
        // Local history is a fallback, never a second destination for new writes.
        return read(LEGACY_KEY) || (useGM ? localRead(LEGACY_KEY) : null) || {};
    }

    function get(seriesId) {
        checkOpen();
        const key = seriesKey(seriesId);
        const id = seriesId ?? 'global_default';
        const old = legacy();
        const legacyGlobal = isPlain(old.global) ? old.global : {};
        const legacySeries = isPlain(old.series) && Object.hasOwn(old.series, id) && isPlain(old.series[id]) ? old.series[id] : {};
        const global = onlyGlobal(normalize({ ...legacyGlobal, ...read(GLOBAL_KEY) }));
        const geometry = onlyGeometry(normalize({ ...legacyGlobal, ...legacySeries, ...read(key) }));
        return { ...DEFAULTS, ...global, ...geometry };
    }

    function write(key, value) {
        try {
            const serialized = JSON.stringify(value);
            if (useGM) {
                if (typeof gmSet !== 'function') throw new Error('GM 设置写入接口不可用');
                const result = gmSet(key, serialized);
                if (result && typeof result.then === 'function') {
                    Promise.resolve(result).catch(() => {});
                    throw new Error('请使用同步 GM_setValue 接口保存设置');
                }
            } else {
                const storage = local();
                if (!storage || typeof storage.setItem !== 'function') throw new Error('当前浏览器无法保存设置');
                storage.setItem(key, serialized);
            }
        } catch (error) {
            if (error?.name === 'QuotaExceededError') throw new Error('设置保存失败：浏览器存储空间不足');
            throw new Error(`设置保存失败${error?.message ? `：${error.message}` : ''}`);
        }
    }

    function patch(seriesId, changes) {
        checkOpen();
        if (!isPlain(changes) || !isSafe(changes)) throw new Error('设置修改内容无效或包含不安全字段');
        const accepted = {};
        for (const [key, value] of Object.entries(changes)) {
            if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`不支持的设置项：${key}`);
            if (value === undefined) continue;
            if (BOOLEANS.has(key)) {
                if (typeof value !== 'boolean') throw new Error(`设置 ${key} 必须是开关值`);
            } else if (key === 'mode') {
                if (value !== 'blur' && value !== 'solid') throw new Error('遮罩模式必须是 blur 或 solid');
            } else if (typeof value !== 'number' || !Number.isFinite(value)) {
                throw new Error(`设置 ${key} 必须是有效数字`);
            }
            accepted[key] = value;
        }
        const current = get(seriesId);
        const result = normalize({ ...current, ...accepted });
        const keys = Object.keys(accepted);
        if (keys.some(key => GEOMETRY.has(key))) write(seriesKey(seriesId), onlyGeometry(result));
        if (keys.some(key => !GEOMETRY.has(key))) write(GLOBAL_KEY, onlyGlobal(result));
        return result;
    }

    function reset(seriesId) {
        return patch(seriesId, onlyGeometry(DEFAULTS));
    }

    function dispose() { disposed = true; }
    return { get, patch, reset, dispose };
}
