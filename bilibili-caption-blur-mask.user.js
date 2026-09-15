// ==UserScript==
// @name         Bilibili 剧集双语字幕羽化遮罩与生词本 (看剧学英语)
// @namespace    https://github.com/CaptionNoChinese
// @version      2.4.0
// @description  中文字幕遮罩、可靠场景收藏、跨集回听、片段循环、搜索复习与本地备份恢复。
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
  function normalizeSource(value) {
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
      source: normalizeSource(input.source),
      time,
      timeStr: text(input.timeStr, `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(Math.floor(time % 60)).padStart(2, "0")}`, 100, "时间显示"),
      userNote: text(input.userNote, "", 1e5, "笔记"),
      tags: cleanedTags,
      reviewState,
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
    async function list({ seriesId = null, query = "", status = "all", offset = 0, limit = 30 } = {}) {
      await ready();
      if (seriesId !== null) text(seriesId, "", 300, "剧集 ID");
      if (status !== "all" && !REVIEW_STATES.has(status)) fail("复习筛选状态无效");
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) fail("分页参数无效，单页最多 500 张卡片");
      const needle = text(query, "", 1e3, "搜索词").trim().toLocaleLowerCase();
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
          if ((seriesId === null || note.seriesId === seriesId) && (status === "all" || note.reviewState === status) && (!needle || [note.seriesTitle, note.epTitle, note.userNote, ...note.tags || []].join("\n").toLocaleLowerCase().includes(needle))) {
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
    async function update(id, patch) {
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) fail("卡片修改内容无效");
      checkObject(patch, "卡片修改");
      if (patch.id !== void 0 && patch.id !== id) fail("不能修改卡片 ID");
      patch = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== void 0));
      await ready();
      return transaction(["notes", "media"], "readwrite", (tx, set, abort) => {
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
      }, "修改卡片失败");
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
    async function count(seriesId = null) {
      await ready();
      return transaction(["notes"], "readonly", (tx, set) => {
        const notes = tx.objectStore("notes");
        const request = seriesId === null ? notes.count() : notes.index("by_series").count(seriesId);
        request.onsuccess = () => set(request.result);
      });
    }
    async function exportBackup() {
      await ready();
      const entries = await transaction(["notes", "media"], "readonly", (tx, set) => {
        const result = [];
        const request = tx.objectStore("notes").openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            set(result);
            return;
          }
          const image = tx.objectStore("media").get(cursor.key);
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
  function normalizeSource2(value, baseUrl = "https://www.bilibili.com/") {
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
    return String(title ?? "").replace(/-(?:电视剧|番剧|电影|纪录片)-全集.*$/, "").replace(/-高清正版在线观看.*$/, "").replace(/_哔哩哔哩(?:_bilibili)?.*$/, "").trim();
  }
  function unwrapState(state) {
    return state?.props?.pageProps?.initialState ?? state?.props?.pageProps?.__INITIAL_STATE__ ?? state?.props?.pageProps ?? state?.initialState ?? state?.__INITIAL_STATE__ ?? state ?? {};
  }
  function resolveIdentity({ url, title = "", state = null, seasonId = null, episodeId = null, epTitle = "" } = {}) {
    let source = normalizeSource2(url);
    if (!source) return null;
    const data = unwrapState(state);
    const info = data.epInfo ?? data.ep_info ?? {};
    const stateEpisodeId = numericId(info.id ?? info.ep_id ?? info.epid, "ep");
    const stateSeasonId = numericId(data.mediaInfo?.season_id ?? data.seasonInfo?.season_id ?? data.season_id, "ss");
    const explicitSeasonId = numericId(seasonId, "ss");
    let seriesTitle = cleanTitle(title) || "未命名视频";
    let episodeTitle = String(epTitle ?? "").trim();
    let seriesId;
    if (source.videoId) {
      seriesId = `bv_${source.videoId}`;
      const videoData = data.videoData ?? {};
      if (videoData.bvid === source.videoId) {
        seriesTitle = cleanTitle(videoData.title) || seriesTitle;
        const part = Array.isArray(videoData.pages) ? videoData.pages.find((item) => item.page === source.page) : null;
        episodeTitle ||= String(part?.part ?? "").trim();
      }
      episodeTitle ||= `P${source.page}`;
    } else {
      const pathSeasonId = source.sourceId.startsWith("ss:") ? source.sourceId.slice(3) : null;
      if (pathSeasonId) {
        const selectedEpisode = numericId(episodeId, "ep") || (stateSeasonId === pathSeasonId ? stateEpisodeId : null);
        if (selectedEpisode) source = normalizeSource2({ episodeId: selectedEpisode });
      }
      const currentEpisodeId = numericId(source.episodeId, "ep");
      const listedEpisodes = Array.isArray(data.epList) ? data.epList : [];
      const stateMatches = currentEpisodeId ? stateEpisodeId === currentEpisodeId || listedEpisodes.some((item) => numericId(item.id ?? item.ep_id, "ep") === currentEpisodeId) : pathSeasonId === stateSeasonId;
      const season = pathSeasonId || explicitSeasonId || (stateMatches ? stateSeasonId : null);
      seriesId = season ? `season_${season}` : `bgm_${source.episodeId}`;
      if (stateMatches) {
        seriesTitle = cleanTitle(data.mediaInfo?.title ?? data.seasonInfo?.title) || seriesTitle;
        const episode = stateEpisodeId === currentEpisodeId ? info : listedEpisodes.find((item) => numericId(item.id ?? item.ep_id, "ep") === currentEpisodeId);
        episodeTitle ||= String(episode?.long_title ?? episode?.title ?? "").trim();
      }
      episodeTitle ||= source.episodeId ?? `ss${pathSeasonId}`;
    }
    return { seriesId, seriesTitle, epTitle: episodeTitle, source };
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
      if (!normalizeSource2(href)) return null;
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
      const canonicalSource = canonical && normalizeSource2(canonical, href);
      if (canonicalSource?.sourceId.startsWith("ss:")) seasonId = canonicalSource.sourceId.slice(3);
      if (!seasonId) {
        const metadataLinks = queryAll(
          document2,
          '.media-info a[href*="/bangumi/play/ss"], .media-info-wrap a[href*="/bangumi/play/ss"], .bangumi-info a[href*="/bangumi/play/ss"], .bangumi-header a[href*="/bangumi/play/ss"], [class*="mediaInfo"] a[href*="/bangumi/play/ss"]'
        );
        const ids = new Set(metadataLinks.map((link) => normalizeSource2(link.href, href)?.sourceId).filter((id) => id?.startsWith("ss:")));
        if (ids.size === 1) seasonId = [...ids][0].slice(3);
      }
      const selectedEpisode = query(
        document2,
        "a.ep-item.active, a.ep-item.on, .ep-item.active a, .ep-item.on a, .ep-item.cursor a, .ep-list .active a"
      );
      const episodeId = selectedEpisode && normalizeSource2(selectedEpisode.href, href)?.episodeId;
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
      const routeId = normalizeSource2(window2.location.href)?.sourceId;
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
      const routeSource = normalizeSource2(window2.location.href);
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
      } else if (!recovery && recoveryAttempts < 10 && normalizeSource2(window2.location.href)) {
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
      const source = snapshot?.identity.source ?? normalizeSource2(window2.location.href);
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
      return normalizeSource2(note?.source ?? note?.identity?.source ?? note?.url);
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
      const current = getCurrent()?.identity.source ?? normalizeSource2(window2.location.href);
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
      const source = normalizeSource2(parsed.href);
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
          routeId: normalizeSource2(window2.location.href)?.sourceId,
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

  // src/config.js
  var LEGACY_KEY2 = "bili_caption_mask_v200_cfg";
  var GLOBAL_KEY = "bili_caption_mask_v240_global";
  var SERIES_PREFIX = "bili_caption_mask_v240_series:";
  var DEFAULTS = Object.freeze({
    enabled: true,
    left: 15,
    top: 84,
    width: 70,
    height: 7.2,
    blur: 14,
    mode: "blur",
    singleKeys: true,
    leadIn: 3,
    loopBefore: 3,
    loopAfter: 3,
    loopCount: 3,
    loopGap: 0,
    playbackRate: 1
  });
  var GEOMETRY = /* @__PURE__ */ new Set(["left", "top", "width", "height"]);
  var BOOLEANS = /* @__PURE__ */ new Set(["enabled", "singleKeys"]);
  var LIMITS = {
    left: [0, 100],
    top: [0, 100],
    width: [5, 100],
    height: [2, 100],
    blur: [0, 40],
    leadIn: [0, 30],
    loopBefore: [0, 60],
    loopAfter: [0, 60],
    loopCount: [1, 20],
    loopGap: [0, 30],
    playbackRate: [0.25, 3]
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
  function normalize(input) {
    const output = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      const value = input?.[key];
      if (BOOLEANS.has(key)) {
        if (typeof value === "boolean") output[key] = value;
      } else if (key === "mode") {
        if (value === "blur" || value === "solid") output[key] = value;
      } else if (typeof value === "number" && Number.isFinite(value)) {
        const [min, max] = LIMITS[key];
        output[key] = Math.max(min, Math.min(max, value));
        if (key === "loopCount") output[key] = Math.round(output[key]);
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
    return Object.fromEntries(Object.keys(DEFAULTS).filter((key) => !GEOMETRY.has(key)).map((key) => [key, config[key]]));
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
      const global = onlyGlobal(normalize({ ...legacyGlobal, ...read(GLOBAL_KEY) }));
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
        if (BOOLEANS.has(key)) {
          if (typeof value !== "boolean") throw new Error(`设置 ${key} 必须是开关值`);
        } else if (key === "mode") {
          if (value !== "blur" && value !== "solid") throw new Error("遮罩模式必须是 blur 或 solid");
        } else if (typeof value !== "number" || !Number.isFinite(value)) {
          throw new Error(`设置 ${key} 必须是有效数字`);
        }
        accepted[key] = value;
      }
      const current = get(seriesId);
      const result = normalize({ ...current, ...accepted });
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

  // src/notebook.js
  var PAGE_SIZE = 30;
  var SAVE_DELAY = 550;
  var REVIEW_STATES2 = [["new", "待复习"], ["learning", "仍不会"], ["mastered", "已掌握"]];
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
  function timeLabel(seconds) {
    const time = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(time / 60).toString().padStart(2, "0")}:${(time % 60).toString().padStart(2, "0")}`;
  }
  function fileNameDate() {
    return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
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
  function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("无法读取截图"));
      reader.readAsDataURL(blob);
    });
  }
  function createNotebook({ repo, player, notify = () => {
  }, version = "2.4.0", onChange = () => {
  }, onLoop, onHelp, onSettings, getLeadIn = () => 3 }) {
    let opened = false;
    let disposed = false;
    let offset = 0;
    let total = 0;
    let refreshGeneration = 0;
    let renderGeneration = 0;
    let searchTimer;
    let returnFocus = null;
    let showAnswers = true;
    let importData = null;
    let undoNote = null;
    const drafts = /* @__PURE__ */ new Map();
    const controls = /* @__PURE__ */ new Map();
    const imageUrls = /* @__PURE__ */ new Set();
    const element = node("aside", "bcm-notebook");
    element.setAttribute("aria-label", "场景收藏与复习本");
    element.hidden = true;
    element.inert = true;
    const header = node("header", "bcm-notebook-header");
    const heading = node("div", "bcm-heading-row");
    const title = node("h2", "bcm-notebook-title", "场景复习本");
    const versionLabel = node("span", "bcm-version", `v${version}`);
    const closeButton = button("关闭", () => close(), "bcm-button-quiet");
    closeButton.setAttribute("aria-label", "关闭复习本");
    heading.append(title, versionLabel, closeButton);
    const subtitle = node("p", "bcm-subtitle", "回到原场景，再听懂一点。");
    const headerActions = node("div", "bcm-toolbar");
    if (onHelp) headerActions.append(button("操作帮助", () => onHelp()));
    if (onSettings) headerActions.append(button("设置", () => onSettings()));
    const backupButton = button("备份全部", () => backup());
    const importButton = button("导入备份", () => fileInput.click());
    const readingButton = button("导出阅读版", () => exportReading());
    readingButton.title = "将当前筛选的收藏导出为可离线打开的 HTML 文件";
    headerActions.append(backupButton, importButton, readingButton);
    header.append(heading, subtitle, headerActions);
    const scroll = node("div", "bcm-notebook-scroll");
    const filters = node("section", "bcm-filters");
    filters.setAttribute("aria-label", "筛选收藏");
    const searchInput = node("input", "bcm-input");
    searchInput.type = "search";
    searchInput.placeholder = "搜索笔记、标签或标题";
    searchInput.autocomplete = "off";
    searchInput.setAttribute("aria-label", "搜索收藏");
    const scopeSelect = select([["current", "当前剧集"], ["all", "全部收藏"]], "收藏范围");
    const statusSelect = select([["all", "全部状态"], ...REVIEW_STATES2], "复习状态");
    const filterRow = node("div", "bcm-filter-row");
    filterRow.append(field("范围", scopeSelect), field("状态", statusSelect));
    const revealButton = button("隐藏笔记答案", async () => {
      await flushDrafts();
      showAnswers = !showAnswers;
      revealButton.textContent = showAnswers ? "隐藏笔记答案" : "显示笔记答案";
      revealButton.setAttribute("aria-pressed", String(!showAnswers));
      for (const { answer } of controls.values()) answer.hidden = !showAnswers;
    }, "bcm-button-quiet");
    revealButton.setAttribute("aria-pressed", "false");
    const resultSummary = node("p", "bcm-result-summary", "尚未加载收藏");
    resultSummary.setAttribute("role", "status");
    const summaryRow = node("div", "bcm-summary-row");
    summaryRow.append(resultSummary, revealButton);
    filters.append(field("搜索", searchInput), filterRow, summaryRow);
    const notices = node("div", "bcm-notices");
    notices.setAttribute("aria-live", "polite");
    const noticeText = node("span");
    const retryDrafts = button("重试保存", async () => {
      const ok = await flushDrafts();
      if (ok) setNotice("笔记已保存。");
    });
    const retryLoading = button("重新加载", () => refresh());
    retryLoading.hidden = true;
    retryDrafts.hidden = true;
    notices.append(noticeText, retryDrafts, retryLoading);
    notices.hidden = true;
    const undoRegion = node("div", "bcm-undo");
    undoRegion.hidden = true;
    undoRegion.setAttribute("role", "status");
    const undoText = node("span", "", "收藏已删除。");
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
        notify("已恢复收藏");
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
    list.setAttribute("aria-label", "收藏列表");
    const pagination = node("nav", "bcm-pagination");
    pagination.setAttribute("aria-label", "收藏分页");
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
    const footer = node("p", "bcm-storage-note", "收藏保存在本浏览器中。清理站点数据前，请先备份。");
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
      Promise.resolve().then(() => onChange()).catch((error) => console.warn("[场景复习本] 计数刷新失败", error));
    }
    function leadInFor(note) {
      const value = Number(getLeadIn(note));
      return Number.isFinite(value) ? Math.max(0, Math.min(30, value)) : 3;
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
            await repo.update(id, patch);
            if (draft.revision === revision) {
              draft.dirty = false;
              draft.patch = {};
            }
            signalChange();
          }
          return true;
        } catch (error) {
          draft.error = error;
          setNotice(`笔记保存失败：${readableError(error)}。草稿仍保留在本次页面，请重试保存。`, true);
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
    async function loadImage(container, id, generation) {
      if (disposed || generation !== renderGeneration || container.dataset.loaded) return;
      container.dataset.loaded = "true";
      try {
        const note = await repo.get(id);
        if (disposed || generation !== renderGeneration || !container.isConnected) return;
        let src = null;
        if (note?.imageBlob instanceof Blob && /^image\/(jpeg|png|webp|gif|avif)$/i.test(note.imageBlob.type)) {
          src = URL.createObjectURL(note.imageBlob);
          imageUrls.add(src);
        } else if (/^data:image\/(jpeg|png|webp|gif|avif);base64,/i.test(note?.imageUrl || "")) {
          src = note.imageUrl;
        }
        if (!src) throw new Error("图片不可用");
        const image = node("img", "bcm-note-image");
        image.alt = `${note.epTitle || note.seriesTitle || "视频"} ${note.timeStr || timeLabel(note.time)} 的收藏画面`;
        image.decoding = "async";
        image.addEventListener("error", () => {
          container.textContent = "图片无法显示，仍可回听原视频。";
        });
        image.src = src;
        container.replaceChildren(image);
      } catch {
        if (!disposed && generation === renderGeneration) container.textContent = "图片无法加载，仍可回听原视频。";
      }
    }
    async function playNote(note, control, loop = false) {
      control.disabled = true;
      try {
        if (!await flushDrafts()) {
          setNotice("笔记尚未保存成功。请先重试保存，再回听，避免切换视频时丢失草稿。", true);
          return;
        }
        if (loop && onLoop) await onLoop(note);
        else {
          const result = await player.seek(note, { leadIn: leadInFor(note) });
          if (!result?.navigated) {
            const current = player.getCurrent?.();
            if (!current?.sourceReady || note.source?.sourceId && current.identity?.source?.sourceId !== note.source.sourceId) {
              throw new Error("视频正在切换，请画面就绪后重试");
            }
            if (typeof current.media?.play !== "function") throw new Error("播放器暂时无法播放，请手动继续");
            await current.media.play();
          }
        }
      } catch (error) {
        const message = `回听失败：${readableError(error)}`;
        setNotice(message, true);
        notify(message, { kind: "error" });
      } finally {
        control.disabled = false;
      }
    }
    function renderNote(note) {
      const draft = drafts.get(note.id);
      const data = { ...note, ...draft?.values || {} };
      const article = node("article", "bcm-note");
      article.dataset.noteId = note.id;
      const noteHeader = node("div", "bcm-note-header");
      const noteTitle = node("h3", "bcm-note-title", note.epTitle || note.seriesTitle || "未命名视频");
      const removeButton = button("删除", async () => {
        removeButton.disabled = true;
        try {
          if (!await saveDraft(note.id)) return;
          const previous = await repo.remove(note.id);
          drafts.delete(note.id);
          undoNote = previous;
          undoText.textContent = "收藏已删除，可撤销最近一次删除。";
          undoRegion.hidden = !previous;
          signalChange();
          await refresh();
        } catch (error) {
          setNotice(`删除失败：${readableError(error)}。收藏仍保留。`, true);
        } finally {
          removeButton.disabled = false;
        }
      }, "bcm-button-quiet bcm-delete");
      removeButton.setAttribute("aria-label", `删除 ${note.timeStr || timeLabel(note.time)} 的收藏`);
      noteHeader.append(noteTitle, removeButton);
      const meta = node("p", "bcm-note-meta", note.seriesTitle || "未命名剧集");
      const imageContainer = node("div", "bcm-image-placeholder", "正在载入场景…");
      imageContainer.dataset.noteId = note.id;
      imageContainer.dataset.generation = String(renderGeneration);
      const playback = node("div", "bcm-playback-row");
      const playButton = button(`${note.timeStr || timeLabel(note.time)} · 回听`, () => playNote(note, playButton), "bcm-button-primary bcm-play-button");
      playButton.title = `从收藏时间前 ${leadInFor(note)} 秒开始回听`;
      playback.append(playButton);
      if (onLoop) {
        const loopButton = button("片段循环", () => playNote(note, loopButton, true));
        playback.append(loopButton);
      }
      const answer = node("div", "bcm-answer");
      answer.hidden = !showAnswers;
      const noteInput = node("textarea", "bcm-input bcm-note-input");
      noteInput.rows = 3;
      noteInput.maxLength = 2e4;
      noteInput.placeholder = "记下没听懂的词句，或自己的理解";
      noteInput.value = data.userNote || "";
      noteInput.addEventListener("input", () => queueDraft(note.id, { userNote: noteInput.value }));
      noteInput.addEventListener("blur", () => saveDraft(note.id));
      answer.append(field("笔记 / 答案", noteInput));
      const tagsInput = node("input", "bcm-input bcm-tags-input");
      tagsInput.type = "text";
      tagsInput.value = (data.tags || []).join("，");
      tagsInput.placeholder = "例如：连读，日常口语";
      tagsInput.addEventListener("input", () => queueDraft(note.id, { tags: [...new Set(tagsInput.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))] }));
      tagsInput.addEventListener("blur", () => saveDraft(note.id));
      const reviewSelect = select(REVIEW_STATES2, "这条收藏的复习状态");
      reviewSelect.value = data.reviewState || "new";
      reviewSelect.addEventListener("change", async () => {
        queueDraft(note.id, { reviewState: reviewSelect.value });
        await saveDraft(note.id);
      });
      const bottom = node("div", "bcm-note-bottom");
      const saveState = node("span", "bcm-save-state", "已保存");
      saveState.setAttribute("role", "status");
      bottom.append(field("复习状态", reviewSelect), saveState);
      article.append(noteHeader, meta);
      if (note.hasImage || note.imageUrl || note.imageBlob) {
        article.append(imageContainer);
        if (observer) observer.observe(imageContainer);
        else setTimeout(() => loadImage(imageContainer, note.id, Number(imageContainer.dataset.generation)), 0);
      }
      article.append(playback, answer, field("标签（逗号分隔）", tagsInput), bottom);
      controls.set(note.id, { answer, saveState });
      updateSaveState(note.id);
      return article;
    }
    async function refresh() {
      if (disposed) return;
      const generation = ++refreshGeneration;
      await flushDrafts();
      if (disposed || generation !== refreshGeneration || !opened) return;
      const identity = player.getCurrent?.()?.identity;
      const seriesId = scopeSelect.value === "current" ? identity?.seriesId : null;
      list.setAttribute("aria-busy", "true");
      previousButton.disabled = true;
      nextButton.disabled = true;
      resultSummary.textContent = "正在加载收藏…";
      try {
        if (typeof repo.ready === "function") await repo.ready();
        else await repo.ready;
        const result = scopeSelect.value === "current" && !seriesId ? { notes: [], total: 0 } : await repo.list({ seriesId, query: searchInput.value.trim(), status: statusSelect.value, offset, limit: PAGE_SIZE });
        if (disposed || generation !== refreshGeneration || !opened) return;
        total = result.total;
        if (offset > 0 && offset >= total) {
          offset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
          return refresh();
        }
        renderGeneration += 1;
        clearImages();
        controls.clear();
        const fragment = document.createDocumentFragment();
        for (const note of result.notes) fragment.append(renderNote(note));
        if (!result.notes.length) {
          const empty = node("div", "bcm-empty");
          const filtered = Boolean(searchInput.value.trim()) || statusSelect.value !== "all";
          const noPlayer = scopeSelect.value === "current" && !seriesId;
          empty.append(node("h3", "", noPlayer ? "当前没有可用的视频" : filtered ? "没有符合条件的收藏" : "把想再听的瞬间留下来"));
          empty.append(node("p", "", noPlayer ? "切换到“全部收藏”查看历史记录，或打开 B 站视频。" : filtered ? "试试其他关键词，或将复习状态设为“全部状态”。" : "播放时按 Alt + S 收藏画面；之后可从这里回听、做笔记。"));
          fragment.append(empty);
        }
        list.replaceChildren(fragment);
        resultSummary.textContent = `共 ${new Intl.NumberFormat("zh-CN").format(total)} 条收藏`;
        pageLabel.textContent = `${Math.floor(offset / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))}`;
        previousButton.disabled = offset === 0;
        nextButton.disabled = offset + PAGE_SIZE >= total;
        pagination.hidden = total <= PAGE_SIZE;
      } catch (error) {
        if (generation === refreshGeneration) {
          resultSummary.textContent = "收藏加载失败";
          setNotice(`无法读取收藏：${readableError(error)}。请重新加载。`, true);
          retryLoading.hidden = false;
        }
      } finally {
        if (generation === refreshGeneration) list.removeAttribute("aria-busy");
      }
    }
    async function backup() {
      backupButton.disabled = true;
      backupButton.textContent = "正在备份…";
      try {
        if (!await flushDrafts()) throw new Error("仍有未保存笔记，请先重试保存");
        const data = await repo.exportBackup();
        downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), `B站场景收藏_完整备份_${fileNameDate()}.json`);
        setNotice("完整备份已生成，包含所有剧集的收藏和图片。请保留下载的 JSON 文件。");
      } catch (error) {
        setNotice(`备份失败：${readableError(error)}`, true);
      } finally {
        backupButton.disabled = false;
        backupButton.textContent = "备份全部";
      }
    }
    async function exportReading() {
      readingButton.disabled = true;
      readingButton.textContent = "正在导出…";
      try {
        if (!await flushDrafts()) throw new Error("仍有未保存笔记，请先重试保存");
        const seriesId = scopeSelect.value === "current" ? player.getCurrent?.()?.identity?.seriesId : null;
        if (scopeSelect.value === "current" && !seriesId) throw new Error("当前没有可用的视频，请选择全部收藏");
        const query = searchInput.value.trim();
        const status = statusSelect.value;
        const output = document.implementation.createHTMLDocument("场景复习笔记");
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
        style.textContent = "body{font:16px/1.7 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#172536;background:#fff;overflow-wrap:anywhere}article{padding:24px 0;border-top:1px solid #bac7d4}h1{font-size:28px}h2{font-size:20px}img{max-width:100%;height:auto}p{white-space:pre-wrap}a{color:#005a84}small{color:#455568}";
        output.head.prepend(charset, viewport, policy);
        output.head.append(style);
        output.body.append(node("h1", "", "场景复习笔记"), node("p", "", `导出日期：${(/* @__PURE__ */ new Date()).toLocaleDateString("zh-CN")}。此文件用于离线阅读；恢复收藏请使用 JSON 完整备份。`));
        let exported = 0;
        let exportOffset = 0;
        let missingImages = 0;
        while (!disposed) {
          const batch = await repo.list({ seriesId, query, status, offset: exportOffset, limit: 100 });
          if (!batch.notes.length) break;
          for (const metadata of batch.notes) {
            const note = await repo.get(metadata.id);
            if (!note) continue;
            const article = node("article");
            article.append(node("h2", "", `${note.timeStr || timeLabel(note.time)} · ${note.epTitle || note.seriesTitle || "未命名视频"}`));
            article.append(node("small", "", `${note.seriesTitle || ""} · ${(note.tags || []).join(" / ")} · ${REVIEW_STATES2.find(([value]) => value === note.reviewState)?.[1] || "待复习"}`));
            if (note.source?.url) {
              const source = new URL(note.source.url);
              if (["https:", "http:"].includes(source.protocol)) {
                source.searchParams.set("t", String(Math.floor(note.time || 0)));
                const link = node("a", "", "打开原视频");
                link.href = source.href;
                const paragraph = node("p");
                paragraph.append(link);
                article.append(paragraph);
              }
            }
            let imageUrl = /^data:image\/(jpeg|png|webp);base64,/i.test(note.imageUrl || "") ? note.imageUrl : null;
            if (note.imageBlob) {
              try {
                imageUrl = await blobDataUrl(note.imageBlob);
              } catch {
                missingImages += 1;
              }
            }
            if (imageUrl) {
              const image = node("img");
              image.src = imageUrl;
              image.alt = `${note.timeStr || timeLabel(note.time)} 的收藏画面`;
              article.append(image);
            }
            article.append(node("p", "", note.userNote || "尚未填写笔记。"));
            output.body.append(article);
            exported += 1;
          }
          exportOffset += batch.notes.length;
          if (exportOffset >= batch.total) break;
        }
        if (disposed) return;
        if (!exported) throw new Error("当前筛选没有收藏，请更换条件后导出");
        downloadBlob(new Blob(["<!doctype html>\n", output.documentElement.outerHTML], { type: "text/html;charset=utf-8" }), `B站场景复习_阅读版_${fileNameDate()}.html`);
        setNotice(`已导出 ${exported} 条收藏，使用浏览器打开 HTML 文件即可离线阅读。${missingImages ? `${missingImages} 张图片读取失败，笔记与来源已保留。` : ""}`);
      } catch (error) {
        setNotice(`阅读版导出失败：${readableError(error)}`, true);
      } finally {
        readingButton.disabled = false;
        readingButton.textContent = "导出阅读版";
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
        importText.textContent = `${file.name}：共 ${preview.total} 条，新增 ${preview.newCount} 条，已有 ${preview.existing} 条。已有收藏会保留，不覆盖。`;
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
        if (!await flushDrafts()) throw new Error("仍有未保存笔记，请先重试保存");
        const result = await repo.importBackup(importData);
        importData = null;
        importRegion.hidden = true;
        setNotice(`导入完成：新增 ${result.imported} 条，保留已有 ${result.skipped} 条。`);
        signalChange();
        offset = 0;
        await refresh();
      } catch (error) {
        setNotice(`导入失败：${readableError(error)}。可以重试，已有收藏不会被覆盖。`, true);
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
    for (const filter of [scopeSelect, statusSelect]) filter.addEventListener("change", () => {
      offset = 0;
      refresh();
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
      if (!opened) returnFocus = document.activeElement;
      opened = true;
      element.hidden = false;
      element.inert = false;
      searchInput.focus({ preventScroll: true });
      await refresh();
    }
    async function close() {
      if (!opened) return;
      const saved = await flushDrafts();
      if (!saved) notify("笔记尚未保存成功，草稿仅保留在当前页面。请重新打开复习本重试。");
      opened = false;
      refreshGeneration += 1;
      renderGeneration += 1;
      clearImages();
      element.hidden = true;
      element.inert = true;
      if (returnFocus?.isConnected && typeof returnFocus.focus === "function") returnFocus.focus({ preventScroll: true });
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
    return { element, open, close, toggle: () => opened ? close() : open(), refresh, dispose, isOpen: () => opened, flushDrafts };
  }

  // src/review.js
  function bounded(value, fallback, min, max = Infinity) {
    const number2 = Number(value);
    return Number.isFinite(number2) ? Math.min(max, Math.max(min, number2)) : fallback;
  }
  function reviewError(message) {
    const error = new Error(message);
    error.code = "REVIEW_UNAVAILABLE";
    return error;
  }
  function sourceOf(note) {
    return normalizeSource2(note?.source ?? note?.identity?.source ?? note?.url);
  }
  function createReviewController({ player, onState = () => {
  }, notify = () => {
  } } = {}) {
    if (!player?.getCurrent || !player?.seek || !player?.subscribe) throw new TypeError("循环播放需要 player adapter");
    let disposed = false;
    let generation = 0;
    let currentRun = null;
    let operations = Promise.resolve();
    let state = {
      active: false,
      phase: "idle",
      iteration: 0,
      count: 0,
      start: 0,
      end: 0,
      gap: 0,
      rate: 1,
      sourceId: null,
      reason: null
    };
    function getState() {
      return { ...state };
    }
    function publish(update) {
      state = { ...state, ...update };
      try {
        onState(getState());
      } catch {
      }
    }
    function announce(message) {
      try {
        notify(message);
      } catch {
      }
    }
    function owns(run) {
      return !disposed && currentRun === run && run.generation === generation && !run.cancelled;
    }
    function enqueue(operation) {
      const result = operations.then(operation, operation);
      operations = result.catch(() => {
      });
      return result;
    }
    function samePlayback(run, snapshot = player.getCurrent()) {
      return snapshot?.identity?.source?.sourceId === run.source.sourceId && snapshot.media === run.media && snapshot.sourceReady !== false;
    }
    function restoreRate(run) {
      if (!run?.rateChanged || !run.original?.media) return;
      try {
        run.original.media.playbackRate = run.original.rate;
      } catch {
      }
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
        try {
          media.currentTime = Math.max(0, target);
        } catch {
        }
      }
      try {
        if (original.paused) media.pause?.();
        else {
          const result = media.play?.();
          result?.catch?.(() => announce("已恢复位置与倍速，请手动继续播放"));
        }
      } catch {
        announce("已恢复位置与倍速，请手动继续播放");
      }
    }
    function terminate(run, { restore = true, reason = "stopped", message = null } = {}) {
      if (!run || currentRun !== run) return Promise.resolve();
      generation++;
      currentRun = null;
      cleanup(run);
      publish({ active: false, phase: "idle", reason });
      return enqueue(() => {
        if (!disposed) restorePlayback(run, restore);
        if (message && !disposed) announce(message);
      });
    }
    function stop({ restore = true } = {}) {
      if (!currentRun) return operations.then(() => void 0);
      return terminate(currentRun, { restore, reason: "stopped" });
    }
    function interrupt(run, reason, message) {
      if (!owns(run)) return;
      void terminate(run, { restore: false, reason, message });
    }
    function ensureSource(run) {
      if (!owns(run)) return false;
      if (samePlayback(run)) return true;
      interrupt(run, "source-changed", "视频已切换，循环已停止");
      return false;
    }
    function play(run) {
      if (!ensureSource(run)) return;
      try {
        const result = run.media.play?.();
        result?.catch?.(() => {
          if (owns(run)) interrupt(run, "play-blocked", "浏览器未能开始播放，循环已停止，请手动播放后重试");
        });
      } catch {
        interrupt(run, "play-blocked", "当前播放器无法开始播放，循环已停止");
      }
    }
    function jumpToStart(run) {
      if (!ensureSource(run)) return false;
      run.expectedSeek = run.start;
      try {
        run.media.currentTime = run.start;
      } catch {
        interrupt(run, "seek-failed", "播放器暂时无法定位，循环已停止");
        return false;
      }
      return owns(run);
    }
    function nextIteration(run) {
      if (!ensureSource(run)) return;
      run.phase = "playing";
      run.iteration++;
      publish({ phase: "playing", iteration: run.iteration });
      if (jumpToStart(run)) play(run);
    }
    function reachEnd(run, origin = "timeupdate") {
      if (!owns(run) || run.phase !== "playing" || run.transitioning) return;
      if (!ensureSource(run)) return;
      run.transitioning = true;
      if (run.iteration >= run.options.count) {
        void terminate(run, {
          restore: true,
          reason: "completed",
          message: `已完成 ${run.options.count} 次循环，已恢复原播放状态`
        });
        return;
      }
      if (run.media.ended && origin === "timeupdate") run.expectedPause = true;
      if (run.options.gap === 0) {
        run.transitioning = false;
        nextIteration(run);
        return;
      }
      run.phase = "gap";
      publish({ phase: "gap" });
      if (!run.media.paused) {
        run.expectedPause = true;
        try {
          run.media.pause?.();
        } catch {
          run.transitioning = false;
          interrupt(run, "pause-failed", "播放器暂时无法暂停，循环已停止");
          return;
        }
      }
      run.transitioning = false;
      if (!owns(run)) return;
      run.timer = run.setTimer(() => {
        run.timer = null;
        if (!ensureSource(run) || run.phase !== "gap") return;
        if (!run.media.paused) {
          interrupt(run, "user-control", "已保留你的播放操作，循环已停止");
          return;
        }
        nextIteration(run);
      }, run.options.gap * 1e3);
    }
    function attach(run) {
      const listen = (type, handler) => {
        run.media.addEventListener(type, handler);
        run.listeners.push(() => run.media.removeEventListener(type, handler));
      };
      listen("timeupdate", () => {
        if (!owns(run) || run.phase !== "playing") return;
        const time = run.media.currentTime;
        if (run.media.seeking && (!Number.isFinite(run.expectedSeek) || Math.abs(time - run.expectedSeek) > 0.1)) {
          if (time < run.start - 0.1 || time > run.end + 0.1) interrupt(run, "user-seek", "已保留你的播放位置，循环已停止");
          return;
        }
        if (time >= run.end) reachEnd(run);
      });
      listen("ended", () => {
        if (run.media.ended || run.media.currentTime >= run.end) reachEnd(run, "ended");
      });
      listen("seeking", () => {
        if (!owns(run)) return;
        const time = run.media.currentTime;
        if (Number.isFinite(run.expectedSeek) && Math.abs(time - run.expectedSeek) <= 0.1) return;
        run.expectedSeek = null;
        if (run.phase === "gap" || !Number.isFinite(time) || time < run.start - 0.1 || time > run.end + 0.1) {
          interrupt(run, "user-seek", "已保留你的播放位置，循环已停止");
        }
      });
      listen("seeked", () => {
        run.expectedSeek = null;
      });
      listen("pause", () => {
        if (!owns(run)) return;
        if (run.expectedPause) {
          run.expectedPause = false;
          return;
        }
        if (run.media.ended && run.media.currentTime >= run.end) {
          if (run.phase === "playing") reachEnd(run, "pause");
          return;
        }
        interrupt(run, "user-pause", "已保留暂停状态，循环已停止");
      });
      listen("play", () => {
        if (!owns(run)) return;
        if (run.phase === "gap") interrupt(run, "user-control", "已保留你的播放操作，循环已停止");
      });
    }
    function start2(note, { before = 3, after = 3, count = 3, gap = 0, rate = 1 } = {}) {
      if (disposed) return Promise.reject(reviewError("循环播放器已关闭"));
      const source = sourceOf(note);
      if (!source) return Promise.reject(reviewError("这条笔记缺少可靠的播放来源，无法循环"));
      if (!Number.isFinite(note?.time) || note.time < 0) return Promise.reject(reviewError("这条笔记的时间戳无效"));
      const options = {
        before: bounded(before, 3, 0),
        after: bounded(after, 3, 0),
        count: Math.floor(bounded(count, 3, 1, 20)),
        gap: bounded(gap, 0, 0, 10),
        rate: bounded(rate, 1, 0.5, 2)
      };
      const previous = currentRun;
      cleanup(previous);
      const run = {
        generation: ++generation,
        source,
        note,
        options,
        cancelled: false,
        listeners: [],
        phase: "starting",
        iteration: 1,
        start: Math.max(0, note.time - options.before),
        end: note.time + options.after,
        media: null,
        original: previous?.original ?? null,
        rateChanged: false,
        expectedPause: false,
        expectedSeek: null,
        timer: null,
        setTimer: globalThis.setTimeout,
        clearTimer: globalThis.clearTimeout,
        watchSourceId: null,
        transitioning: false
      };
      currentRun = run;
      publish({
        active: true,
        phase: "starting",
        iteration: 1,
        count: options.count,
        start: run.start,
        end: run.end,
        gap: options.gap,
        rate: options.rate,
        sourceId: source.sourceId,
        reason: null
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
            sourceId: source.sourceId,
            media: initial.media,
            time: Number.isFinite(oldTime) ? oldTime : null,
            paused: Boolean(initial.media.paused),
            rate: Number.isFinite(initial.media.playbackRate) ? initial.media.playbackRate : 1
          };
        }
        try {
          const result = await player.seek(note, { leadIn: options.before });
          if (!owns(run)) return { cancelled: true };
          if (result?.navigated) {
            generation++;
            currentRun = null;
            cleanup(run);
            publish({ active: false, phase: "idle", reason: "navigated" });
            announce("已跳转到原视频；页面就绪后，再点一次循环");
            return { navigated: true };
          }
          const snapshot = player.getCurrent();
          if (!snapshot?.media || snapshot.identity?.source?.sourceId !== source.sourceId || snapshot.sourceReady === false) {
            throw reviewError("视频已切换，无法开始循环");
          }
          if (run.original && snapshot.media !== run.original.media) throw reviewError("播放器已更换，请重新开始循环");
          run.media = snapshot.media;
          run.watchSourceId = source.sourceId;
          if (!run.original) {
            run.original = {
              sourceId: source.sourceId,
              media: snapshot.media,
              time: null,
              paused: Boolean(snapshot.media.paused),
              rate: Number.isFinite(snapshot.media.playbackRate) ? snapshot.media.playbackRate : 1
            };
          }
          const duration = snapshot.media.duration;
          if (!(duration > 0)) throw reviewError("视频时长尚未就绪，请稍后重试循环");
          run.end = Math.min(duration, note.time + options.after);
          if (!(run.start < run.end)) throw reviewError("循环区间为空，请调整卡片时间或前后秒数");
          const mediaWindow = snapshot.media.ownerDocument?.defaultView;
          run.setTimer = mediaWindow?.setTimeout?.bind(mediaWindow) ?? globalThis.setTimeout;
          run.clearTimer = mediaWindow?.clearTimeout?.bind(mediaWindow) ?? globalThis.clearTimeout;
          run.media.playbackRate = options.rate;
          run.rateChanged = true;
          run.phase = "playing";
          attach(run);
          publish({ phase: "playing", start: run.start, end: run.end });
          play(run);
          return { navigated: false };
        } catch (error) {
          if (!owns(run)) return { cancelled: true };
          generation++;
          currentRun = null;
          cleanup(run);
          restorePlayback(run, true);
          publish({ active: false, phase: "idle", reason: "error" });
          throw error;
        }
      });
    }
    const unsubscribe = player.subscribe((snapshot) => {
      const run = currentRun;
      if (!run || !run.watchSourceId) return;
      if (snapshot?.identity?.source?.sourceId !== run.watchSourceId || snapshot.media !== run.media || run.phase !== "starting" && snapshot.sourceReady === false) {
        interrupt(run, "source-changed", "视频已切换，循环已停止");
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
      publish({ active: false, phase: "idle", reason: "disposed" });
    }
    return { start: start2, stop, getState, dispose };
  }

  // src/app.css
  var app_default = '.bcm-root {\n  --bcm-text: #f2f6fb; --bcm-muted: #b8c9dd; --bcm-surface: #141c26;\n  --bcm-panel: #1c2733; --bcm-line: #405063; --bcm-accent: #75d2fa;\n  position: fixed; inset: 0; z-index: 2147483000; pointer-events: none;\n  color: var(--bcm-text); font: 14px/1.5 system-ui, "Microsoft YaHei", sans-serif;\n  text-align: start; color-scheme: dark;\n}\n.bcm-root [hidden], .bcm-dock[hidden], .bcm-mask[hidden] { display: none !important; }\n.bcm-root *, .bcm-dock *, .bcm-mask * { box-sizing: border-box; }\n.bcm-root :focus-visible, .bcm-dock :focus-visible, .bcm-mask :focus-visible { outline: 2px solid #75d2fa; outline-offset: 3px; }\n.bcm-root button, .bcm-root input, .bcm-root select, .bcm-dock button, .bcm-mask button { font: inherit; }\n.bcm-root ::selection { background: #75d2fa; color: #092333; }\n.bcm-root button:disabled, .bcm-dock button:disabled { opacity: .6; cursor: wait; }\n.bcm-root .bcm-notebook { z-index: 10; }\n.bcm-root .bcm-loopbar { z-index: 20; }\n.bcm-root .bcm-panel { z-index: 30; }\n.bcm-root .bcm-notification { z-index: 40; pointer-events: none; }\n.bcm-mask {\n  position: absolute !important; z-index: 25 !important; box-sizing: border-box !important;\n  user-select: none; touch-action: none; cursor: pointer; pointer-events: auto;\n  background: transparent; backdrop-filter: blur(var(--bcm-blur,14px));\n  -webkit-backdrop-filter: blur(var(--bcm-blur,14px));\n  mask-image: linear-gradient(to right,transparent,#000 5%,#000 95%,transparent),linear-gradient(to bottom,transparent,#000 16%,#000 84%,transparent);\n  mask-composite: intersect;\n  -webkit-mask-image: linear-gradient(to right,transparent,#000 5%,#000 95%,transparent),linear-gradient(to bottom,transparent,#000 16%,#000 84%,transparent);\n  -webkit-mask-composite: source-in;\n}\n.bcm-mask.bcm-solid { background: #151b22; backdrop-filter: none; -webkit-backdrop-filter: none; }\n.bcm-mask:not(.bcm-edit):not(.bcm-wheeling):hover, .bcm-mask.bcm-peek:not(.bcm-edit):not(.bcm-wheeling) {\n  background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; mask-image: none; -webkit-mask-image: none;\n}\n.bcm-mask.bcm-edit, .bcm-mask.bcm-wheeling {\n  mask-image: none; -webkit-mask-image: none; outline: 2px dashed #75d2fa;\n  background: rgb(16 49 66 / 45%); backdrop-filter: blur(3px); cursor: move;\n}\n.bcm-mask .bcm-mask-tools {\n  position: absolute; bottom: calc(100% + 8px); right: 0; display: none;\n  align-items: center; flex-wrap: wrap; gap: 6px; min-width: 180px;\n  padding: 5px 8px; border-radius: 7px; background: #141c26; color: #f2f6fb;\n  font: 12px/1.5 system-ui, sans-serif;\n}\n.bcm-mask.bcm-edit .bcm-mask-tools { display: flex; }\n.bcm-mask-tools button, .bcm-dock button {\n  appearance: none; color: #eaf5ff; background: transparent; border: 0;\n  padding: 6px 8px; min-height: 30px; border-radius: 5px; cursor: pointer;\n}\n.bcm-dock button:hover, .bcm-mask-tools button:hover { background: #34495c; }\n.bcm-handle { display: none; position: absolute; width: 12px; height: 12px; background: #75d2fa; border: 1px solid #0e2836; border-radius: 2px; }\n.bcm-edit .bcm-handle { display: block; }\n.bcm-handle[data-handle="n"] { top:-6px; left:calc(50% - 6px); cursor:ns-resize; }\n.bcm-handle[data-handle="s"] { bottom:-6px; left:calc(50% - 6px); cursor:ns-resize; }\n.bcm-handle[data-handle="e"] { right:-6px; top:calc(50% - 6px); cursor:ew-resize; }\n.bcm-handle[data-handle="w"] { left:-6px; top:calc(50% - 6px); cursor:ew-resize; }\n.bcm-handle[data-handle="nw"] { top:-6px; left:-6px; cursor:nwse-resize; }\n.bcm-handle[data-handle="ne"] { top:-6px; right:-6px; cursor:nesw-resize; }\n.bcm-handle[data-handle="sw"] { bottom:-6px; left:-6px; cursor:nesw-resize; }\n.bcm-handle[data-handle="se"] { bottom:-6px; right:-6px; cursor:nwse-resize; }\n.bcm-dock {\n  position: absolute; top: 12px; right: 12px; z-index: 26;\n  display: flex; flex-wrap: wrap; align-items: center; gap: 2px; max-width: calc(100% - 24px);\n  padding: 4px 6px; border-radius: 9px; background: rgb(20 28 38 / 92%);\n  color: #f2f6fb; font: 12px/1.4 system-ui, "Microsoft YaHei", sans-serif;\n  transition: opacity .2s ease; pointer-events: auto;\n}\n.bcm-dock.bcm-idle:not(:hover):not(:focus-within) { opacity: 0; pointer-events: none; }\n.bcm-dock .bcm-version-button { color: #75d2fa; font-variant-numeric: tabular-nums; }\n.bcm-notification {\n  position: absolute; top: 18px; left: 50%; transform: translateX(-50%);\n  max-width: min(620px,calc(100% - 32px)); padding: 12px 18px; border-radius: 9px;\n  background: #1c2733; color: #f2f6fb; box-shadow: 0 8px 24px rgb(0 0 0 / 28%);\n  overflow-wrap: anywhere; pointer-events: auto;\n}\n.bcm-notification[data-kind="error"] { color: #ffc0bc; }\n.bcm-panel {\n  position: absolute; top: 14px; right: 14px; width: min(390px,calc(100% - 28px));\n  max-height: calc(100% - 28px); overflow: auto; padding: 20px; border-radius: 12px;\n  background: #141c26; color: #f2f6fb; box-shadow: 0 12px 32px rgb(0 0 0 / 32%);\n  pointer-events: auto; scrollbar-color: #536b80 #141c26;\n}\n.bcm-panel h2 { margin: 0 0 14px; font-size: 20px; font-weight: 650; }\n.bcm-panel p { margin: 10px 0; color: #b8c9dd; }\n.bcm-panel label { display: grid; grid-template-columns: 1fr 112px; gap: 12px; align-items: center; margin: 12px 0; }\n.bcm-panel input:not([type="checkbox"]), .bcm-panel select {\n  min-width: 0; width: 100%; min-height: 34px; padding: 6px 8px;\n  border: 1px solid #53677b; border-radius: 5px; background: #111923; color: #f2f6fb;\n}\n.bcm-panel input[type="checkbox"] { justify-self: end; width: 18px; height: 18px; accent-color: #75d2fa; }\n.bcm-panel button, .bcm-loopbar button {\n  border: 1px solid #53677b; background: #253647; color: #f2f6fb; border-radius: 6px;\n  min-height: 34px; padding: 7px 12px; cursor: pointer;\n}\n.bcm-panel button:hover, .bcm-loopbar button:hover { background: #38536b; }\n.bcm-panel .bcm-primary { background: #75d2fa; border-color: #75d2fa; color: #092333; }\n.bcm-panel-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 18px; }\n.bcm-panel dl { margin: 14px 0; }\n.bcm-panel dt { margin-top: 12px; font-weight: 650; }\n.bcm-panel dd { margin: 4px 0 0; color: #b8c9dd; }\n.bcm-loopbar {\n  position: absolute; bottom: 74px; left: 50%; transform: translateX(-50%);\n  display: flex; align-items: center; flex-wrap: wrap; gap: 12px;\n  max-width: calc(100% - 24px); padding: 10px 14px; border-radius: 9px;\n  background: #141c26; color: #f2f6fb; pointer-events: auto;\n  font-variant-numeric: tabular-nums;\n}\n@media (max-width: 540px) {\n  .bcm-dock { top: 6px; right: 6px; max-width: calc(100% - 12px); }\n  .bcm-dock button { padding: 5px 6px; }\n  .bcm-notification { top: 6px; }\n}\n@media (prefers-reduced-motion: reduce) { .bcm-dock { transition: none; } }\n';

  // src/notebook.css
  var notebook_default = '.bcm-notebook {\n    --bcm-surface: #141c26;\n    --bcm-panel: #1c2733;\n    --bcm-field: #111923;\n    --bcm-line: #405063;\n    --bcm-text: #f2f6fb;\n    --bcm-muted: #b8c9dd;\n    --bcm-accent: #75d2fa;\n    --bcm-accent-ink: #092333;\n    --bcm-error: #ffc0bc;\n    position: absolute;\n    inset-block: 0;\n    inset-inline-end: 0;\n    display: flex;\n    flex-direction: column;\n    box-sizing: border-box;\n    width: 420px;\n    max-width: 100vw;\n    max-width: min(100vw, 100%);\n    height: 100%;\n    min-height: 0;\n    overflow: hidden;\n    color: var(--bcm-text);\n    background: var(--bcm-surface);\n    box-shadow: -12px 0 32px rgb(0 0 0 / 30%);\n    font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;\n    text-align: start;\n    color-scheme: dark;\n    isolation: isolate;\n    pointer-events: auto;\n}\n\n.bcm-notebook [hidden], .bcm-notebook[hidden] { display: none !important; }\n.bcm-notebook *, .bcm-notebook *::before, .bcm-notebook *::after { box-sizing: border-box; }\n.bcm-notebook h2, .bcm-notebook h3, .bcm-notebook p { margin: 0; padding: 0; }\n.bcm-notebook button, .bcm-notebook input, .bcm-notebook select, .bcm-notebook textarea { font: inherit; letter-spacing: normal; }\n.bcm-notebook ::selection { color: var(--bcm-accent-ink); background: var(--bcm-accent); }\n.bcm-notebook :focus-visible { outline: 2px solid var(--bcm-accent); outline-offset: 3px; }\n.bcm-notebook button:disabled { opacity: .55; cursor: not-allowed; }\n.bcm-notebook button { touch-action: manipulation; }\n.bcm-notebook-header { flex: none; padding: 18px 18px 14px; border-block-end: 1px solid var(--bcm-line); background: var(--bcm-surface); }\n.bcm-heading-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }\n.bcm-notebook .bcm-notebook-title { margin-inline-end: auto; font-size: 20px; line-height: 1.3; font-weight: 650; }\n.bcm-version { color: var(--bcm-accent); font-size: 12px; font-variant-numeric: tabular-nums; }\n.bcm-notebook .bcm-subtitle { margin-block: 8px 12px; color: var(--bcm-muted); font-size: 14px; }\n.bcm-toolbar { display: flex; flex-wrap: wrap; gap: 8px; }\n.bcm-notebook .bcm-button {\n    appearance: none;\n    display: inline-flex;\n    justify-content: center;\n    align-items: center;\n    gap: 6px;\n    min-height: 36px;\n    max-width: 100%;\n    padding: 7px 11px;\n    border: 1px solid var(--bcm-line);\n    border-radius: 7px;\n    color: var(--bcm-text);\n    background: var(--bcm-panel);\n    font-size: 13px;\n    line-height: 1.3;\n    text-align: center;\n    text-decoration: none;\n    overflow-wrap: anywhere;\n    cursor: pointer;\n}\n.bcm-notebook .bcm-button:hover:not(:disabled) { background: #2b3c4e; border-color: #7891aa; }\n.bcm-notebook .bcm-button-primary { color: var(--bcm-accent-ink); background: var(--bcm-accent); border-color: transparent; font-weight: 650; }\n.bcm-notebook .bcm-button-primary:hover:not(:disabled) { background: #a0e3ff; border-color: transparent; }\n.bcm-notebook .bcm-button-quiet { background: transparent; border-color: transparent; color: var(--bcm-muted); }\n.bcm-notebook .bcm-delete:hover:not(:disabled) { color: var(--bcm-error); background: #452d32; border-color: transparent; }\n.bcm-notebook-scroll { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; scrollbar-color: #657c92 var(--bcm-surface); scrollbar-width: thin; }\n.bcm-notebook-scroll::-webkit-scrollbar { width: 8px; }\n.bcm-notebook-scroll::-webkit-scrollbar-track { background: var(--bcm-surface); }\n.bcm-notebook-scroll::-webkit-scrollbar-thumb { background: #657c92; border-radius: 8px; border: 2px solid var(--bcm-surface); }\n.bcm-filters { padding: 18px; display: grid; gap: 12px; }\n.bcm-field { display: grid; gap: 6px; min-width: 0; }\n.bcm-label { color: var(--bcm-muted); font-size: 12px; line-height: 1.4; }\n.bcm-filter-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }\n.bcm-notebook .bcm-input, .bcm-notebook .bcm-select {\n    appearance: auto;\n    display: block;\n    width: 100%;\n    min-width: 0;\n    max-width: 100%;\n    min-height: 38px;\n    padding: 8px 10px;\n    border: 1px solid var(--bcm-line);\n    border-radius: 7px;\n    color: var(--bcm-text);\n    background: var(--bcm-field);\n    caret-color: var(--bcm-accent);\n    font-size: 14px;\n    line-height: 1.5;\n}\n.bcm-notebook .bcm-input::placeholder { color: #a3b7ce; opacity: 1; }\n.bcm-notebook textarea.bcm-input { min-height: 86px; resize: vertical; overflow-wrap: anywhere; }\n.bcm-summary-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }\n.bcm-result-summary { flex: 1; color: var(--bcm-muted); font-size: 12px; font-variant-numeric: tabular-nums; }\n.bcm-notices, .bcm-undo { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 0 18px 16px; padding: 12px; background: #233747; border-radius: 8px; overflow-wrap: anywhere; }\n.bcm-notices > span, .bcm-undo > span { flex: 1 1 180px; }\n.bcm-notice-error { color: var(--bcm-error); background: #3b272d; }\n.bcm-import-preview { margin: 0 18px 18px; padding: 14px; background: var(--bcm-panel); border-radius: 8px; overflow-wrap: anywhere; }\n.bcm-notebook .bcm-import-preview h3 { font-size: 16px; margin-block-end: 8px; }\n.bcm-notebook .bcm-import-preview p { margin-block-end: 12px; }\n.bcm-note-list { padding-inline: 18px; }\n.bcm-note { display: grid; gap: 12px; padding-block: 20px 22px; border-block-start: 1px solid var(--bcm-line); min-width: 0; }\n.bcm-note-header { display: flex; align-items: start; gap: 10px; min-width: 0; }\n.bcm-notebook .bcm-note-title { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 15px; line-height: 1.5; font-weight: 600; }\n.bcm-note-header .bcm-button { flex-shrink: 0; }\n.bcm-note-meta { color: var(--bcm-muted); font-size: 12px; overflow-wrap: anywhere; }\n.bcm-image-placeholder { display: grid; align-items: center; min-height: 80px; aspect-ratio: 16 / 9; overflow: hidden; border-radius: 8px; color: var(--bcm-muted); background: #0c121a; font-size: 13px; text-align: center; }\n.bcm-note-image { display: block; width: 100%; height: 100%; object-fit: contain; }\n.bcm-playback-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }\n.bcm-play-button { font-variant-numeric: tabular-nums; }\n.bcm-note-bottom { display: grid; grid-template-columns: minmax(0, 1fr) minmax(100px, 1fr); align-items: end; gap: 12px; }\n.bcm-save-state { padding-block-end: 10px; color: var(--bcm-muted); font-size: 12px; text-align: end; overflow-wrap: anywhere; }\n.bcm-save-error { color: var(--bcm-error); }\n.bcm-empty { padding: 28px 8px 36px; color: var(--bcm-muted); overflow-wrap: anywhere; }\n.bcm-notebook .bcm-empty h3 { color: var(--bcm-text); font-size: 16px; margin-block-end: 10px; }\n.bcm-pagination { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; padding: 14px 18px; border-block-start: 1px solid var(--bcm-line); }\n.bcm-page-label { color: var(--bcm-muted); font-size: 12px; font-variant-numeric: tabular-nums; }\n.bcm-notebook .bcm-storage-note { padding: 16px 18px 22px; color: var(--bcm-muted); font-size: 12px; overflow-wrap: anywhere; }\n@media (max-width: 440px) {\n    .bcm-notebook { width: 100%; }\n    .bcm-notebook-header { padding: 12px; }\n    .bcm-filters { padding: 14px 12px; }\n    .bcm-note-list { padding-inline: 12px; }\n    .bcm-notices, .bcm-undo, .bcm-import-preview { margin-inline: 12px; }\n    .bcm-notebook .bcm-input, .bcm-notebook .bcm-select { font-size: 16px; }\n    .bcm-toolbar { gap: 6px; }\n}\n@media (max-height: 420px) {\n    .bcm-notebook-header { padding-block: 10px; }\n    .bcm-notebook .bcm-subtitle { display: none; }\n    .bcm-notebook-header .bcm-toolbar { margin-block-start: 8px; }\n}\n@media (prefers-reduced-motion: reduce) {\n    .bcm-notebook *, .bcm-notebook *::before, .bcm-notebook *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }\n}\n@media (forced-colors: active) {\n    .bcm-notebook { border: 1px solid CanvasText; }\n    .bcm-notebook :focus-visible { outline-color: Highlight; }\n    .bcm-notebook .bcm-button { border: 1px solid ButtonText; }\n}\n';

  // src/main.js
  var VERSION = "2.4.0";
  var clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  var editable = (target) => !!(target?.isContentEditable || target?.closest?.('input,textarea,select,[role="textbox"]'));
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
    function notify(message, { kind = "info", duration = kind === "error" ? 7e3 : 3e3 } = {}) {
      notification.textContent = message;
      notification.dataset.kind = kind;
      notification.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        notification.hidden = true;
      }, duration);
    }
    const fail2 = (error) => notify(error?.message || "操作失败，请重试。", { kind: "error" });
    const panel = el("section", "bcm-panel");
    panel.hidden = true;
    panel.inert = true;
    panel.setAttribute("aria-label", "遮罩与复习设置");
    root.append(panel);
    function closePanel() {
      panel.hidden = true;
      panel.inert = true;
      if (panelReturnFocus?.isConnected) panelReturnFocus.focus();
      wakeDock();
    }
    function showPanel(title) {
      panelReturnFocus = document.activeElement;
      panel.replaceChildren(el("h2", "", title));
      panel.hidden = false;
      panel.inert = false;
      wakeDock();
    }
    function showHelp() {
      showPanel(`看剧学英语 v${VERSION}`);
      panel.append(el("p", "", "先遮中文听一遍；遇到难句收藏，再回到原片段复听。"));
      const list = el("dl");
      for (const [key, desc] of [
        ["Alt + S / S", "收藏当前画面与来源时间；关闭单字母快捷键后，仅 Alt 组合有效。"],
        ["Alt + B / B", "打开场景复习本，搜索、标记掌握或导出备份。"],
        ["Alt + 滚轮", "只在播放器内微调遮罩高度。"],
        ["悬停遮罩 / 按住 Alt", "临时看清中文，移开或松键恢复。"],
        ["Alt + Z / Shift + Z", "进入或退出拖动、拉伸模式。"],
        ["Alt + C / Shift + C", "开关中文字幕遮罩。"],
        ["循环复听", "以收藏点前后几秒为区间，完成后返回开始复习前的进度。"]
      ]) list.append(el("dt", "", key), el("dd", "", desc));
      panel.append(list, el("p", "", "收藏只保存在当前浏览器的本机数据中。建议定期在复习本导出 JSON 备份；HTML 用于离线阅读。"));
      const done = button2("开始看剧", closePanel, "bcm-primary");
      panel.append(done);
      done.focus();
    }
    function showSettings() {
      if (!snapshot) return;
      config = settings.get(snapshot.identity.seriesId);
      showPanel("遮罩与复习设置");
      panel.append(el("p", "", `v${VERSION} · 位置按剧集记忆，其他偏好全局生效。`));
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
          if (type === "checkbox") input.checked = config[key];
          else {
            input.value = config[key];
            input.min = min;
            input.max = max;
            input.step = step ?? 1;
            input.required = true;
          }
        }
        row.append(input);
        form.append(row);
        inputs.set(key, input);
      };
      add("mode", "遮挡方式", "select");
      add("blur", "模糊强度", "number", 0, 40);
      add("singleKeys", "启用 S / B 单字母快捷键", "checkbox");
      add("leadIn", "回听提前（秒）", "number", 0, 30, 0.5);
      add("loopBefore", "循环向前（秒）", "number", 0, 60, 0.5);
      add("loopAfter", "循环向后（秒）", "number", 0.5, 60, 0.5);
      add("loopCount", "循环次数", "number", 1, 20);
      add("loopGap", "循环间隔（秒）", "number", 0, 10, 0.5);
      add("playbackRate", "复听倍速", "number", 0.5, 2, 0.25);
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
        for (const [key, input] of inputs) patch[key] = input.type === "checkbox" ? input.checked : input.tagName === "SELECT" ? input.value : Number(input.value);
        if (patch.loopBefore + patch.loopAfter <= 0) {
          notify("循环区间需要大于 0 秒", { kind: "error" });
          return;
        }
        try {
          config = settings.patch(snapshot.identity.seriesId, patch);
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
    const loopbar = el("div", "bcm-loopbar");
    loopbar.hidden = true;
    const loopText = el("span");
    root.append(loopbar);
    const review = createReviewController({ player, notify, onState(state) {
      loopbar.hidden = !state.active;
      loopText.textContent = `循环 ${state.iteration || 1} / ${state.count || 1} · ${formatTime(state.start)}–${formatTime(state.end)}`;
    } });
    loopbar.append(loopText, button2("结束并返回", () => review.stop({ restore: true }).catch(fail2)));
    const notebook = createNotebook({
      repo,
      player,
      notify,
      version: VERSION,
      onChange: updateCount,
      getLeadIn: () => settings.get(snapshot?.identity.seriesId || "global_default").leadIn,
      onHelp: showHelp,
      onSettings: showSettings,
      onLoop: async (note) => {
        config = settings.get(snapshot?.identity.seriesId || note.seriesId);
        await review.start(note, { before: config.loopBefore, after: config.loopAfter, count: config.loopCount, gap: config.loopGap, rate: config.playbackRate });
      }
    });
    root.append(notebook.element);
    async function updateCount() {
      const generation = ++countGeneration;
      const sid = snapshot?.identity.seriesId;
      if (!sid) return;
      try {
        const total = await repo.count(sid);
        if (generation === countGeneration && dock) dock.querySelector('[data-action="notebook"]').textContent = `复习本 ${total}`;
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
      const btn = dock?.querySelector('[data-action="capture"]');
      if (btn) {
        btn.disabled = true;
        btn.textContent = "保存中…";
      }
      try {
        let shot;
        try {
          shot = await player.capture();
        } catch (error) {
          if (!["FRAME_UNAVAILABLE", "CAPTURE_FAILED", "CAPTURE_TIMEOUT"].includes(error.code)) throw error;
          const current = player.getCurrent();
          const time = player.getTime();
          if (!current || time === null || !current.sourceReady) throw error;
          shot = { identity: current.identity, time, imageBlob: null };
        }
        const note = {
          id: `note_${crypto.randomUUID()}`,
          ...shot.identity,
          time: shot.time,
          timeStr: formatTime(shot.time),
          userNote: "",
          tags: [],
          reviewState: "new",
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        if (shot.imageBlob) note.imageBlob = shot.imageBlob;
        await repo.save(note);
        await updateCount();
        if (notebook.isOpen()) await notebook.refresh();
        notify(shot.imageBlob ? `已收藏 ${note.timeStr} · 可在复习本回听` : `画面无法截取，已保存 ${note.timeStr} 的来源书签`, { kind: "success" });
      } catch (error) {
        fail2(error);
      } finally {
        captureBusy = false;
        if (btn?.isConnected) {
          btn.disabled = false;
          btn.textContent = "收藏此句";
        }
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
      mask = el("div", "bcm-mask");
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
      dock = el("div", "bcm-dock");
      dock.setAttribute("role", "toolbar");
      dock.setAttribute("aria-label", `看剧学英语 v${VERSION}`);
      for (const [name, title, action] of [
        ["version", `v${VERSION}`, showSettings],
        ["toggle", "遮罩 开", toggleMask],
        ["edit", "调节", toggleEdit],
        ["capture", "收藏此句", capture],
        ["notebook", "复习本", () => notebook.toggle().catch(fail2)],
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
        updateCount();
        if (notebook.isOpen()) notebook.refresh().catch(fail2);
      }
      if (current && !initialized) {
        initialized = true;
        repo.ready().then(updateCount).catch(fail2);
        player.resumePendingSeek().then((result) => {
          if (result.resumed) {
            notify("已返回收藏片段");
            player.getCurrent()?.media.play?.().catch(() => notify("已定位收藏片段，点击播放继续"));
          }
        }).catch(fail2);
        try {
          if (!local?.getItem("bili_caption_welcome_v240")) {
            notify(`v${VERSION} 已就绪 · S 收藏，B 打开复习本；帮助中可查看全部操作`, { duration: 6e3 });
            local?.setItem("bili_caption_welcome_v240", "1");
          }
        } catch {
        }
      }
      fullscreen();
    });
    const events = new AbortController();
    window.addEventListener("wheel", (event) => {
      if (!snapshot || !event.altKey || event.ctrlKey || event.metaKey || !config.enabled || edit || editable(event.target) || !container.contains(event.target) || !event.deltaY) return;
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
      if (!snapshot || editable(event.target) || event.isComposing || event.ctrlKey || event.metaKey) return;
      if (event.key === "Alt") {
        peek = true;
        paint();
        return;
      }
      if (event.repeat) return;
      const key = (event.code?.replace(/^Key/, "") || event.key).toUpperCase();
      const oneKey = config.singleKeys && !event.altKey && !event.shiftKey;
      let action;
      if ((event.altKey || oneKey) && key === "S") action = capture;
      if ((event.altKey || oneKey) && key === "B") action = () => notebook.toggle().catch(fail2);
      if ((event.altKey || event.shiftKey) && key === "C") action = toggleMask;
      if ((event.altKey || event.shiftKey) && key === "Z") action = toggleEdit;
      if (action) {
        event.preventDefault();
        event.stopImmediatePropagation();
        try {
          action();
        } catch (error) {
          fail2(error);
        }
        wakeDock();
      }
    }, { capture: true, signal: events.signal });
    window.addEventListener("keyup", (event) => {
      if (event.key === "Alt") {
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
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && snapshot) {
        config = settings.get(configSeries);
        paint();
      }
    }, { signal: events.signal });
    window.addEventListener("pagehide", () => {
      saveGeometry();
    }, { signal: events.signal });
    window.addEventListener("unload", () => {
      unsubscribe();
      player.dispose();
      review.dispose();
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
