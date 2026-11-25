import { isDue, orderSession, schedule } from './schedule.js';
import { getDeepActiveElement, isEditableEvent } from './editable.js';
import { DEFAULT_SHORTCUTS, formatShortcut, matchesShortcut, normalizeShortcutsMap } from './shortcuts.js';

const PAGE_SIZE = 30;
const SAVE_DELAY = 550;
const SESSION_KEY = 'bili_caption_review_session';
/** A cross-video navigation reopens the sitting only if the next page loads within this window. */
const RESUME_WINDOW = 2 * 60 * 1000;
const RATING_CHOICES = [['again', '没听懂'], ['hard', '费劲'], ['good', '听懂了']];
const REVIEW_STATES = [['new', '待复习'], ['learning', '学习中'], ['mastered', '已掌握']];

function validSession(value) {
    return Boolean(value) && Array.isArray(value.queue) && value.queue.length <= 10000 && value.queue.every(id => typeof id === 'string') &&
        Number.isInteger(value.index) && value.index >= 0 && value.index <= value.queue.length &&
        ['again', 'hard', 'good'].every(key => Number.isInteger(value[key]) && value[key] >= 0) &&
        (value.pending === null || value.pending === 'listen' || value.pending === 'loop');
}

function readSession(store) {
    try {
        const value = JSON.parse(store?.getItem(SESSION_KEY) || 'null');
        return validSession(value) ? value : null;
    } catch { return null; }
}

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
}

function button(text, handler, className = '') {
    const element = node('button', `bcm-button ${className}`.trim(), text);
    element.type = 'button';
    if (handler) element.addEventListener('click', handler);
    return element;
}

function field(labelText, control, className = '') {
    const label = node('label', `bcm-field ${className}`.trim());
    label.append(node('span', 'bcm-label', labelText), control);
    return label;
}

function select(options, label) {
    const element = node('select', 'bcm-select');
    element.setAttribute('aria-label', label);
    for (const [value, text] of options) {
        const option = node('option', '', text);
        option.value = value;
        element.append(option);
    }
    return element;
}

function readableError(error) {
    return error instanceof Error ? error.message : String(error || '请稍后重试');
}

function timeLabel(seconds) {
    const time = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(time / 60).toString().padStart(2, '0')}:${(time % 60).toString().padStart(2, '0')}`;
}

function fileNameDate() {
    return new Date().toISOString().slice(0, 10);
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = node('a');
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function blobDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('无法读取截图'));
        reader.readAsDataURL(blob);
    });
}

/** Non-modal notebook. The caller owns attachment and fullscreen placement. */
export function createNotebook({ repo, player, notify = () => {}, version = '2.5.0', onChange = () => {}, onLoop, onHelp, onSettings, getLeadIn = () => 3, getBatchSize = () => 20, getShortcuts = () => DEFAULT_SHORTCUTS, sessionStorage = null, now = Date.now }) {
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
    let session = readSession(sessionStorage);
    let dueCount = 0;
    let sessionGeneration = 0;
    let sessionBusy = false;
    let playBusy = false;
    let revealed = false;
    let currentNote = null;
    let revealTarget = null;
    const drafts = new Map();
    const controls = new Map();
    const imageUrls = new Set();
    const element = node('aside', 'bcm-notebook');
    element.setAttribute('aria-label', '场景收藏与复习本');
    element.hidden = true;
    element.inert = true;

    const header = node('header', 'bcm-notebook-header');
    const heading = node('div', 'bcm-heading-row');
    const title = node('h2', 'bcm-notebook-title', '场景复习本');
    const versionLabel = node('span', 'bcm-version', `v${version}`);
    const closeButton = button('关闭', () => close(), 'bcm-button-quiet');
    closeButton.setAttribute('aria-label', '关闭复习本');
    heading.append(title, versionLabel, closeButton);
    const subtitle = node('p', 'bcm-subtitle', '回到原场景，再听懂一点。');
    const headerActions = node('div', 'bcm-toolbar');
    if (onHelp) headerActions.append(button('操作帮助', () => onHelp()));
    if (onSettings) headerActions.append(button('设置', () => onSettings()));
    const backupButton = button('备份全部', () => backup());
    const importButton = button('导入备份', () => fileInput.click());
    const readingButton = button('导出阅读版', () => exportReading());
    readingButton.title = '将当前筛选的收藏导出为可离线打开的 HTML 文件';
    headerActions.append(backupButton, importButton, readingButton);
    header.append(heading, subtitle, headerActions);

    const scroll = node('div', 'bcm-notebook-scroll');
    const filters = node('section', 'bcm-filters');
    filters.setAttribute('aria-label', '筛选收藏');
    const searchInput = node('input', 'bcm-input');
    searchInput.type = 'search';
    searchInput.placeholder = '搜索笔记、标签或标题';
    searchInput.autocomplete = 'off';
    searchInput.setAttribute('aria-label', '搜索收藏');
    const scopeSelect = select([['current', '当前剧集'], ['all', '全部收藏']], '收藏范围');
    const statusSelect = select([['all', '全部状态'], ['due', '今日到期'], ...REVIEW_STATES], '复习状态');
    const filterRow = node('div', 'bcm-filter-row');
    filterRow.append(field('范围', scopeSelect), field('状态', statusSelect));
    const revealButton = button('隐藏笔记答案', async () => {
        await flushDrafts();
        showAnswers = !showAnswers;
        revealButton.textContent = showAnswers ? '隐藏笔记答案' : '显示笔记答案';
        revealButton.setAttribute('aria-pressed', String(!showAnswers));
        for (const { answer } of controls.values()) answer.hidden = !showAnswers;
    }, 'bcm-button-quiet');
    revealButton.setAttribute('aria-pressed', 'false');
    const resultSummary = node('p', 'bcm-result-summary', '尚未加载收藏');
    resultSummary.setAttribute('role', 'status');
    const summaryRow = node('div', 'bcm-summary-row');
    summaryRow.append(resultSummary, revealButton);
    filters.append(field('搜索', searchInput), filterRow, summaryRow);
    const dueBar = node('div', 'bcm-due-bar');
    const dueText = node('p', 'bcm-due-text');
    dueText.setAttribute('role', 'status');
    const startButton = button('开始复习', () => startSession(), 'bcm-button-primary');
    dueBar.append(dueText, startButton);
    dueBar.hidden = true;

    const notices = node('div', 'bcm-notices');
    notices.setAttribute('aria-live', 'polite');
    const noticeText = node('span');
    const retryDrafts = button('重试保存', async () => {
        const ok = await flushDrafts();
        if (ok) setNotice('笔记已保存。');
    });
    const retryLoading = button('重新加载', () => refresh());
    retryLoading.hidden = true;
    retryDrafts.hidden = true;
    notices.append(noticeText, retryDrafts, retryLoading);
    notices.hidden = true;

    const undoRegion = node('div', 'bcm-undo');
    undoRegion.hidden = true;
    undoRegion.setAttribute('role', 'status');
    const undoText = node('span', '', '收藏已删除。');
    const undoButton = button('撤销删除', async () => {
        if (!undoNote) return;
        const restoring = undoNote;
        undoButton.disabled = true;
        try {
            await repo.restore(restoring);
            if (undoNote === restoring) { undoNote = null; undoRegion.hidden = true; }
            signalChange();
            await refresh();
            notify('已恢复收藏');
        } catch (error) { setNotice(`恢复失败：${readableError(error)}。可以再次撤销。`, true); }
        finally { undoButton.disabled = false; }
    });
    undoRegion.append(undoText, undoButton);

    const importRegion = node('section', 'bcm-import-preview');
    importRegion.hidden = true;
    importRegion.setAttribute('aria-label', '备份导入预览');
    const importText = node('p');
    const importActions = node('div', 'bcm-toolbar');
    const confirmImportButton = button('确认导入', () => confirmImport(), 'bcm-button-primary');
    const cancelImportButton = button('取消', () => { importData = null; importRegion.hidden = true; });
    importActions.append(confirmImportButton, cancelImportButton);
    importRegion.append(node('h3', '', '检查备份'), importText, importActions);

    const list = node('div', 'bcm-note-list');
    list.setAttribute('aria-label', '收藏列表');
    const pagination = node('nav', 'bcm-pagination');
    pagination.setAttribute('aria-label', '收藏分页');
    const previousButton = button('上一页', async () => { offset = Math.max(0, offset - PAGE_SIZE); await refresh(); scroll.scrollTop = 0; });
    const pageLabel = node('span', 'bcm-page-label');
    const nextButton = button('下一页', async () => { offset += PAGE_SIZE; await refresh(); scroll.scrollTop = 0; });
    pagination.append(previousButton, pageLabel, nextButton);
    pagination.hidden = true;
    const footer = node('p', 'bcm-storage-note', '收藏保存在本浏览器中。清理站点数据前，请先备份。');
    // A sitting replaces the list: one card at a time, answer hidden until revealed.
    const sessionView = node('section', 'bcm-session');
    sessionView.setAttribute('aria-label', '复习会话');
    sessionView.hidden = true;
    const sessionTop = node('div', 'bcm-session-top');
    const progressText = node('p', 'bcm-session-progress');
    progressText.setAttribute('role', 'status');
    sessionTop.append(progressText, button('结束复习', () => leaveSession(), 'bcm-button-quiet'));
    const sessionCard = node('article', 'bcm-session-card');
    sessionView.append(sessionTop, sessionCard);
    scroll.append(dueBar, filters, notices, undoRegion, importRegion, sessionView, list, pagination, footer);
    const fileInput = node('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.hidden = true;
    element.append(header, scroll, fileInput);

    const observer = typeof IntersectionObserver === 'function' ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            observer.unobserve(entry.target);
            loadImage(entry.target, entry.target.dataset.noteId, Number(entry.target.dataset.generation));
        }
    }, { root: scroll, rootMargin: '200px' }) : null;

    function setNotice(message, error = false) {
        noticeText.textContent = message;
        notices.hidden = !message;
        notices.classList.toggle('bcm-notice-error', error);
        retryLoading.hidden = true;
        retryDrafts.hidden = ![...drafts.values()].some(draft => draft.dirty && draft.error);
    }

    function signalChange() {
        Promise.resolve().then(() => onChange()).catch(error => console.warn('[场景复习本] 计数刷新失败', error));
    }

    function leadInFor(note) {
        const value = Number(getLeadIn(note));
        return Number.isFinite(value) ? Math.max(0, Math.min(30, value)) : 3;
    }

    function updateSaveState(id) {
        const view = controls.get(id);
        if (!view) return;
        const draft = drafts.get(id);
        const text = draft?.error ? '保存失败，草稿已保留' : draft?.saving ? '保存中…' : draft?.dirty ? '等待保存…' : '已保存';
        view.saveState.textContent = text;
        view.saveState.classList.toggle('bcm-save-error', Boolean(draft?.error));
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
                    if (draft.revision === revision) { draft.dirty = false; draft.patch = {}; }
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
        const results = await Promise.all([...drafts.keys()].map(id => saveDraft(id)));
        retryDrafts.hidden = ![...drafts.values()].some(draft => draft.dirty && draft.error);
        return results.every(Boolean);
    }

    function clearImages() {
        observer?.disconnect();
        for (const url of imageUrls) URL.revokeObjectURL(url);
        imageUrls.clear();
    }

    function imageSource(note) {
        if (note?.imageBlob instanceof Blob && /^image\/(jpeg|png|webp|gif|avif)$/i.test(note.imageBlob.type)) {
            const url = URL.createObjectURL(note.imageBlob);
            imageUrls.add(url);
            return url;
        }
        return /^data:image\/(jpeg|png|webp|gif|avif);base64,/i.test(note?.imageUrl || '') ? note.imageUrl : null;
    }

    function showImage(container, note) {
        const src = imageSource(note);
        if (!src) { container.textContent = '图片不可用，仍可回听原视频。'; return; }
        const image = node('img', 'bcm-note-image');
        image.alt = `${note.epTitle || note.seriesTitle || '视频'} ${note.timeStr || timeLabel(note.time)} 的收藏画面`;
        image.decoding = 'async';
        image.addEventListener('error', () => { container.textContent = '图片无法显示，仍可回听原视频。'; });
        image.src = src;
        container.replaceChildren(image);
    }

    async function loadImage(container, id, generation) {
        if (disposed || generation !== renderGeneration || container.dataset.loaded) return;
        container.dataset.loaded = 'true';
        try {
            const note = await repo.get(id);
            if (disposed || generation !== renderGeneration || !container.isConnected) return;
            showImage(container, note);
        } catch {
            if (!disposed && generation === renderGeneration) container.textContent = '图片无法加载，仍可回听原视频。';
        }
    }

    function sameSource(note) {
        const sourceId = note?.source?.sourceId;
        return Boolean(sourceId) && player.getCurrent?.()?.identity?.source?.sourceId === sourceId;
    }

    /** Seek and play while the source is open; resolves true once a navigation to it has started. */
    async function listen(note) {
        const result = await player.seek(note, { leadIn: leadInFor(note) });
        if (!result?.navigated) {
            const current = player.getCurrent?.();
            if (!current?.sourceReady || (note.source?.sourceId && current.identity?.source?.sourceId !== note.source.sourceId)) {
                throw new Error('视频正在切换，请画面就绪后重试');
            }
            if (typeof current.media?.play !== 'function') throw new Error('播放器暂时无法播放，请手动继续');
            await current.media.play();
        }
        return Boolean(result?.navigated);
    }

    async function playNote(note, control, loop = false) {
        control.disabled = true;
        try {
            if (!(await flushDrafts())) {
                setNotice('笔记尚未保存成功。请先重试保存，再回听，避免切换视频时丢失草稿。', true);
                return;
            }
            if (loop && onLoop) await onLoop(note);
            else await listen(note);
        } catch (error) {
            const message = `回听失败：${readableError(error)}`;
            setNotice(message, true);
            notify(message, { kind: 'error' });
        }
        finally { control.disabled = false; }
    }

    function renderNote(note) {
        const draft = drafts.get(note.id);
        const data = { ...note, ...(draft?.values || {}) };
        const article = node('article', 'bcm-note');
        article.dataset.noteId = note.id;
        const noteHeader = node('div', 'bcm-note-header');
        const noteTitle = node('h3', 'bcm-note-title', note.epTitle || note.seriesTitle || '未命名视频');
        const removeButton = button('删除', async () => {
            removeButton.disabled = true;
            try {
                if (!(await saveDraft(note.id))) return;
                const previous = await repo.remove(note.id);
                drafts.delete(note.id);
                undoNote = previous;
                undoText.textContent = '收藏已删除，可撤销最近一次删除。';
                undoRegion.hidden = !previous;
                signalChange();
                await refresh();
            } catch (error) { setNotice(`删除失败：${readableError(error)}。收藏仍保留。`, true); }
            finally { removeButton.disabled = false; }
        }, 'bcm-button-quiet bcm-delete');
        removeButton.setAttribute('aria-label', `删除 ${note.timeStr || timeLabel(note.time)} 的收藏`);
        noteHeader.append(noteTitle, removeButton);
        const meta = node('p', 'bcm-note-meta', note.seriesTitle || '未命名剧集');
        const imageContainer = node('div', 'bcm-image-placeholder', '正在载入场景…');
        imageContainer.dataset.noteId = note.id;
        imageContainer.dataset.generation = String(renderGeneration);
        const playback = node('div', 'bcm-playback-row');
        const playButton = button(`${note.timeStr || timeLabel(note.time)} · 回听`, () => playNote(note, playButton), 'bcm-button-primary bcm-play-button');
        playButton.title = `从收藏时间前 ${leadInFor(note)} 秒开始回听`;
        playback.append(playButton);
        if (onLoop) {
            const loopButton = button('片段循环', () => playNote(note, loopButton, true));
            playback.append(loopButton);
        }
        const answer = node('div', 'bcm-answer');
        answer.hidden = !showAnswers;
        const noteInput = node('textarea', 'bcm-input bcm-note-input');
        noteInput.rows = 3;
        noteInput.maxLength = 20000;
        noteInput.placeholder = '记下没听懂的词句，或自己的理解';
        noteInput.value = data.userNote || '';
        noteInput.addEventListener('input', () => queueDraft(note.id, { userNote: noteInput.value }));
        noteInput.addEventListener('blur', () => saveDraft(note.id));
        answer.append(field('笔记 / 答案', noteInput));
        const tagsInput = node('input', 'bcm-input bcm-tags-input');
        tagsInput.type = 'text';
        tagsInput.value = (data.tags || []).join('，');
        tagsInput.placeholder = '例如：连读，日常口语';
        tagsInput.addEventListener('input', () => queueDraft(note.id, { tags: [...new Set(tagsInput.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean))] }));
        tagsInput.addEventListener('blur', () => saveDraft(note.id));
        const reviewSelect = select(REVIEW_STATES, '这条收藏的复习状态');
        reviewSelect.value = data.reviewState || 'new';
        reviewSelect.addEventListener('change', async () => {
            const state = reviewSelect.value;
            // A manual status overrides the schedule: whatever is not mastered is wanted now.
            queueDraft(note.id, state === 'mastered' ? { reviewState: state } : { reviewState: state, dueAt: now() });
            await saveDraft(note.id);
        });
        const bottom = node('div', 'bcm-note-bottom');
        const saveState = node('span', 'bcm-save-state', '已保存');
        saveState.setAttribute('role', 'status');
        bottom.append(field('复习状态', reviewSelect), saveState);
        article.append(noteHeader, meta);
        if (note.hasImage || note.imageUrl || note.imageBlob) {
            article.append(imageContainer);
            if (observer) observer.observe(imageContainer);
            else setTimeout(() => loadImage(imageContainer, note.id, Number(imageContainer.dataset.generation)), 0);
        }
        article.append(playback, answer, field('标签（逗号分隔）', tagsInput), bottom);
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
        const seriesId = scopeSelect.value === 'current' ? identity?.seriesId : null;
        list.setAttribute('aria-busy', 'true');
        previousButton.disabled = true;
        nextButton.disabled = true;
        resultSummary.textContent = '正在加载收藏…';
        try {
            if (typeof repo.ready === 'function') await repo.ready();
            else await repo.ready;
            // A sitting owns the panel; the list is redrawn when it ends.
            if (sessionActive()) { updateDue(scopeSelect.value === 'current' && !seriesId ? undefined : seriesId, generation); return; }
            const result = scopeSelect.value === 'current' && !seriesId
                ? { notes: [], total: 0 }
                : await repo.list({ seriesId, query: searchInput.value.trim(), status: statusSelect.value, offset, limit: PAGE_SIZE });
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
                const empty = node('div', 'bcm-empty');
                const filtered = Boolean(searchInput.value.trim()) || statusSelect.value !== 'all';
                const noPlayer = scopeSelect.value === 'current' && !seriesId;
                const noDue = statusSelect.value === 'due' && !searchInput.value.trim();
                empty.append(node('h3', '', noPlayer ? '当前没有可用的视频' : noDue ? '今天没有到期的收藏' : filtered ? '没有符合条件的收藏' : '把想再听的瞬间留下来'));
                empty.append(node('p', '', noPlayer ? '切换到“全部收藏”查看历史记录，或打开 B 站视频。' : noDue ? '新收藏会立即到期；复习过的收藏按间隔再次出现。' : filtered ? '试试其他关键词，或将复习状态设为“全部状态”。' : '播放时按 Alt + S 收藏画面；之后可从这里回听、做笔记。'));
                fragment.append(empty);
            }
            list.replaceChildren(fragment);
            resultSummary.textContent = `共 ${new Intl.NumberFormat('zh-CN').format(total)} 条收藏`;
            pageLabel.textContent = `${Math.floor(offset / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))}`;
            previousButton.disabled = offset === 0;
            nextButton.disabled = offset + PAGE_SIZE >= total;
            pagination.hidden = total <= PAGE_SIZE;
            updateDue(scopeSelect.value === 'current' && !seriesId ? undefined : seriesId, generation);
        } catch (error) {
            if (generation === refreshGeneration) {
                resultSummary.textContent = '收藏加载失败';
                setNotice(`无法读取收藏：${readableError(error)}。请重新加载。`, true);
                retryLoading.hidden = false;
            }
        } finally {
            if (generation === refreshGeneration) list.removeAttribute('aria-busy');
        }
    }

    function saveSession() {
        try { sessionStorage?.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* Without tab storage the sitting still runs, but cannot continue after a cross-video navigation. */ }
    }

    function clearSession() {
        session = null;
        try { sessionStorage?.removeItem(SESSION_KEY); } catch { /* The discarded sitting is never read again. */ }
    }

    function remaining() {
        return session ? session.queue.length - session.index : 0;
    }

    function sessionActive() {
        return opened && !sessionView.hidden;
    }

    function batchSize() {
        const value = Number(getBatchSize());
        return Number.isFinite(value) ? Math.max(1, Math.min(200, Math.round(value))) : 20;
    }

    function renderDueBar() {
        const left = remaining();
        if (left > 0) {
            dueText.textContent = `上次复习还剩 ${left} 条`;
            startButton.textContent = '继续复习';
        } else if (dueCount > 0) {
            dueText.textContent = `有 ${dueCount} 条收藏到期，该复习了`;
            startButton.textContent = '开始复习';
        }
        dueBar.hidden = left === 0 && dueCount === 0;
        startButton.hidden = false;
    }

    async function updateDue(seriesId, generation) {
        let failed = false;
        try {
            const due = seriesId === undefined ? 0 : await repo.countDue(seriesId, now());
            if (disposed || generation !== refreshGeneration) return;
            dueCount = due;
        } catch {
            if (disposed || generation !== refreshGeneration) return;
            dueCount = 0;
            failed = true;
        }
        renderDueBar();
        if (failed) {
            dueText.textContent = '无法读取到期的收藏';
            dueBar.hidden = false;
            startButton.hidden = true;
        }
    }

    /** Re-read the due count without redrawing the list or disturbing an edit in progress. */
    async function refreshDue() {
        if (disposed || !opened) return;
        await updateDue(scopeSelect.value === 'current' ? player.getCurrent?.()?.identity?.seriesId || undefined : null, refreshGeneration);
    }

    /** Begin a sitting of due cards, or continue one that was left unfinished. */
    async function startSession() {
        if (sessionBusy || disposed) return;
        if (remaining() > 0) { await enterSession(); return; }
        sessionBusy = true;
        startButton.disabled = true;
        try {
            if (!(await flushDrafts())) throw new Error('仍有未保存笔记，请先重试保存');
            const seriesId = scopeSelect.value === 'current' ? player.getCurrent?.()?.identity?.seriesId : null;
            if (scopeSelect.value === 'current' && !seriesId) throw new Error('当前没有可用的视频，请选择全部收藏');
            const due = [];
            let sessionOffset = 0;
            for (;;) {
                const batch = await repo.list({ seriesId, status: 'due', offset: sessionOffset, limit: 500 });
                due.push(...batch.notes);
                sessionOffset += batch.notes.length;
                if (!batch.notes.length || sessionOffset >= batch.total) break;
            }
            if (disposed) return;
            if (!due.length) {
                setNotice('目前没有到期的收藏。');
                return;
            }
            session = {
                queue: orderSession(due, { currentSourceId: player.getCurrent?.()?.identity?.source?.sourceId, limit: batchSize() }).map(note => note.id),
                index: 0, again: 0, hard: 0, good: 0, pending: null, pendingAt: 0
            };
            saveSession();
            await enterSession();
        } catch (error) {
            if (!disposed) setNotice(`无法开始复习：${readableError(error)}`, true);
        } finally { sessionBusy = false; startButton.disabled = false; }
    }

    async function enterSession() {
        sessionView.hidden = false;
        for (const item of [dueBar, filters, list, pagination, footer]) item.hidden = true;
        scroll.scrollTop = 0;
        return showSessionCard();
    }

    function showListView() {
        sessionGeneration += 1;
        currentNote = null;
        revealTarget = null;
        sessionView.hidden = true;
        for (const item of [dueBar, filters, list, footer]) item.hidden = false;
    }

    function leaveSession() {
        showListView();
        return refresh();
    }

    /** Show the next card, skipping cards removed or reviewed elsewhere. Resolves with the card shown. */
    async function showSessionCard() {
        const generation = ++sessionGeneration;
        revealed = false;
        currentNote = null;
        revealTarget = null;
        clearImages();
        while (session && session.index < session.queue.length) {
            const id = session.queue[session.index];
            progressText.textContent = `还剩 ${session.queue.length - session.index} 条`;
            sessionCard.replaceChildren(node('p', 'bcm-session-hint', '正在载入…'));
            let note;
            try { note = await repo.get(id); }
            catch (error) {
                if (generation !== sessionGeneration) return null;
                sessionCard.replaceChildren(node('p', 'bcm-session-hint', `无法读取这条收藏：${readableError(error)}`), button('重试', () => showSessionCard()));
                return null;
            }
            if (generation !== sessionGeneration) return null;
            if (note && isDue(note, now())) {
                currentNote = note;
                renderSessionCard(note);
                scroll.scrollTop = 0;
                return note;
            }
            session.index += 1;
            saveSession();
        }
        if (generation === sessionGeneration) finishSession();
        return null;
    }

    function currentShortcuts() {
        return normalizeShortcutsMap(getShortcuts?.());
    }

    function sessionShortcutHint(keys) {
        const parts = [];
        if (keys.reveal) parts.push(`${formatShortcut(keys.reveal)}显示答案`);
        const rates = [keys.rateAgain, keys.rateHard, keys.rateGood];
        if (rates.some(Boolean)) parts.push(`${rates.map(spec => spec ? formatShortcut(spec) : '—').join(' / ')} 自评`);
        return parts.length ? `${parts.join('，')}。` : '';
    }

    function refreshShortcuts() {
        if (!revealTarget || !sessionActive()) return;
        const keys = currentShortcuts();
        if (revealTarget.shortcutHint) revealTarget.shortcutHint.textContent = sessionShortcutHint(keys);
        const specs = [keys.rateAgain, keys.rateHard, keys.rateGood];
        revealTarget.ratingKeys?.forEach((kbd, index) => {
            const spec = specs[index];
            kbd.textContent = spec ? formatShortcut(spec) : '';
            kbd.hidden = !spec;
        });
    }

    function renderSessionCard(note) {
        const keys = currentShortcuts();
        const title = node('h3', 'bcm-session-title', `${note.epTitle || note.seriesTitle || '未命名视频'} · ${note.timeStr || timeLabel(note.time)}`);
        title.tabIndex = -1;
        const here = sameSource(note);
        const hint = node('p', 'bcm-session-hint', here ? '先听一遍，回想意思，再看答案。' : '这条收藏在其他视频里。回听会跳转过去，页面就绪后自动继续复习。');
        let shortcutHint = null;
        if (here) {
            shortcutHint = node('span', 'bcm-nowrap', sessionShortcutHint(keys));
            hint.append(shortcutHint);
        }
        const playback = node('div', 'bcm-playback-row');
        const playButton = button('回听', () => sessionPlay(note, false, playButton), 'bcm-button-primary bcm-play-button');
        playButton.title = `从收藏时间前 ${leadInFor(note)} 秒开始回听`;
        playback.append(playButton);
        if (onLoop) playback.append(button('片段循环', () => sessionPlay(note, true)));
        const answer = node('div', 'bcm-session-answer');
        answer.hidden = true;
        if (note.hasImage || note.imageUrl || note.imageBlob) {
            const container = node('div', 'bcm-image-placeholder', '正在载入场景…');
            answer.append(container);
            showImage(container, note);
        }
        answer.append(node('p', 'bcm-session-note', note.userNote || '这条收藏没有笔记。'));
        if (note.tags?.length) answer.append(node('p', 'bcm-session-tags', `标签：${note.tags.join('、')}`));
        const revealButton = button('显示答案', () => reveal(), 'bcm-button-primary');
        const ratings = node('div', 'bcm-ratings');
        ratings.setAttribute('role', 'group');
        ratings.setAttribute('aria-label', '这次听得怎么样');
        ratings.hidden = true;
        // Each choice says when the card comes back, so the ladder is visible without explaining an algorithm.
        const upcoming = schedule(note, 'good');
        const hints = { again: '稍后再来', hard: '明天再来', good: upcoming.reviewState === 'mastered' ? '记为已掌握' : `${upcoming.interval} 天后再来` };
        const ratingSpecs = [keys.rateAgain, keys.rateHard, keys.rateGood];
        const ratingKeys = [];
        RATING_CHOICES.forEach(([rating, label], position) => {
            const choice = button('', () => rate(rating), 'bcm-rating');
            choice.dataset.rating = rating;
            choice.setAttribute('aria-label', `${label}，${hints[rating]}`);
            const name = node('span', 'bcm-rating-label');
            const kbd = node('kbd', '', ratingSpecs[position] ? formatShortcut(ratingSpecs[position]) : '');
            kbd.hidden = !ratingSpecs[position];
            ratingKeys.push(kbd);
            name.append(kbd, node('span', '', label));
            choice.append(name, node('small', '', hints[rating]));
            ratings.append(choice);
        });
        sessionCard.replaceChildren(title, hint, playback, revealButton, answer, ratings);
        revealTarget = { title, revealButton, answer, ratings, shortcutHint, ratingKeys };
        title.focus({ preventScroll: true });
    }

    function reveal() {
        if (!sessionActive() || revealed || !revealTarget) return;
        revealed = true;
        revealTarget.revealButton.hidden = true;
        revealTarget.answer.hidden = false;
        revealTarget.ratings.hidden = false;
    }

    async function rate(rating) {
        if (!sessionActive() || !revealed || sessionBusy || !currentNote) return;
        const id = session.queue[session.index];
        const choices = revealTarget.ratings.children;
        sessionBusy = true;
        for (const choice of choices) choice.disabled = true;
        try {
            await repo.review(id, rating);
            if (session?.queue[session.index] !== id) return;
            session[rating] += 1;
            session.index += 1;
            // A card that was not understood comes back at the end of this sitting.
            if (rating === 'again') session.queue.push(id);
            saveSession();
            signalChange();
            await showSessionCard();
        } catch (error) {
            setNotice(`自评没有保存：${readableError(error)}`, true);
            for (const choice of choices) choice.disabled = false;
        } finally { sessionBusy = false; }
    }

    function finishSession() {
        const result = session;
        clearSession();
        clearImages();
        revealed = false;
        progressText.textContent = '本轮结束';
        const actions = node('div', 'bcm-playback-row');
        actions.append(button('再来一组', () => restartSession(), 'bcm-button-primary'), button('返回复习本', () => leaveSession()));
        const title = node('h3', 'bcm-session-title', '本轮复习完成');
        title.tabIndex = -1;
        sessionCard.replaceChildren(
            title,
            node('p', 'bcm-session-hint', `复习了 ${result.queue.length - result.again} 条收藏：听懂了 ${result.good}，费劲 ${result.hard}，没听懂 ${result.again}。`),
            node('p', 'bcm-session-hint', '听懂的收藏会在 1、3、7、15、31 天后依次再出现。到期时，播放器按钮和复习本顶部会提示。'),
            actions
        );
        title.focus({ preventScroll: true });
    }

    async function restartSession() {
        showListView();
        await refresh();
        await startSession();
    }

    async function sessionPlay(note, loop, control = null) {
        if (playBusy || !note) return;
        playBusy = true;
        if (control) control.disabled = true;
        try {
            if (!(await flushDrafts())) {
                setNotice('笔记尚未保存成功。请先重试保存，再回听，避免切换视频时丢失草稿。', true);
                return;
            }
            // Remember why the page is left, so the next one can reopen this card and continue.
            if (!sameSource(note)) { session.pending = loop ? 'loop' : 'listen'; session.pendingAt = now(); saveSession(); }
            const navigated = loop && onLoop ? Boolean((await onLoop(note))?.navigated) : await listen(note);
            if (!navigated) dropPending();
        } catch (error) {
            dropPending();
            const message = `回听失败：${readableError(error)}`;
            setNotice(message, true);
            notify(message, { kind: 'error' });
        } finally {
            playBusy = false;
            if (control) control.disabled = false;
            // Space reveals the answer; left on a playback button it would replay the clip instead.
            if (currentNote === note) revealTarget?.title.focus({ preventScroll: true });
        }
    }

    function dropPending() {
        if (!session?.pending) return;
        session.pending = null;
        saveSession();
    }

    /** After this sitting's own cross-video navigation, reopen the same card and continue. */
    async function resumeSession() {
        if (disposed || !session?.pending) return false;
        const action = session.pending;
        const expired = now() - session.pendingAt > RESUME_WINDOW;
        session.pending = null;
        saveSession();
        if (expired) return false;
        await open();
        const note = await enterSession();
        if (action === 'loop' && note && sameSource(note)) await sessionPlay(note, true);
        return true;
    }

    function isInteractiveControl(target) {
        if (!target) return false;
        const tag = (target.tagName || '').toLowerCase();
        return tag === 'button' || tag === 'a' || Boolean(target.closest?.('button, a'));
    }

    function insideOverlayPanel(target) {
        return Boolean(target?.closest?.('.bcm-panel'));
    }

    function onSessionKey(event) {
        if (!sessionActive() || event.isComposing || event.repeat || isEditableEvent(event)) return;
        const deepActive = getDeepActiveElement();
        if (insideOverlayPanel(event.target) || insideOverlayPanel(deepActive)) return;
        const keys = currentShortcuts();
        if (revealed) {
            const ratingSpecs = [keys.rateAgain, keys.rateHard, keys.rateGood];
            const index = ratingSpecs.findIndex(spec => matchesShortcut(event, spec));
            if (index >= 0) {
                event.preventDefault();
                event.stopImmediatePropagation();
                void rate(RATING_CHOICES[index][0]);
            }
            return;
        }
        if (matchesShortcut(event, keys.reveal)) {
            if ((keys.reveal === 'Space' || keys.reveal === 'Enter') && (isInteractiveControl(event.target) || isInteractiveControl(deepActive))) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            reveal();
        }
    }

    async function backup() {
        backupButton.disabled = true;
        backupButton.textContent = '正在备份…';
        try {
            if (!(await flushDrafts())) throw new Error('仍有未保存笔记，请先重试保存');
            const data = await repo.exportBackup();
            downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }), `B站场景收藏_完整备份_${fileNameDate()}.json`);
            setNotice('完整备份已生成，包含所有剧集的收藏和图片。请保留下载的 JSON 文件。');
        } catch (error) { setNotice(`备份失败：${readableError(error)}`, true); }
        finally { backupButton.disabled = false; backupButton.textContent = '备份全部'; }
    }

    async function exportReading() {
        readingButton.disabled = true;
        readingButton.textContent = '正在导出…';
        try {
            if (!(await flushDrafts())) throw new Error('仍有未保存笔记，请先重试保存');
            const seriesId = scopeSelect.value === 'current' ? player.getCurrent?.()?.identity?.seriesId : null;
            if (scopeSelect.value === 'current' && !seriesId) throw new Error('当前没有可用的视频，请选择全部收藏');
            const query = searchInput.value.trim();
            const status = statusSelect.value;
            const output = document.implementation.createHTMLDocument('场景复习笔记');
            output.documentElement.lang = 'zh-CN';
            const charset = output.createElement('meta');
            charset.setAttribute('charset', 'utf-8');
            const viewport = output.createElement('meta');
            viewport.name = 'viewport';
            viewport.content = 'width=device-width, initial-scale=1';
            const policy = output.createElement('meta');
            policy.httpEquiv = 'Content-Security-Policy';
            policy.content = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";
            const style = output.createElement('style');
            style.textContent = 'body{font:16px/1.7 system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#172536;background:#fff;overflow-wrap:anywhere}article{padding:24px 0;border-top:1px solid #bac7d4}h1{font-size:28px}h2{font-size:20px}img{max-width:100%;height:auto}p{white-space:pre-wrap}a{color:#005a84}small{color:#455568}';
            output.head.prepend(charset, viewport, policy);
            output.head.append(style);
            output.body.append(node('h1', '', '场景复习笔记'), node('p', '', `导出日期：${new Date().toLocaleDateString('zh-CN')}。此文件用于离线阅读；恢复收藏请使用 JSON 完整备份。`));
            let exported = 0;
            let exportOffset = 0;
            let missingImages = 0;
            while (!disposed) {
                const batch = await repo.list({ seriesId, query, status, offset: exportOffset, limit: 100 });
                if (!batch.notes.length) break;
                for (const metadata of batch.notes) {
                    const note = await repo.get(metadata.id);
                    if (!note) continue;
                    const article = node('article');
                    article.append(node('h2', '', `${note.timeStr || timeLabel(note.time)} · ${note.epTitle || note.seriesTitle || '未命名视频'}`));
                    article.append(node('small', '', `${note.seriesTitle || ''} · ${(note.tags || []).join(' / ')} · ${REVIEW_STATES.find(([value]) => value === note.reviewState)?.[1] || '待复习'}`));
                    if (note.source?.url) {
                        const source = new URL(note.source.url);
                        if (['https:', 'http:'].includes(source.protocol)) {
                            source.searchParams.set('t', String(Math.floor(note.time || 0)));
                            const link = node('a', '', '打开原视频');
                            link.href = source.href;
                            const paragraph = node('p');
                            paragraph.append(link);
                            article.append(paragraph);
                        }
                    }
                    let imageUrl = /^data:image\/(jpeg|png|webp);base64,/i.test(note.imageUrl || '') ? note.imageUrl : null;
                    if (note.imageBlob) {
                        try { imageUrl = await blobDataUrl(note.imageBlob); }
                        catch { missingImages += 1; }
                    }
                    if (imageUrl) {
                        const image = node('img');
                        image.src = imageUrl;
                        image.alt = `${note.timeStr || timeLabel(note.time)} 的收藏画面`;
                        article.append(image);
                    }
                    article.append(node('p', '', note.userNote || '尚未填写笔记。'));
                    output.body.append(article);
                    exported += 1;
                }
                exportOffset += batch.notes.length;
                if (exportOffset >= batch.total) break;
            }
            if (disposed) return;
            if (!exported) throw new Error('当前筛选没有收藏，请更换条件后导出');
            downloadBlob(new Blob(['<!doctype html>\n', output.documentElement.outerHTML], { type: 'text/html;charset=utf-8' }), `B站场景复习_阅读版_${fileNameDate()}.html`);
            setNotice(`已导出 ${exported} 条收藏，使用浏览器打开 HTML 文件即可离线阅读。${missingImages ? `${missingImages} 张图片读取失败，笔记与来源已保留。` : ''}`);
        } catch (error) { setNotice(`阅读版导出失败：${readableError(error)}`, true); }
        finally { readingButton.disabled = false; readingButton.textContent = '导出阅读版'; }
    }

    async function previewFile() {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        importButton.disabled = true;
        importButton.textContent = '正在检查…';
        importData = null;
        importRegion.hidden = true;
        try {
            if (file.size > 150 * 1024 * 1024) throw new Error('文件超过 150 MiB，请使用较小的完整备份');
            const data = JSON.parse(await file.text());
            const preview = await repo.previewImport(data);
            if (disposed) return;
            importData = data;
            importText.textContent = `${file.name}：共 ${preview.total} 条，新增 ${preview.newCount} 条，已有 ${preview.existing} 条。已有收藏会保留，不覆盖。`;
            confirmImportButton.disabled = preview.newCount === 0;
            importRegion.hidden = false;
            if (opened) confirmImportButton.focus();
        } catch (error) { setNotice(`备份无法导入：${readableError(error)}。请选择此工具导出的完整 JSON 备份。`, true); }
        finally { importButton.disabled = false; importButton.textContent = '导入备份'; }
    }

    async function confirmImport() {
        if (!importData) return;
        confirmImportButton.disabled = true;
        cancelImportButton.disabled = true;
        importButton.disabled = true;
        confirmImportButton.textContent = '正在导入…';
        try {
            if (!(await flushDrafts())) throw new Error('仍有未保存笔记，请先重试保存');
            const result = await repo.importBackup(importData);
            importData = null;
            importRegion.hidden = true;
            setNotice(`导入完成：新增 ${result.imported} 条，保留已有 ${result.skipped} 条。`);
            signalChange();
            offset = 0;
            await refresh();
        } catch (error) { setNotice(`导入失败：${readableError(error)}。可以重试，已有收藏不会被覆盖。`, true); }
        finally {
            confirmImportButton.disabled = false;
            cancelImportButton.disabled = false;
            importButton.disabled = false;
            confirmImportButton.textContent = '确认导入';
        }
    }

    searchInput.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { offset = 0; refresh(); }, 250);
    });
    for (const filter of [scopeSelect, statusSelect]) filter.addEventListener('change', () => { offset = 0; refresh(); });
    fileInput.addEventListener('change', previewFile);
    function protectDrafts(event) {
        if (![...drafts.values()].some(draft => draft.dirty || draft.saving)) return;
        event.preventDefault();
        event.returnValue = '';
    }
    window.addEventListener('beforeunload', protectDrafts);
    window.addEventListener('keydown', onSessionKey, true);

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
        if (!saved) notify('笔记尚未保存成功，草稿仅保留在当前页面。请重新打开复习本重试。');
        opened = false;
        refreshGeneration += 1;
        renderGeneration += 1;
        // An unfinished sitting stays stored and is offered again on the next open.
        showListView();
        clearImages();
        element.hidden = true;
        element.inert = true;
        if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
    }

    async function dispose() {
        await flushDrafts();
        disposed = true;
        opened = false;
        refreshGeneration += 1;
        renderGeneration += 1;
        sessionGeneration += 1;
        clearTimeout(searchTimer);
        window.removeEventListener('beforeunload', protectDrafts);
        window.removeEventListener('keydown', onSessionKey, true);
        for (const draft of drafts.values()) clearTimeout(draft.timer);
        clearImages();
        controls.clear();
        element.remove();
    }

    return { element, open, close, toggle: () => opened ? close() : open(), refresh, refreshDue, refreshShortcuts, resumeSession, dispose, isOpen: () => opened, flushDrafts };
}
