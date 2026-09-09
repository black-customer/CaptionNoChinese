// ==UserScript==
// @name         Bilibili 剧集双语字幕羽化遮罩与生词本 (看剧学英语)
// @namespace    https://github.com/CaptionNoChinese
// @version      2.2.0
// @description  在 B 站看剧学英语：无边框羽化光学模糊中文字幕，Alt+滚轮精准盲调无误触；控制栏呼吸自动隐藏，一键截取高清剧照 + 精准时间戳定位与 IndexedDB 侧边生词复习抽屉。
// @author       Antigravity
// @match        *://*.bilibili.com/*
// @match        *://bilibili.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    console.log('%c[看剧学英语 v2.2.0] 启动中：无边框羽化模糊 + 呼吸自动隐藏 + IndexedDB海量存储 + 新手开箱引导', 'background: #00aeec; color: #fff; padding: 3px 8px; border-radius: 4px; font-weight: bold;');

    // 默认遮罩配置（百分比 %）
    const PRESET_BOTTOM = { left: 15, top: 84, width: 70, height: 7.2 };
    const DEFAULT_GLOBAL = {
        enabled: true,
        ...PRESET_BOTTOM
    };

    const CONFIG_STORAGE_KEY = 'bili_caption_mask_v200_cfg';
    const OLD_NOTES_STORAGE_KEY = 'bili_caption_notes_v200';
    const ONBOARDING_SEEN_KEY = 'bili_caption_onboarding_seen_v22';

    // 剧集/系列标识提取与标题清洗
    function cleanTitle(raw) {
        if (!raw) return '未知剧集';
        return raw
            .replace(/-电视剧-全集.*$/, '')
            .replace(/-番剧-全集.*$/, '')
            .replace(/-电影-全集.*$/, '')
            .replace(/-纪录片-全集.*$/, '')
            .replace(/-高清正版在线观看.*$/, '')
            .replace(/_哔哩哔哩_bilibili.*$/, '')
            .replace(/_哔哩哔哩.*$/, '')
            .trim();
    }

    function getSeriesInfo() {
        let id = 'global_default';
        let title = cleanTitle(document.title);
        let epName = '';

        try {
            // 番剧 / 电视剧（如《老友记》）
            const bgmMatch = location.pathname.match(/\/bangumi\/play\/(ss\d+|ep\d+)/);
            if (bgmMatch) {
                if (window.__INITIAL_STATE__?.mediaInfo?.season_id) {
                    id = 'season_' + window.__INITIAL_STATE__.mediaInfo.season_id;
                    title = cleanTitle(window.__INITIAL_STATE__.mediaInfo.title || title);
                } else {
                    id = 'bgm_' + bgmMatch[1];
                }
                epName = window.__INITIAL_STATE__?.epInfo?.title || window.__INITIAL_STATE__?.epInfo?.long_title || '';
            } else {
                // 普通视频多 P / 合集
                const bvMatch = location.pathname.match(/\/(BV[a-zA-Z0-9]+)/);
                if (bvMatch) {
                    id = 'bv_' + bvMatch[1];
                }
                const curP = document.querySelector('.cur-page, .ep-item.cursor');
                if (curP) epName = curP.textContent.trim();
            }
        } catch (e) {}

        return { id, title, epName };
    }

    // =========================================================================
    // 1. IndexedDB 存储引擎（容量数 GB，告别 5MB 限制与爆仓崩溃）
    // =========================================================================
    const DB_NAME = 'BiliCaptionStudyDB';
    const DB_VERSION = 1;
    const DB_STORE = 'notes';

    let dbInstance = null;
    let currentSeriesNotesCache = [];

    function openDatabase() {
        return new Promise((resolve) => {
            if (dbInstance) return resolve(dbInstance);
            try {
                const req = indexedDB.open(DB_NAME, DB_VERSION);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(DB_STORE)) {
                        const store = db.createObjectStore(DB_STORE, { keyPath: 'id' });
                        store.createIndex('by_series', 'seriesId', { unique: false });
                        store.createIndex('by_created', 'createdAt', { unique: false });
                    }
                };
                req.onsuccess = (e) => {
                    dbInstance = e.target.result;
                    resolve(dbInstance);
                };
                req.onerror = (e) => {
                    console.warn('[字幕遮罩] IndexedDB 打开失败，降级回退', e);
                    resolve(null);
                };
            } catch (err) {
                console.warn('[字幕遮罩] IndexedDB 无法使用', err);
                resolve(null);
            }
        });
    }

    async function dbGetNotes(seriesId) {
        const db = await openDatabase();
        if (!db) return currentSeriesNotesCache;

        return new Promise((resolve) => {
            try {
                const tx = db.transaction(DB_STORE, 'readonly');
                const store = tx.objectStore(DB_STORE);
                const index = store.index('by_series');
                const req = index.getAll(seriesId);
                req.onsuccess = () => {
                    const notes = (req.result || []).sort((a, b) => b.createdAt - a.createdAt);
                    resolve(notes);
                };
                req.onerror = () => resolve([]);
            } catch (e) {
                resolve([]);
            }
        });
    }

    async function dbSaveNote(note) {
        currentSeriesNotesCache.unshift(note);
        updateDrawerBadge();

        const db = await openDatabase();
        if (!db) return;
        try {
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            store.put(note);
        } catch (e) {
            console.warn('[字幕遮罩] 保存到 IndexedDB 失败', e);
        }
    }

    async function dbDeleteNote(noteId) {
        currentSeriesNotesCache = currentSeriesNotesCache.filter(n => n.id !== noteId);
        updateDrawerBadge();
        renderDrawerList();

        const db = await openDatabase();
        if (!db) return;
        try {
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            store.delete(noteId);
        } catch (e) {}
    }

    async function dbUpdateNoteText(noteId, text) {
        const item = currentSeriesNotesCache.find(n => n.id === noteId);
        if (item) item.userNote = text;

        const db = await openDatabase();
        if (!db) return;
        try {
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            const req = store.get(noteId);
            req.onsuccess = () => {
                const data = req.result;
                if (data) {
                    data.userNote = text;
                    store.put(data);
                }
            };
        } catch (e) {}
    }

    async function dbClearSeriesNotes(seriesId) {
        currentSeriesNotesCache = [];
        updateDrawerBadge();
        renderDrawerList();

        const db = await openDatabase();
        if (!db) return;
        try {
            const tx = db.transaction(DB_STORE, 'readwrite');
            const store = tx.objectStore(DB_STORE);
            const index = store.index('by_series');
            const req = index.getAllKeys(seriesId);
            req.onsuccess = () => {
                const keys = req.result || [];
                keys.forEach(k => store.delete(k));
            };
        } catch (e) {}
    }

    // 历史数据无感自动迁移至 IndexedDB
    async function migrateOldStorage() {
        try {
            let oldNotes = null;
            if (typeof GM_getValue === 'function') oldNotes = GM_getValue(OLD_NOTES_STORAGE_KEY, null);
            if (!oldNotes) oldNotes = localStorage.getItem(OLD_NOTES_STORAGE_KEY);

            if (oldNotes) {
                const map = typeof oldNotes === 'string' ? JSON.parse(oldNotes) : oldNotes;
                const db = await openDatabase();
                if (db) {
                    const tx = db.transaction(DB_STORE, 'readwrite');
                    const store = tx.objectStore(DB_STORE);
                    for (const sId in map) {
                        if (Array.isArray(map[sId])) {
                            map[sId].forEach(note => {
                                delete note.englishText; // 清理旧乱码
                                note.seriesTitle = cleanTitle(note.seriesTitle);
                                store.put(note);
                            });
                        }
                    }
                }
                // 清理旧 localStorage 释放 5MB 宝贵空间
                localStorage.removeItem(OLD_NOTES_STORAGE_KEY);
                console.log('[字幕遮罩] 历史卡片已安全自动平移至 IndexedDB 存储！');
            }
        } catch (e) {}
    }

    // 载入当前剧集笔记并刷新缓存
    async function refreshCurrentSeriesNotes() {
        const sid = getSeriesInfo().id;
        currentSeriesNotesCache = await dbGetNotes(sid);
        updateDrawerBadge();
        renderDrawerList();
    }

    // =========================================================================
    // 2. 遮罩配置存储
    // =========================================================================
    let storeState = {
        global: { ...DEFAULT_GLOBAL },
        series: {}
    };

    function loadConfigStore() {
        try {
            let saved = null;
            if (typeof GM_getValue === 'function') saved = GM_getValue(CONFIG_STORAGE_KEY, null);
            if (!saved) saved = localStorage.getItem(CONFIG_STORAGE_KEY);
            if (saved) {
                const parsed = typeof saved === 'string' ? JSON.parse(saved) : saved;
                storeState = Object.assign({ global: { ...DEFAULT_GLOBAL }, series: {} }, parsed);
            }
        } catch (e) {}
    }

    function saveConfigStore() {
        const str = JSON.stringify(storeState);
        try { if (typeof GM_setValue === 'function') GM_setValue(CONFIG_STORAGE_KEY, str); } catch (e) {}
        try { localStorage.setItem(CONFIG_STORAGE_KEY, str); } catch (e) {}
    }

    loadConfigStore();

    let currentSeriesKey = getSeriesInfo().id;
    let config = Object.assign({}, storeState.global, storeState.series[currentSeriesKey] || {});

    function syncSeriesConfig() {
        const newKey = getSeriesInfo().id;
        if (newKey !== currentSeriesKey) {
            currentSeriesKey = newKey;
            config = Object.assign({}, storeState.global, storeState.series[currentSeriesKey] || {});
            refreshCurrentSeriesNotes();
        }
    }

    function saveActiveConfig() {
        currentSeriesKey = getSeriesInfo().id;
        storeState.series[currentSeriesKey] = {
            left: config.left,
            top: config.top,
            width: config.width,
            height: config.height
        };
        storeState.global.enabled = config.enabled;
        saveConfigStore();
    }

    let isEditMode = false;
    let isAltPeeking = false;
    let isWheeling = false;
    let wheelTimer = null;
    let isDrawerOpen = false;

    // 全局样式注入
    function injectStyles() {
        if (document.getElementById('bili-caption-mask-styles')) return;
        const styleEl = document.createElement('style');
        styleEl.id = 'bili-caption-mask-styles';
        styleEl.textContent = `
            /* 遮罩主体：无边框羽化光学模糊 */
            .bili-caption-blur-mask {
                position: absolute !important;
                z-index: 99 !important;
                box-sizing: border-box !important;
                background: transparent !important;
                backdrop-filter: blur(14px) !important;
                -webkit-backdrop-filter: blur(14px) !important;
                cursor: pointer !important;
                user-select: none !important;
                pointer-events: auto !important;

                /* 四周渐变羽化 */
                -webkit-mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%),
                                    linear-gradient(to bottom, transparent 0%, black 16%, black 84%, transparent 100%) !important;
                -webkit-mask-composite: source-in !important;
                mask-image: linear-gradient(to right, transparent 0%, black 5%, black 95%, transparent 100%),
                            linear-gradient(to bottom, transparent 0%, black 16%, black 84%, transparent 100%) !important;
                mask-composite: intersect !important;

                transition: backdrop-filter 0.12s ease, -webkit-backdrop-filter 0.12s ease !important;
            }

            /* 鼠标悬停 或 偷瞄透出 */
            .bili-caption-blur-mask:not(.in-edit-mode):not(.wheeling-active):hover,
            .bili-caption-blur-mask.peek-active:not(.wheeling-active) {
                backdrop-filter: blur(0px) !important;
                -webkit-backdrop-filter: blur(0px) !important;
                -webkit-mask-image: none !important;
                mask-image: none !important;
            }

            /* 滚轮微调高亮指示框 */
            .bili-caption-blur-mask.wheeling-active {
                -webkit-mask-image: none !important;
                mask-image: none !important;
                outline: 2px solid #00aeec !important;
                background: rgba(0, 174, 236, 0.22) !important;
                backdrop-filter: blur(6px) !important;
                -webkit-backdrop-filter: blur(6px) !important;
                box-shadow: 0 0 16px rgba(0, 174, 236, 0.6) !important;
            }

            .bili-caption-blur-mask.mask-hidden {
                display: none !important;
            }

            /* 编辑模式外观 */
            .bili-caption-blur-mask.in-edit-mode {
                -webkit-mask-image: none !important;
                mask-image: none !important;
                outline: 2px dashed #00aeec !important;
                background: rgba(0, 174, 236, 0.25) !important;
                backdrop-filter: blur(4px) !important;
                -webkit-backdrop-filter: blur(4px) !important;
                cursor: move !important;
            }

            .bili-caption-mask-header {
                position: absolute;
                top: -34px;
                right: 0;
                display: none;
                align-items: center;
                gap: 8px;
                background: rgba(18, 18, 20, 0.95);
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 4px;
                padding: 3px 10px;
                font-size: 12px;
                color: #fff;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5);
                white-space: nowrap;
                z-index: 105;
                pointer-events: auto;
            }
            .in-edit-mode .bili-caption-mask-header {
                display: flex !important;
            }

            .bili-caption-mask-btn {
                background: #00aeec;
                color: #fff;
                border: none;
                border-radius: 3px;
                padding: 2px 8px;
                font-size: 12px;
                cursor: pointer;
                line-height: 18px;
                transition: background 0.2s;
            }
            .bili-caption-mask-btn:hover {
                background: #009cd3;
            }

            /* 拉伸手柄 */
            .bili-caption-resize-handle {
                position: absolute;
                width: 10px;
                height: 10px;
                background: #00aeec;
                border: 1.5px solid #ffffff;
                border-radius: 2px;
                display: none;
                z-index: 102;
                box-sizing: border-box;
            }
            .in-edit-mode .bili-caption-resize-handle {
                display: block !important;
            }

            .handle-n  { top: -5px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
            .handle-s  { bottom: -5px; left: 50%; transform: translateX(-50%); cursor: ns-resize; }
            .handle-w  { left: -5px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }
            .handle-e  { right: -5px; top: 50%; transform: translateY(-50%); cursor: ew-resize; }
            .handle-nw { top: -5px; left: -5px; cursor: nwse-resize; }
            .handle-ne { top: -5px; right: -5px; cursor: nesw-resize; }
            .handle-sw { bottom: -5px; left: -5px; cursor: nesw-resize; }
            .handle-se { bottom: -5px; right: -5px; cursor: nwse-resize; }

            /* 右上角轻量控制 Dock（支持鼠标静止自动呼吸隐形） */
            .bili-caption-control-dock {
                position: absolute;
                top: 14px;
                right: 14px;
                z-index: 98;
                display: flex;
                align-items: center;
                gap: 6px;
                background: rgba(14, 14, 16, 0.78);
                backdrop-filter: blur(10px);
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 18px;
                padding: 4px 12px;
                font-size: 12px;
                color: #e5e5e5;
                opacity: 0.65;
                transition: opacity 0.4s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s ease;
                cursor: default;
                user-select: none;
                pointer-events: auto;
            }
            /* 呼吸隐形状态：0干扰纯净观影 */
            .bili-caption-control-dock.is-hidden {
                opacity: 0 !important;
                pointer-events: none !important;
            }
            .bili-caption-control-dock:hover {
                opacity: 1 !important;
                transform: scale(1.02);
            }
            .bili-caption-dock-btn {
                background: transparent;
                border: none;
                color: #00aeec;
                cursor: pointer;
                font-size: 12px;
                padding: 1px 4px;
                border-radius: 3px;
                transition: color 0.15s;
            }
            .bili-caption-dock-btn:hover {
                color: #ffffff;
                text-decoration: underline;
            }

            /* 浮动 Toast */
            .bili-caption-toast {
                position: fixed;
                top: 60px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(18, 18, 20, 0.92);
                backdrop-filter: blur(12px);
                color: #ffffff;
                padding: 8px 20px;
                border-radius: 20px;
                font-size: 13px;
                pointer-events: none;
                z-index: 9999999;
                opacity: 0;
                transition: opacity 0.25s ease, transform 0.25s ease;
                box-shadow: 0 4px 18px rgba(0,0,0,0.5);
                border: 1px solid rgba(255, 255, 255, 0.12);
            }
            .bili-caption-toast.show {
                opacity: 1;
                transform: translateX(-50%) translateY(6px);
            }

            /* 新手开箱 4 秒引导小气泡 */
            .bili-caption-onboarding {
                position: absolute;
                top: 36%;
                left: 50%;
                transform: translate(-50%, -50%) scale(0.96);
                background: rgba(18, 19, 23, 0.94);
                backdrop-filter: blur(16px);
                border: 1px solid rgba(0, 174, 236, 0.45);
                border-radius: 12px;
                padding: 16px 22px;
                color: #ffffff;
                box-shadow: 0 10px 36px rgba(0, 0, 0, 0.7);
                z-index: 1000;
                pointer-events: auto;
                cursor: pointer;
                opacity: 0;
                transition: opacity 0.35s ease, transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
                text-align: left;
                width: 320px;
                user-select: none;
            }
            .bili-caption-onboarding.show {
                opacity: 1;
                transform: translate(-50%, -50%) scale(1);
            }
            .onboard-title {
                font-size: 15px;
                font-weight: bold;
                color: #00aeec;
                margin-bottom: 10px;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .onboard-item {
                font-size: 12.5px;
                color: #e2e8f0;
                margin: 6px 0;
                line-height: 1.5;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .onboard-item b {
                color: #38bdf8;
                font-weight: 600;
            }
            .onboard-tip {
                font-size: 11px;
                color: #94a3b8;
                margin-top: 12px;
                text-align: right;
            }

            /* 侧边生词复习抽屉 */
            .bili-caption-drawer {
                position: fixed;
                top: 0;
                right: 0;
                width: 380px;
                height: 100vh;
                background: rgba(22, 23, 26, 0.96);
                backdrop-filter: blur(18px);
                box-shadow: -6px 0 25px rgba(0, 0, 0, 0.6);
                border-left: 1px solid rgba(255, 255, 255, 0.1);
                z-index: 999999;
                display: flex;
                flex-direction: column;
                transform: translateX(100%);
                transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                color: #f1f2f3;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', sans-serif;
            }
            .bili-caption-drawer.open {
                transform: translateX(0);
            }
            .drawer-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 16px 18px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            }
            .drawer-title {
                font-size: 15px;
                font-weight: bold;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .drawer-header-actions {
                display: flex;
                gap: 8px;
                align-items: center;
            }
            .drawer-btn {
                background: #00aeec;
                border: none;
                color: #fff;
                font-size: 12px;
                padding: 4px 10px;
                border-radius: 4px;
                cursor: pointer;
                transition: background 0.2s;
            }
            .drawer-btn:hover { background: #009cd3; }
            .drawer-btn.btn-close {
                background: transparent;
                font-size: 16px;
                color: #999;
                padding: 2px 6px;
            }
            .drawer-btn.btn-close:hover { color: #fff; }

            .drawer-body {
                flex: 1;
                overflow-y: auto;
                padding: 14px 16px;
                display: flex;
                flex-direction: column;
                gap: 14px;
            }
            .drawer-empty {
                text-align: center;
                color: #888;
                font-size: 13px;
                margin-top: 60px;
                line-height: 1.8;
            }

            .note-card {
                background: rgba(36, 38, 43, 0.85);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 8px;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                transition: border-color 0.2s;
            }
            .note-card:hover {
                border-color: rgba(0, 174, 236, 0.4);
            }
            .note-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 8px 12px;
                font-size: 12px;
                color: #bbb;
                background: rgba(0, 0, 0, 0.25);
            }
            .note-time-badge {
                color: #00aeec;
                cursor: pointer;
                font-weight: 500;
                display: flex;
                align-items: center;
                gap: 3px;
                padding: 2px 7px;
                border-radius: 3px;
                background: rgba(0, 174, 236, 0.12);
                transition: background 0.15s;
            }
            .note-time-badge:hover {
                background: rgba(0, 174, 236, 0.28);
                text-decoration: underline;
            }
            .note-del-btn {
                background: transparent;
                border: none;
                color: #777;
                cursor: pointer;
                font-size: 13px;
                padding: 2px 4px;
            }
            .note-del-btn:hover { color: #ff5c5c; }

            .note-img {
                width: 100%;
                display: block;
                border-bottom: 1px solid rgba(255, 255, 255, 0.05);
                cursor: zoom-in;
            }
            .note-text-wrap {
                padding: 8px 12px 10px;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            .note-user-input {
                font-size: 12px;
                color: #d1d5db;
                outline: none;
                padding: 5px 8px;
                border-radius: 4px;
                background: rgba(0, 0, 0, 0.2);
                border: 1px solid transparent;
                transition: all 0.2s;
                min-height: 24px;
            }
            .note-user-input:empty::before {
                content: attr(data-placeholder);
                color: #6b7280;
            }
            .note-user-input:focus {
                background: rgba(0, 0, 0, 0.4);
                border-color: #00aeec;
            }
        `;
        (document.head || document.documentElement).appendChild(styleEl);
    }

    let toastTimer = null;
    function showToast(text) {
        let toast = document.querySelector('.bili-caption-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.className = 'bili-caption-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = text;
        toast.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.classList.remove('show');
        }, 1600);
    }

    function getDrawableVideoElement() {
        const video = document.querySelector('video');
        if (video && video.videoWidth > 0) return video;

        const canvas = document.querySelector('.bpx-player-video-wrap canvas, .bilibili-player-video-wrap canvas');
        if (canvas && canvas.width > 0) return canvas;

        return video || document.querySelector('bwp-video');
    }

    function findVideoWrap() {
        const selectors = [
            '.bpx-player-video-wrap',
            '.bpx-player-video-area',
            '.squirtle-video-wrap',
            '.bilibili-player-video-wrap',
            '.bilibili-player-video',
            '#bilibili-player .bpx-player-video-wrap',
            '#playerWrap',
            '#player_module',
            '#bilibiliPlayer',
            '#bofqi'
        ];

        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.clientWidth > 0 && el.clientHeight > 0) {
                return el;
            }
        }

        const media = document.querySelector('video, bwp-video');
        if (media) {
            for (const sel of selectors) {
                const wrap = media.closest(sel);
                if (wrap) return wrap;
            }
            return media.parentElement;
        }

        return null;
    }

    function captureCurrentVideoFrame(mediaEl) {
        if (!mediaEl) return null;
        try {
            const canvas = document.createElement('canvas');
            const w = mediaEl.videoWidth || mediaEl.width || mediaEl.clientWidth || 1280;
            const h = mediaEl.videoHeight || mediaEl.height || mediaEl.clientHeight || 720;

            const scale = Math.min(1, 960 / w);
            canvas.width = Math.round(w * scale);
            canvas.height = Math.round(h * scale);

            const ctx = canvas.getContext('2d');
            ctx.drawImage(mediaEl, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', 0.85);
        } catch (e) {
            console.warn('[字幕遮罩] 画面截取失败', e);
            return null;
        }
    }

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '00:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
    }

    // 执行一键快照采集
    async function triggerSnapshotCapture() {
        const media = getDrawableVideoElement();
        if (!media) {
            showToast('⚠️ 未找到当前正在播放的画面');
            return;
        }

        const info = getSeriesInfo();
        const currentTime = media.currentTime || 0;
        const timeStr = formatTime(currentTime);

        const snapshotUrl = captureCurrentVideoFrame(media);
        if (!snapshotUrl) {
            showToast('⚠️ 截取画面失败');
            return;
        }

        const noteId = 'note_' + Date.now();
        const newNote = {
            id: noteId,
            seriesId: info.id,
            seriesTitle: info.title,
            epTitle: info.epName,
            time: currentTime,
            timeStr: timeStr,
            imageUrl: snapshotUrl,
            userNote: '',
            createdAt: Date.now()
        };

        await dbSaveNote(newNote);
        renderDrawerList();
        showToast(`⭐️ 剧照已收藏 [${timeStr}]！按 Alt+B 可在生词本查看`);
    }

    // 创建遮罩 DOM
    function createMaskElement() {
        const mask = document.createElement('div');
        mask.className = 'bili-caption-blur-mask';

        const header = document.createElement('div');
        header.className = 'bili-caption-mask-header';
        header.innerHTML = `
            <span>✏️ 调节中 (Alt+滚轮可微调)</span>
            <button class="bili-caption-mask-btn btn-lock" title="完成并锁定">完成锁定</button>
            <button class="bili-caption-mask-btn btn-reset" title="恢复默认位置">重置</button>
        `;
        mask.appendChild(header);

        const handles = ['n', 's', 'w', 'e', 'nw', 'ne', 'sw', 'se'];
        handles.forEach(pos => {
            const h = document.createElement('div');
            h.className = `bili-caption-resize-handle handle-${pos}`;
            h.dataset.handle = pos;
            mask.appendChild(h);
        });

        return mask;
    }

    // 创建右上角轻量控制徽标
    function createDockElement() {
        const dock = document.createElement('div');
        dock.className = 'bili-caption-control-dock';
        const notesCount = currentSeriesNotesCache.length;
        dock.innerHTML = `
            <span>🔲 遮罩</span>
            <button class="bili-caption-dock-btn btn-dock-toggle" title="开关遮罩 (快捷键 Alt+C)">${config.enabled ? '已开启' : '已关闭'}</button>
            <span>|</span>
            <button class="bili-caption-dock-btn btn-dock-edit" title="手动拉伸微调 (快捷键 Alt+Z)">${isEditMode ? '锁定' : '调节'}</button>
            <span>|</span>
            <button class="bili-caption-dock-btn btn-dock-snap" title="一键截取收藏当前画面 (快捷键 Alt+S 或 S)">📸 收藏此句</button>
            <span>|</span>
            <button class="bili-caption-dock-btn btn-dock-notes" title="打开生词与台词复习本 (快捷键 Alt+B)">📚 生词本 (${notesCount})</button>
        `;
        return dock;
    }

    function updateDrawerBadge() {
        const btn = document.querySelector('.btn-dock-notes');
        if (btn) {
            btn.textContent = `📚 生词本 (${currentSeriesNotesCache.length})`;
        }
    }

    // 绑定右上角 Dock 的 2.5 秒呼吸自动隐藏
    let dockHideTimer = null;
    function setupDockAutoHide(container, dock) {
        if (!container || !dock) return;

        function wakeDock() {
            dock.classList.remove('is-hidden');
            clearTimeout(dockHideTimer);
            // 鼠标悬停在 dock 本身时不隐藏，离开后 2.5 秒隐藏
            dockHideTimer = setTimeout(() => {
                if (!dock.matches(':hover') && !isEditMode && !isDrawerOpen) {
                    dock.classList.add('is-hidden');
                }
            }, 2500);
        }

        container.addEventListener('mousemove', wakeDock);
        container.addEventListener('mouseenter', wakeDock);
        container.addEventListener('mouseleave', () => {
            clearTimeout(dockHideTimer);
            dockHideTimer = setTimeout(() => {
                if (!isEditMode && !isDrawerOpen) {
                    dock.classList.add('is-hidden');
                }
            }, 800);
        });

        // 初始 3 秒后自动淡出
        wakeDock();
    }

    // 新手开箱引导气泡（仅首次打开展示 4.5 秒，自动淡出）
    function checkAndShowOnboarding(container) {
        if (!container) return;
        try {
            const seen = localStorage.getItem(ONBOARDING_SEEN_KEY);
            if (seen) return;

            const bubble = document.createElement('div');
            bubble.className = 'bili-caption-onboarding';
            bubble.innerHTML = `
                <div class="onboard-title">✨ 看剧学英语遮罩已就绪！</div>
                <div class="onboard-item"><span>👀</span><span><b>鼠标移入</b> 或长按 <b>Alt</b> 瞬时偷瞄中文</span></div>
                <div class="onboard-item"><span>↕️</span><span>按住 <b>Alt + 滚轮</b> 盲调高低（不碰音量）</span></div>
                <div class="onboard-item"><span>📸</span><span>按 <b>Alt + S</b> 随时一键收藏原画剧照</span></div>
                <div class="onboard-tip">点击任意处关闭 (4秒后自动淡出)</div>
            `;

            container.appendChild(bubble);

            requestAnimationFrame(() => {
                bubble.classList.add('show');
            });

            function closeBubble() {
                bubble.classList.remove('show');
                setTimeout(() => bubble.remove(), 400);
                try { localStorage.setItem(ONBOARDING_SEEN_KEY, '1'); } catch (e) {}
            }

            bubble.addEventListener('click', closeBubble);
            setTimeout(closeBubble, 4500);
        } catch (e) {}
    }

    // 应用遮罩样式
    function applyStyles(mask) {
        if (!mask) return;
        mask.style.left = `${config.left}%`;
        mask.style.top = `${config.top}%`;
        mask.style.width = `${config.width}%`;
        mask.style.height = `${config.height}%`;

        if (!config.enabled) {
            mask.classList.add('mask-hidden');
        } else {
            mask.classList.remove('mask-hidden');
        }

        if (isEditMode) {
            mask.classList.add('in-edit-mode');
        } else {
            mask.classList.remove('in-edit-mode');
        }

        if (isAltPeeking) {
            mask.classList.add('peek-active');
        } else {
            mask.classList.remove('peek-active');
        }

        if (isWheeling) {
            mask.classList.add('wheeling-active');
        } else {
            mask.classList.remove('wheeling-active');
        }

        const dockToggleBtn = document.querySelector('.btn-dock-toggle');
        if (dockToggleBtn) {
            dockToggleBtn.textContent = config.enabled ? '已开启' : '已关闭';
            dockToggleBtn.style.color = config.enabled ? '#00aeec' : '#aaa';
        }
        const dockEditBtn = document.querySelector('.btn-dock-edit');
        if (dockEditBtn) {
            dockEditBtn.textContent = isEditMode ? '完成锁定' : '调节';
        }
    }

    // 绑定拖拽与拉伸
    function setupDragAndResize(mask, getContainer) {
        let isDragging = false;
        let activeHandle = null;
        let startX = 0;
        let startY = 0;
        let initialConfig = null;

        mask.addEventListener('click', (e) => {
            if (e.target.classList.contains('btn-lock')) {
                e.stopPropagation();
                toggleEditMode(false, getContainer());
            } else if (e.target.classList.contains('btn-reset')) {
                e.stopPropagation();
                Object.assign(config, PRESET_BOTTOM);
                saveActiveConfig();
                applyStyles(mask);
                showToast('已重置为底部默认位置');
            } else if (!isEditMode) {
                const video = document.querySelector('video, bwp-video');
                if (video) {
                    if (video.paused) video.play();
                    else video.pause();
                }
            }
        });

        mask.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            toggleEditMode(!isEditMode, getContainer());
        });

        mask.addEventListener('mousedown', (e) => {
            if (!isEditMode) return;
            if (e.target.closest('.bili-caption-mask-header')) return;

            e.preventDefault();
            e.stopPropagation();

            const container = getContainer();
            if (!container) return;

            const targetHandle = e.target.dataset.handle;
            if (targetHandle) activeHandle = targetHandle;
            else isDragging = true;

            startX = e.clientX;
            startY = e.clientY;
            initialConfig = { ...config };

            function onMouseMove(moveEvent) {
                const rect = container.getBoundingClientRect();
                if (!rect.width || !rect.height) return;

                const deltaXPercent = ((moveEvent.clientX - startX) / rect.width) * 100;
                const deltaYPercent = ((moveEvent.clientY - startY) / rect.height) * 100;

                if (isDragging) {
                    let nextLeft = initialConfig.left + deltaXPercent;
                    let nextTop = initialConfig.top + deltaYPercent;

                    nextLeft = Math.max(0, Math.min(100 - initialConfig.width, nextLeft));
                    nextTop = Math.max(0, Math.min(100 - initialConfig.height, nextTop));

                    config.left = parseFloat(nextLeft.toFixed(2));
                    config.top = parseFloat(nextTop.toFixed(2));
                } else if (activeHandle) {
                    let { left, top, width, height } = initialConfig;

                    if (activeHandle.includes('n')) {
                        const newTop = Math.min(top + height - 2, Math.max(0, top + deltaYPercent));
                        height = (top + height) - newTop;
                        top = newTop;
                    }
                    if (activeHandle.includes('s')) {
                        height = Math.max(2, Math.min(100 - top, height + deltaYPercent));
                    }
                    if (activeHandle.includes('w')) {
                        const newLeft = Math.min(left + width - 5, Math.max(0, left + deltaXPercent));
                        width = (left + width) - newLeft;
                        left = newLeft;
                    }
                    if (activeHandle.includes('e')) {
                        width = Math.max(5, Math.min(100 - left, width + deltaXPercent));
                    }

                    config.left = parseFloat(left.toFixed(2));
                    config.top = parseFloat(top.toFixed(2));
                    config.width = parseFloat(width.toFixed(2));
                    config.height = parseFloat(height.toFixed(2));
                }

                applyStyles(mask);
            }

            function onMouseUp() {
                isDragging = false;
                activeHandle = null;
                saveActiveConfig();
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
            }

            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    }

    // 切换编辑/锁定模式
    function toggleEditMode(forceState, container) {
        if (typeof forceState === 'boolean') isEditMode = forceState;
        else isEditMode = !isEditMode;

        const mask = (container || document).querySelector('.bili-caption-blur-mask');
        if (mask) applyStyles(mask);

        if (isEditMode) {
            showToast('✏️ 已进入调节模式（拖拽遮罩或边缘手柄，双击锁定）');
        } else {
            saveActiveConfig();
            showToast('🔒 已锁定（观影模式：悬停或按住 Alt 偷瞄中文）');
        }
    }

    function toggleMaskEnabled(container) {
        config.enabled = !config.enabled;
        saveActiveConfig();

        const mask = (container || document).querySelector('.bili-caption-blur-mask');
        if (mask) applyStyles(mask);

        showToast(config.enabled ? '👁️ 中文字幕遮罩：已开启' : '🙈 中文字幕遮罩：已隐藏');
    }

    // 创建生词抽屉 DOM
    function createDrawerElement() {
        const drawer = document.createElement('div');
        drawer.className = 'bili-caption-drawer';
        drawer.innerHTML = `
            <div class="drawer-header">
                <div class="drawer-title">
                    <span>📚 剧照与复习本</span>
                    <span style="font-size: 11px; font-weight: normal; color: #00aeec; background: rgba(0,174,236,0.15); padding: 1px 6px; border-radius: 10px;">v2.2 极速版</span>
                </div>
                <div class="drawer-header-actions">
                    <button class="drawer-btn btn-clear-all" style="background: rgba(255,255,255,0.1); color: #ccc;" title="清空本剧所有历史卡片">清空全部</button>
                    <button class="drawer-btn btn-export-md" title="将当前剧集的笔记导出为 Markdown 文件">导出 Markdown</button>
                    <button class="drawer-btn btn-close" title="关闭 (Esc / Alt+B)">✕</button>
                </div>
            </div>
            <div class="drawer-body"></div>
        `;

        drawer.querySelector('.btn-close').addEventListener('click', () => toggleDrawer(false));
        drawer.querySelector('.btn-export-md').addEventListener('click', exportNotesToMarkdown);
        drawer.querySelector('.btn-clear-all').addEventListener('click', () => {
            if (confirm('确定要清空本剧的所有收藏卡片吗？')) {
                const sid = getSeriesInfo().id;
                dbClearSeriesNotes(sid);
                showToast('🗑️ 已清空本剧历史卡片');
            }
        });

        return drawer;
    }

    function toggleDrawer(forceState) {
        if (typeof forceState === 'boolean') isDrawerOpen = forceState;
        else isDrawerOpen = !isDrawerOpen;

        const drawer = document.querySelector('.bili-caption-drawer');
        if (!drawer) return;

        if (isDrawerOpen) {
            refreshCurrentSeriesNotes();
            drawer.classList.add('open');
        } else {
            drawer.classList.remove('open');
        }
    }

    function renderDrawerList() {
        const drawer = document.querySelector('.bili-caption-drawer');
        if (!drawer) return;
        const body = drawer.querySelector('.drawer-body');
        const notes = currentSeriesNotesCache;

        if (notes.length === 0) {
            body.innerHTML = `
                <div class="drawer-empty">
                    <div style="font-size: 32px; margin-bottom: 8px;">🎬</div>
                    <div>当前剧集暂无收藏卡片</div>
                    <div style="font-size: 12px; color: #666; margin-top: 6px;">看剧时按【Alt + S】或单按【S】<br>即可把当前高清剧照和时间戳秒级保存到这里</div>
                </div>
            `;
            return;
        }

        body.innerHTML = '';
        notes.forEach(note => {
            const card = document.createElement('div');
            card.className = 'note-card';
            card.dataset.id = note.id;

            const headerLabel = note.epTitle || note.seriesTitle || '精彩片段';

            card.innerHTML = `
                <div class="note-header">
                    <span style="font-weight: 500;">${headerLabel}</span>
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span class="note-time-badge" title="点击秒跳回原视频这一帧播放">⏱️ ${note.timeStr}</span>
                        <button class="note-del-btn" title="删除卡片">✕</button>
                    </div>
                </div>
                ${note.imageUrl ? `<img class="note-img" src="${note.imageUrl}" title="点击在新标签查看大图" />` : ''}
                <div class="note-text-wrap">
                    <div class="note-user-input" contenteditable="true" data-placeholder="💡 点击输入生词或笔记 (可选)...">${note.userNote || ''}</div>
                </div>
            `;

            card.querySelector('.note-time-badge').addEventListener('click', () => {
                const video = document.querySelector('video, bwp-video');
                if (video) {
                    video.currentTime = note.time;
                    video.play();
                    showToast(`⏱️ 已跳转至 [${note.timeStr}]`);
                }
            });

            const img = card.querySelector('.note-img');
            if (img) {
                img.addEventListener('click', () => {
                    const w = window.open('');
                    w.document.write(`<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh;"><img src="${note.imageUrl}" style="max-width:100%;max-height:100%;" /></body>`);
                });
            }

            const noteInput = card.querySelector('.note-user-input');
            noteInput.addEventListener('blur', () => {
                dbUpdateNoteText(note.id, noteInput.textContent.trim());
            });

            card.querySelector('.note-del-btn').addEventListener('click', () => {
                dbDeleteNote(note.id);
            });

            body.appendChild(card);
        });
    }

    function exportNotesToMarkdown() {
        const info = getSeriesInfo();
        const notes = currentSeriesNotesCache;
        if (notes.length === 0) {
            showToast('⚠️ 当前剧集还没有卡片可导出');
            return;
        }

        let md = `# ${info.title} - 看剧学英语笔记\n\n`;
        md += `> 自动生成于 ${new Date().toLocaleDateString()} | 共收录 ${notes.length} 张场景卡片\n\n---\n\n`;

        notes.forEach((n, idx) => {
            md += `### ${idx + 1}. [${n.timeStr}] ${n.epTitle || ''}\n\n`;
            if (n.userNote) {
                md += `> **生词笔记**：${n.userNote}\n\n`;
            }
            if (n.imageUrl) {
                md += `![场景剧照](${n.imageUrl})\n\n`;
            }
            md += `---\n\n`;
        });

        const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${info.title}_学习笔记_${Date.now()}.md`;
        a.click();
        showToast('📄 Markdown 笔记已下载！');
    }

    // 核心交互与按键拦截
    function setupInteractions(getContainer) {
        function isInputActive(e) {
            const tag = (e.target && e.target.tagName) ? e.target.tagName.toUpperCase() : '';
            return tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
        }

        // 捕获阶段拦截 Alt+滚轮，彻底防止触发 B 站音量调节
        window.addEventListener('wheel', (e) => {
            if (e.altKey && config.enabled && !isEditMode) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();

                const container = getContainer();
                if (!container) return;

                const step = 0.5;
                const delta = e.deltaY > 0 ? step : -step;
                let nextTop = config.top + delta;
                nextTop = Math.max(0, Math.min(100 - config.height, nextTop));
                config.top = parseFloat(nextTop.toFixed(2));

                saveActiveConfig();

                isWheeling = true;
                const mask = container.querySelector('.bili-caption-blur-mask');
                if (mask) applyStyles(mask);

                clearTimeout(wheelTimer);
                wheelTimer = setTimeout(() => {
                    isWheeling = false;
                    if (mask) applyStyles(mask);
                }, 600);

                showToast(`↕️ 字幕高度微调: ${config.top}% (松开 Alt 保存)`);
            }
        }, { passive: false, capture: true });

        // 键盘按键监听
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isDrawerOpen) {
                toggleDrawer(false);
                return;
            }

            if (isInputActive(e)) return;

            const container = getContainer();

            // 长按 Alt 偷瞄
            if (e.key === 'Alt' && !isAltPeeking) {
                isAltPeeking = true;
                const mask = (container || document).querySelector('.bili-caption-blur-mask');
                if (mask) applyStyles(mask);
            }

            // Alt + S 或单按 S：一键智能快照
            if ((e.altKey && (e.code === 'KeyS' || e.key === 's' || e.key === 'S')) ||
                (!e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyS' || e.key === 's' || e.key === 'S'))) {
                e.preventDefault();
                triggerSnapshotCapture();
            }

            // Alt + B 或单按 B：打开/关闭生词抽屉
            if ((e.altKey && (e.code === 'KeyB' || e.key === 'b' || e.key === 'B')) ||
                (!e.altKey && !e.ctrlKey && !e.metaKey && (e.code === 'KeyB' || e.key === 'b' || e.key === 'B'))) {
                e.preventDefault();
                toggleDrawer();
            }

            // Alt + C 或 Shift + C：开关遮罩
            if ((e.altKey || e.shiftKey) && (e.code === 'KeyC' || e.key === 'c' || e.key === 'C')) {
                e.preventDefault();
                toggleMaskEnabled(container);
            }

            // Alt + Z 或 Shift + Z：切换编辑模式
            if ((e.altKey || e.shiftKey) && (e.code === 'KeyZ' || e.key === 'z' || e.key === 'Z')) {
                e.preventDefault();
                toggleEditMode(undefined, container);
            }
        });

        window.addEventListener('keyup', (e) => {
            if (e.key === 'Alt' && isAltPeeking) {
                isAltPeeking = false;
                const container = getContainer();
                const mask = (container || document).querySelector('.bili-caption-blur-mask');
                if (mask) applyStyles(mask);
            }
        });

        window.addEventListener('blur', () => {
            if (isAltPeeking) {
                isAltPeeking = false;
                const container = getContainer();
                const mask = (container || document).querySelector('.bili-caption-blur-mask');
                if (mask) applyStyles(mask);
            }
        });
    }

    // 主初始化与挂载轮询
    function start() {
        injectStyles();

        // 异步迁移旧数据
        migrateOldStorage().then(() => {
            refreshCurrentSeriesNotes();
        });

        let drawer = document.querySelector('.bili-caption-drawer');
        if (!drawer) {
            drawer = createDrawerElement();
            document.body.appendChild(drawer);
        }

        let currentContainer = null;
        let currentMask = null;

        function getContainer() {
            return currentContainer || findVideoWrap();
        }

        function mount() {
            syncSeriesConfig();

            const container = findVideoWrap();
            if (!container) return;

            const compPos = window.getComputedStyle(container).position;
            if (compPos === 'static') {
                container.style.position = 'relative';
            }

            if (container !== currentContainer || !container.querySelector('.bili-caption-blur-mask')) {
                currentContainer = container;

                const oldMask = container.querySelector('.bili-caption-blur-mask');
                if (oldMask) oldMask.remove();
                const oldDock = container.querySelector('.bili-caption-control-dock');
                if (oldDock) oldDock.remove();

                // 挂载羽化遮罩
                currentMask = createMaskElement();
                applyStyles(currentMask);
                setupDragAndResize(currentMask, getContainer);
                container.appendChild(currentMask);

                // 挂载右上角控制栏（带呼吸自动隐形）
                const dock = createDockElement();
                dock.querySelector('.btn-dock-toggle').addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleMaskEnabled(getContainer());
                });
                dock.querySelector('.btn-dock-edit').addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleEditMode(undefined, getContainer());
                });
                dock.querySelector('.btn-dock-snap').addEventListener('click', (e) => {
                    e.stopPropagation();
                    triggerSnapshotCapture();
                });
                dock.querySelector('.btn-dock-notes').addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleDrawer();
                });

                container.appendChild(dock);
                setupDockAutoHide(container, dock);

                // 检查并展示新手 4 秒开箱引导气泡
                checkAndShowOnboarding(container);

                console.log('%c[看剧学英语] 遮罩、呼吸Dock与抽屉已就绪！', 'color: #00aeec; font-weight: bold;');
            }
        }

        setupInteractions(getContainer);

        mount();

        const observer = new MutationObserver(() => {
            mount();
        });

        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                observer.observe(document.body, { childList: true, subtree: true });
            });
        }

        setInterval(mount, 1000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
