const DB_NAME = 'BiliCaptionStudyDB';
const DB_VERSION = 2;
const LEGACY_KEY = 'bili_caption_notes_v200';
const MIGRATION_KEY = 'legacy-v200-imported';
const FORMAT = 'caption-study-backup';
const MAX_NOTES = 5000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_BACKUP_BYTES = 100 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const REVIEW_STATES = new Set(['new', 'learning', 'mastered']);
const BAD_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function fail(message) { throw new Error(message); }

function checkObject(value, label = '数据', seen = new Set()) {
    if (value === null || typeof value !== 'object' || value instanceof Blob) return;
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

function text(value, fallback = '', max = 20000, label = '文本') {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'string' || value.length > max) fail(`${label}必须是长度不超过 ${max} 的文本`);
    return value;
}

function number(value, fallback, label, max = Number.MAX_SAFE_INTEGER) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) fail(`${label}不是有效的非负数字`);
    return value;
}

function normalizeSource(value) {
    if (value === undefined || value === null) value = {};
    if (typeof value !== 'object' || Array.isArray(value)) fail('视频来源格式无效');
    let url = text(value.url, '', 4096, '视频地址');
    if (url) {
        let parsed;
        try { parsed = new URL(url); } catch { fail('视频地址无效'); }
        const host = parsed.hostname.toLowerCase();
        if (!['http:', 'https:'].includes(parsed.protocol) ||
            !(host === 'bilibili.com' || host.endsWith('.bilibili.com')) ||
            parsed.username || parsed.password || parsed.port) fail('视频地址必须是 B 站的 HTTP/HTTPS 地址');
        parsed.protocol = 'https:';
        url = parsed.href;
    }
    const page = number(value.page, 1, '视频分 P', 100000);
    if (!Number.isInteger(page) || page < 1) fail('视频分 P 必须是正整数');
    return {
        url,
        videoId: text(value.videoId, '', 200, '视频 ID') || null,
        episodeId: text(value.episodeId, '', 200, '分集 ID') || null,
        page,
        sourceId: text(value.sourceId, '', 500, '来源 ID')
    };
}

function imageSize(url) {
    if (typeof url !== 'string') fail('截图必须是图片 data URL');
    if (url.length > MAX_IMAGE_BYTES * 4 / 3 + 100) fail('单张截图不能超过 10 MiB');
    const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
    if (!match || !match[2] || match[2].length % 4 !== 0) fail('截图只支持 JPEG、PNG 或 WebP 的 base64 data URL');
    const bytes = match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) fail('单张截图不能超过 10 MiB');
    return bytes;
}

function splitNote(input, { legacy = false, seriesId } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('卡片格式无效');
    checkObject(input, '卡片');
    const id = text(input.id, '', 200, '卡片 ID');
    const sid = text(input.seriesId, seriesId || '', 300, '剧集 ID');
    if (!id.trim() || !sid.trim()) fail('卡片必须包含 ID 和剧集 ID');
    const createdAt = number(input.createdAt, legacy ? 0 : Date.now(), '创建时间');
    const time = number(input.time, 0, '视频时间', 31 * 24 * 3600);
    const reviewState = input.reviewState ?? 'new';
    if (!REVIEW_STATES.has(reviewState)) fail('复习状态必须是 new、learning 或 mastered');
    const tags = input.tags ?? [];
    if (!Array.isArray(tags) || tags.length > 30) fail('标签必须是数组，且不能超过 30 个');
    const cleanedTags = [...new Set(tags.map(tag => {
        if (typeof tag !== 'string') fail('每个标签都必须是文本');
        return text(tag, '', 100, '标签').trim();
    }).filter(Boolean))];
    let media = null;
    if (input.imageBlob !== undefined && input.imageBlob !== null) {
        if (!(input.imageBlob instanceof Blob) || !IMAGE_TYPES.has(input.imageBlob.type) || input.imageBlob.size === 0) fail('截图 Blob 必须是 JPEG、PNG 或 WebP 图片');
        if (input.imageBlob.size > MAX_IMAGE_BYTES) fail('单张截图不能超过 10 MiB');
        media = { id, imageBlob: input.imageBlob };
    } else if (input.imageUrl !== undefined && input.imageUrl !== null && input.imageUrl !== '') {
        imageSize(input.imageUrl);
        media = { id, imageUrl: input.imageUrl };
    }
    const note = {
        id,
        seriesId: sid,
        seriesTitle: text(input.seriesTitle, '未知剧集', 1000, '剧集标题'),
        epTitle: text(input.epTitle, '', 1000, '分集标题'),
        source: normalizeSource(input.source),
        time,
        timeStr: text(input.timeStr, `${String(Math.floor(time / 60)).padStart(2, '0')}:${String(Math.floor(time % 60)).padStart(2, '0')}`, 100, '时间显示'),
        userNote: text(input.userNote, '', 100000, '笔记'),
        tags: cleanedTags,
        reviewState,
        createdAt,
        updatedAt: number(input.updatedAt, createdAt, '修改时间'),
        hasImage: Boolean(media)
    };
    return { note, media };
}

function storageError(error, fallback) {
    if (error?.name === 'QuotaExceededError') return new Error('浏览器存储空间不足，请导出备份并清理空间后重试');
    if (error?.name === 'AbortError') return new Error(`${fallback}：数据库事务已中止，请重试`);
    return new Error(`${fallback}${error?.message ? `：${error.message}` : ''}`);
}

async function blobToDataURL(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return `data:${blob.type};base64,${btoa(binary)}`;
}

function validateBackup(data) {
    if (!data || data.format !== FORMAT || data.schemaVersion !== 1 || !Array.isArray(data.notes)) fail('备份格式或版本不受支持');
    if (data.notes.length > MAX_NOTES) fail('单次导入不能超过 5000 张卡片');
    checkObject(data, '备份');
    let totalBytes = 0;
    const ids = new Set();
    return data.notes.map(input => {
        const required = ['id', 'seriesId', 'seriesTitle', 'epTitle', 'source', 'time', 'timeStr', 'userNote', 'tags', 'reviewState', 'createdAt', 'updatedAt'];
        if (!input || required.some(key => !Object.hasOwn(input, key))) fail('备份卡片缺少必要字段，请使用完整的 JSON 备份');
        for (const key of ['id', 'seriesId', 'seriesTitle', 'epTitle', 'timeStr', 'userNote', 'reviewState']) {
            if (typeof input[key] !== 'string') fail(`备份卡片的 ${key} 字段必须是文本`);
        }
        if (!Array.isArray(input.tags)) fail('备份卡片的标签必须是数组');
        for (const key of ['time', 'createdAt', 'updatedAt']) {
            if (typeof input[key] !== 'number') fail(`备份卡片的 ${key} 字段必须是数字`);
        }
        if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source)) fail('备份卡片的视频来源格式无效');
        if (input?.imageBlob !== undefined) fail('JSON 备份必须使用图片 data URL，不能使用 Blob');
        const entry = splitNote(input);
        if (ids.has(entry.note.id)) fail(`备份包含重复卡片 ID：${entry.note.id}`);
        ids.add(entry.note.id);
        totalBytes += JSON.stringify(entry.note).length * 2;
        if (entry.media) totalBytes += imageSize(entry.media.imageUrl);
        if (totalBytes > MAX_BACKUP_BYTES) fail('单次导入的数据不能超过 100 MiB');
        return entry;
    });
}

/** A local repository. Mutations resolve only after IndexedDB commits. */
export function createRepository(options = {}) {
    let idb;
    try { idb = Object.hasOwn(options, 'indexedDB') ? options.indexedDB : globalThis.indexedDB; } catch { idb = null; }
    let db = null;
    let opening = null;
    let readiness = null;
    let closed = false;

    function open() {
        if (closed) return Promise.reject(new Error('数据库已关闭'));
        if (db) return Promise.resolve(db);
        if (opening) return opening;
        opening = new Promise((resolve, reject) => {
            if (!idb) return reject(new Error('当前浏览器无法使用 IndexedDB，卡片尚未保存'));
            let request;
            let settled = false;
            let upgradeError;
            try { request = idb.open(DB_NAME, DB_VERSION); } catch (error) { reject(storageError(error, '无法打开本地数据库')); return; }
            request.onblocked = () => {
                settled = true;
                reject(new Error('数据库升级被其他 B 站标签页阻止，请关闭旧标签页后重试'));
            };
            request.onupgradeneeded = event => {
                const database = request.result;
                const tx = request.transaction;
                if (settled || closed) { tx.abort(); return; }
                try {
                    const notes = database.objectStoreNames.contains('notes') ? tx.objectStore('notes') : database.createObjectStore('notes', { keyPath: 'id' });
                    if (!notes.indexNames.contains('by_series')) notes.createIndex('by_series', 'seriesId');
                    if (!notes.indexNames.contains('by_created')) notes.createIndex('by_created', 'createdAt');
                    const media = database.objectStoreNames.contains('media') ? tx.objectStore('media') : database.createObjectStore('media', { keyPath: 'id' });
                    if (!database.objectStoreNames.contains('meta')) database.createObjectStore('meta', { keyPath: 'key' });
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
                            } catch (error) { upgradeError = error; tx.abort(); }
                        };
                    }
                } catch (error) { upgradeError = error; tx.abort(); }
            };
            request.onerror = () => { settled = true; reject(storageError(upgradeError || request.error, '无法打开或升级本地数据库，原数据已保留')); };
            request.onsuccess = () => {
                if (settled || closed) { request.result.close(); if (closed) reject(new Error('数据库已关闭')); return; }
                db = request.result;
                const connection = db;
                const forgetConnection = () => {
                    if (db === connection) { db = null; opening = null; readiness = null; }
                };
                connection.onversionchange = () => { connection.close(); forgetConnection(); };
                connection.onclose = forgetConnection;
                resolve(db);
            };
        }).catch(error => { opening = null; throw error; });
        return opening;
    }

    async function transaction(stores, mode, work, label = '数据库操作失败') {
        const database = await open();
        return new Promise((resolve, reject) => {
            let tx;
            let result;
            let cause;
            try { tx = database.transaction(stores, mode); } catch (error) { reject(storageError(error, label)); return; }
            tx.oncomplete = () => resolve(result);
            tx.onerror = event => { cause ||= event.target?.error || tx.error; };
            tx.onabort = () => reject(storageError(cause || tx.error, label));
            const setResult = value => { result = value; };
            const abort = error => { cause = error; tx.abort(); };
            try { work(tx, setResult, abort); } catch (error) { abort(error); }
        });
    }

    async function migrateLegacy() {
        const alreadyDone = await transaction(['meta'], 'readonly', (tx, set) => {
            const request = tx.objectStore('meta').get(MIGRATION_KEY);
            request.onsuccess = () => set(Boolean(request.result));
        });
        if (alreadyDone) return;
        const sources = [];
        try {
            if (typeof options.gmGet === 'function') sources.push(await options.gmGet(LEGACY_KEY, null));
            let local = options.localStorage;
            if (local === undefined) local = globalThis.localStorage;
            if (local) sources.push(local.getItem(LEGACY_KEY));
        } catch (error) { throw storageError(error, '无法读取历史卡片，原数据已保留'); }
        const entries = new Map();
        for (const raw of sources) {
            if (!raw) continue;
            let map;
            try { map = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { fail('历史卡片格式损坏，原数据已保留'); }
            checkObject(map, '历史卡片');
            if (!map || typeof map !== 'object' || Array.isArray(map)) fail('历史卡片格式损坏，原数据已保留');
            for (const [seriesId, notes] of Object.entries(map)) {
                if (!Array.isArray(notes)) fail('历史剧集卡片必须是数组，原数据已保留');
                for (const input of notes) {
                    const entry = splitNote(input, { legacy: true, seriesId });
                    const prior = entries.get(entry.note.id);
                    if (!prior || prior.note.updatedAt < entry.note.updatedAt) entries.set(entry.note.id, entry);
                }
            }
        }
        await transaction(['notes', 'media', 'meta'], 'readwrite', (tx) => {
            const notes = tx.objectStore('notes');
            const media = tx.objectStore('media');
            const meta = tx.objectStore('meta');
            const marker = meta.get(MIGRATION_KEY);
            marker.onsuccess = () => {
                if (marker.result) return;
                for (const entry of entries.values()) {
                    const existing = notes.getKey(entry.note.id);
                    existing.onsuccess = () => {
                        if (existing.result !== undefined) return;
                        notes.add(entry.note);
                        if (entry.media) media.add(entry.media);
                    };
                }
                meta.put({ key: MIGRATION_KEY, completedAt: Date.now() });
            };
        }, '历史卡片迁移失败，原数据已保留');
        // Keep legacy copies as an extra backup. The committed marker prevents re-import.
    }

    function ready() {
        if (closed) return Promise.reject(new Error('数据库已关闭'));
        if (!readiness) readiness = open().then(migrateLegacy).catch(error => { readiness = null; throw error; });
        return readiness;
    }

    async function list({ seriesId = null, query = '', status = 'all', offset = 0, limit = 30 } = {}) {
        await ready();
        if (seriesId !== null) text(seriesId, '', 300, '剧集 ID');
        if (status !== 'all' && !REVIEW_STATES.has(status)) fail('复习筛选状态无效');
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail('分页参数无效，单页最多 500 张卡片');
        const needle = text(query, '', 1000, '搜索词').trim().toLocaleLowerCase();
        return transaction(['notes'], 'readonly', (tx, set) => {
            const page = [];
            let total = 0;
            const request = tx.objectStore('notes').index('by_created').openCursor(null, 'prev');
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) { set({ notes: page, total }); return; }
                const note = cursor.value;
                if ((seriesId === null || note.seriesId === seriesId) &&
                    (status === 'all' || note.reviewState === status) &&
                    (!needle || [note.seriesTitle, note.epTitle, note.userNote, ...(note.tags || [])].join('\n').toLocaleLowerCase().includes(needle))) {
                    if (total >= offset && page.length < limit) page.push(note);
                    total++;
                }
                cursor.continue();
            };
        });
    }

    async function get(id) {
        await ready();
        return transaction(['notes', 'media'], 'readonly', (tx, set) => {
            const request = tx.objectStore('notes').get(id);
            request.onsuccess = () => {
                if (!request.result) { set(null); return; }
                const image = tx.objectStore('media').get(id);
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
        return transaction(['notes', 'media'], 'readwrite', (tx, set) => {
            tx.objectStore('notes').put(entry.note);
            if (entry.media) tx.objectStore('media').put(entry.media);
            else tx.objectStore('media').delete(entry.note.id);
            const { id: ignored, ...fields } = entry.media || {};
            set({ ...entry.note, ...fields });
        }, '保存卡片失败');
    }

    async function update(id, patch) {
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('卡片修改内容无效');
        checkObject(patch, '卡片修改');
        if (patch.id !== undefined && patch.id !== id) fail('不能修改卡片 ID');
        patch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
        await ready();
        return transaction(['notes', 'media'], 'readwrite', (tx, set, abort) => {
            const notes = tx.objectStore('notes');
            const media = tx.objectStore('media');
            const request = notes.get(id);
            request.onsuccess = () => {
                if (!request.result) { abort(new Error('卡片不存在，可能已被删除')); return; }
                const image = media.get(id);
                image.onsuccess = () => {
                    try {
                        const { id: ignored, ...oldImage } = image.result || {};
                        const replacingImage = Object.hasOwn(patch, 'imageBlob') || Object.hasOwn(patch, 'imageUrl');
                        const entry = splitNote({ ...request.result, ...(replacingImage ? {} : oldImage), ...patch, id, updatedAt: Date.now() });
                        notes.put(entry.note);
                        if (entry.media) media.put(entry.media);
                        else media.delete(id);
                        const { id: ignoredAgain, ...newImage } = entry.media || {};
                        set({ ...entry.note, ...newImage });
                    } catch (error) { abort(error); }
                };
            };
        }, '修改卡片失败');
    }

    async function remove(id) {
        await ready();
        return transaction(['notes', 'media'], 'readwrite', (tx, set) => {
            const notes = tx.objectStore('notes');
            const media = tx.objectStore('media');
            const request = notes.get(id);
            request.onsuccess = () => {
                if (!request.result) { set(null); return; }
                const image = media.get(id);
                image.onsuccess = () => {
                    const { id: ignored, ...fields } = image.result || {};
                    notes.delete(id);
                    media.delete(id);
                    set({ ...request.result, ...fields });
                };
            };
        }, '删除卡片失败');
    }

    async function restore(input) {
        const entry = splitNote(input);
        await ready();
        return transaction(['notes', 'media'], 'readwrite', (tx, set, abort) => {
            const notes = tx.objectStore('notes');
            const request = notes.getKey(entry.note.id);
            request.onsuccess = () => {
                if (request.result !== undefined) { abort(new Error('同 ID 卡片已存在，无法覆盖恢复')); return; }
                notes.add(entry.note);
                if (entry.media) tx.objectStore('media').add(entry.media);
                const { id: ignored, ...fields } = entry.media || {};
                set({ ...entry.note, ...fields });
            };
        }, '恢复卡片失败');
    }

    async function count(seriesId = null) {
        await ready();
        return transaction(['notes'], 'readonly', (tx, set) => {
            const notes = tx.objectStore('notes');
            const request = seriesId === null ? notes.count() : notes.index('by_series').count(seriesId);
            request.onsuccess = () => set(request.result);
        });
    }

    async function exportBackup() {
        await ready();
        const entries = await transaction(['notes', 'media'], 'readonly', (tx, set) => {
            const result = [];
            const request = tx.objectStore('notes').openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) { set(result); return; }
                const image = tx.objectStore('media').get(cursor.key);
                image.onsuccess = () => {
                    const { id: ignored, ...fields } = image.result || {};
                    result.push({ ...cursor.value, ...fields });
                    cursor.continue();
                };
            };
        });
        const notes = [];
        for (const entry of entries) {
            const { imageBlob, hasImage, ...note } = entry;
            if (imageBlob) note.imageUrl = await blobToDataURL(imageBlob);
            notes.push(note);
        }
        return { format: FORMAT, schemaVersion: 1, exportedAt: new Date().toISOString(), notes };
    }

    async function previewImport(data) {
        const entries = validateBackup(data);
        await ready();
        return transaction(['notes'], 'readonly', (tx, set) => {
            const result = { total: entries.length, existing: 0, newCount: entries.length };
            set(result);
            for (const entry of entries) {
                const request = tx.objectStore('notes').getKey(entry.note.id);
                request.onsuccess = () => { if (request.result !== undefined) { result.existing++; result.newCount--; } };
            }
        });
    }

    async function importBackup(data) {
        const entries = validateBackup(data);
        await ready();
        return transaction(['notes', 'media'], 'readwrite', (tx, set) => {
            const result = { imported: 0, skipped: 0 };
            set(result);
            const notes = tx.objectStore('notes');
            for (const entry of entries) {
                const request = notes.getKey(entry.note.id);
                request.onsuccess = () => {
                    if (request.result !== undefined) { result.skipped++; return; }
                    notes.add(entry.note);
                    if (entry.media) tx.objectStore('media').add(entry.media);
                    result.imported++;
                };
            }
        }, '导入备份失败，未完成的修改已撤销');
    }

    function close() { closed = true; db?.close(); db = null; }
    return { ready, list, get, save, update, remove, restore, count, exportBackup, previewImport, importBackup, close };
}
