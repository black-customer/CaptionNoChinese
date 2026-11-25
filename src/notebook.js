import { getDeepActiveElement } from './editable.js';
import { formatTime, normalizeSource } from './player.js';

const PAGE_SIZE = 30;
const SAVE_DELAY = 550;
const LEAD_IN = 2;
const SCOPES = [
    ['episode', '当前本集'],
    ['series', '当前整部剧'],
    ['all', '全部记录']
];
const scopeLabels = new Map(SCOPES);
const scopeCounts = { episode: '本集', series: '本剧', all: '全部' };
const formatCount = new Intl.NumberFormat('zh-CN');
const formatDate = new Intl.DateTimeFormat('sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' });

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

const seriesTitle = note => note.seriesTitle || '未知剧集';
const episodeTitle = note => note.epTitle || (note.source?.episodeId ?? (note.source?.videoId ? `P${note.source.page}` : '未标注分集'));
const timeLabel = note => note.timeStr || formatTime(note.time);

function escapeMarkdown(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replace(/[\\`*_\[\]~]/g, '\\$&');
}

export function exportMarkdown({ notes, exportedAt }, scopeLabel) {
    const lines = [
        '# 场景学习记录', '',
        `- 导出日期：${formatDate.format(new Date(exportedAt))}`,
        `- 导出范围：${scopeLabel}（共 ${notes.length} 条）`
    ];
    const series = new Map();
    for (const note of notes) {
        const title = seriesTitle(note);
        const part = episodeTitle(note);
        if (!series.has(title)) series.set(title, new Map());
        const episodes = series.get(title);
        if (!episodes.has(part)) episodes.set(part, []);
        episodes.get(part).push(note);
    }
    const heading = text => escapeMarkdown(text.replace(/\s+/g, ' ').trim()).replace(/#+$/, match => '\\' + match);
    const compareTitles = ([left], [right]) => left.localeCompare(right, 'zh-CN', { numeric: true });
    for (const [title, episodes] of [...series].sort(compareTitles)) {
        lines.push('', `## ${heading(title)}`);
        for (const [part, records] of [...episodes].sort(compareTitles)) {
            lines.push('', `### ${heading(part)}`, '');
            records.sort((a, b) => a.time - b.time || a.createdAt - b.createdAt);
            for (const note of records) {
                const link = note.timestampUrl ? ` · [打开原片段](${note.timestampUrl})` : '';
                lines.push(`- **${escapeMarkdown(timeLabel(note).replace(/\s+/g, ' '))}**${link}`);
                const memo = (note.userNote || '').replace(/\r\n?/g, '\n').split('\n');
                lines.push(`  > 备注：${escapeMarkdown(memo[0])}`);
                for (const line of memo.slice(1)) {
                    const literal = escapeMarkdown(line).replace(/^(\d*)([#>+!.)-])/, '$1\\$2');
                    lines.push(`  > ${literal}`);
                }
                if (note.createdAt > 0 && note.createdAt <= 8.64e15) {
                    lines.push(`  > 记录时间：${new Date(note.createdAt).toISOString()}`);
                }
            }
        }
    }
    return lines.join('\n') + '\n';
}

function exportHtml({ notes, exportedAt }, scopeLabel) {
    const output = document.implementation.createHTMLDocument('场景学习记录');
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
    style.textContent = [
        ':root{color-scheme:light}body{font:16px/1.65 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;background:#fff;color:#111827;overflow-wrap:anywhere}',
        'article{padding:22px 0;border-top:1px solid #e5e7eb}h1{font-size:28px}h2{font-size:18px;margin:0 0 12px}p{white-space:pre-wrap}',
        'img{display:block;width:100%;height:auto;border-radius:10px;background:#f7f8fa}a{color:#18181b}small{color:#6b7280}'
    ].join('');
    output.head.prepend(charset, viewport, policy);
    output.head.append(style);
    output.body.append(node('h1', '', '场景学习记录'), node('p', '', `${formatDate.format(new Date(exportedAt))} · ${scopeLabel} · 共 ${notes.length} 条`));
    for (const note of notes) {
        const article = node('article');
        article.append(node('h2', '', `${seriesTitle(note)} · ${episodeTitle(note)}`));
        if (note.timestampUrl) {
            const link = node('a', '', `${timeLabel(note)} · 打开原片段`);
            link.href = note.timestampUrl;
            article.append(link);
        } else article.append(node('small', '', timeLabel(note)));
        if (/^data:image\/(jpeg|png|webp);base64,/.test(note.imageUrl || '')) {
            const image = node('img');
            image.loading = 'lazy';
            image.src = note.imageUrl;
            image.alt = `${episodeTitle(note)} ${timeLabel(note)} 的记录画面`;
            article.append(image);
        }
        if (note.userNote) article.append(node('p', '', note.userNote));
        output.body.append(article);
    }
    return '<!doctype html>\n' + output.documentElement.outerHTML;
}

/** Non-modal notebook. The caller owns attachment and fullscreen placement. */
export function createNotebook({ repo, player, notify = () => {}, version = '3.0.0', onChange = () => {}, onHelp, onSettings }) {
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
    const drafts = new Map();
    const controls = new Map();
    const imageUrls = new Set();
    const element = node('aside', 'bcm-notebook');
    element.setAttribute('aria-label', '场景记录库');
    element.dataset.version = version;
    element.tabIndex = -1;
    element.hidden = true;
    element.inert = true;

    const header = node('header', 'bcm-notebook-header');
    const heading = node('div', 'bcm-heading-row');
    const title = node('h2', 'bcm-notebook-title', '场景记录库');
    const closeButton = button('关闭', () => close(), 'bcm-button-quiet');
    closeButton.setAttribute('aria-label', '关闭记录库');
    heading.append(title, closeButton);
    const subtitle = node('p', 'bcm-subtitle', '看剧随手记，看完再整理导出。');
    const headerActions = node('div', 'bcm-toolbar');
    for (const [format, extension, mime, serialize] of [
        ['JSON', 'json', 'application/json', data => JSON.stringify(data, null, 2)],
        ['Markdown', 'md', 'text/markdown', exportMarkdown],
        ['HTML', 'html', 'text/html', exportHtml]
    ]) {
        const action = button(`导出 ${format}`, () => download(format, extension, mime, serialize, action), format === 'JSON' ? 'bcm-button-primary' : '');
        headerActions.append(action);
    }
    const importButton = button('导入备份', () => fileInput.click());
    headerActions.append(importButton);
    const utilities = node('div', 'bcm-header-tools');
    if (onSettings) utilities.append(button('设置', onSettings, 'bcm-button-quiet'));
    if (onHelp) utilities.append(button('帮助', onHelp, 'bcm-button-quiet'));
    utilities.append(closeButton);
    heading.append(utilities);
    header.append(heading, subtitle, headerActions);

    const scroll = node('div', 'bcm-notebook-scroll');
    const filters = node('section', 'bcm-filters');
    filters.setAttribute('aria-label', '筛选记录');
    const searchInput = node('input', 'bcm-input');
    searchInput.type = 'search';
    searchInput.placeholder = '搜索标题或备注';
    searchInput.autocomplete = 'off';
    searchInput.maxLength = 1000;
    searchInput.setAttribute('aria-label', '搜索记录');
    const scopeSelect = select(SCOPES, '记录范围');
    const filterRow = node('div', 'bcm-filter-row');
    filterRow.append(scopeSelect, searchInput);
    const resultSummary = node('p', 'bcm-result-summary');
    resultSummary.setAttribute('role', 'status');
    filters.append(filterRow, resultSummary);
    const notices = node('div', 'bcm-notices');
    notices.setAttribute('aria-live', 'polite');
    const noticeText = node('span');
    const retryDrafts = button('重试保存', async () => {
        const ok = await flushDrafts();
        if (ok) {
            setNotice('备注已保存。');
            await refresh();
        }
    });
    const retryLoading = button('重新加载', () => refresh());
    retryLoading.hidden = true;
    retryDrafts.hidden = true;
    notices.append(noticeText, retryDrafts, retryLoading);
    notices.hidden = true;

    const undoRegion = node('div', 'bcm-undo');
    undoRegion.hidden = true;
    undoRegion.setAttribute('role', 'status');
    const undoText = node('span', '', '记录已删除。');
    const undoButton = button('撤销删除', async () => {
        if (!undoNote) return;
        const restoring = undoNote;
        undoButton.disabled = true;
        try {
            await repo.restore(restoring);
            if (undoNote === restoring) { undoNote = null; undoRegion.hidden = true; }
            signalChange();
            await refresh();
            notify('已恢复记录');
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
    list.setAttribute('aria-label', '场景记录列表');
    const pagination = node('nav', 'bcm-pagination');
    pagination.setAttribute('aria-label', '记录分页');
    const previousButton = button('上一页', async () => { offset = Math.max(0, offset - PAGE_SIZE); await refresh(); scroll.scrollTop = 0; });
    const pageLabel = node('span', 'bcm-page-label');
    const nextButton = button('下一页', async () => { offset += PAGE_SIZE; await refresh(); scroll.scrollTop = 0; });
    pagination.append(previousButton, pageLabel, nextButton);
    pagination.hidden = true;
    const footer = node('p', 'bcm-storage-note', '记录保存在当前浏览器。清理站点数据前，请导出 JSON 备份。');
    scroll.append(filters, notices, undoRegion, importRegion, list, pagination, footer);
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
        Promise.resolve().then(() => onChange()).catch(error => console.warn('[场景记录库] 计数刷新失败', error));
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
        if (note?.imageBlob instanceof Blob && /^image\/(jpeg|png|webp)$/i.test(note.imageBlob.type)) {
            const url = URL.createObjectURL(note.imageBlob);
            imageUrls.add(url);
            return url;
        }
        return /^data:image\/(jpeg|png|webp);base64,/i.test(note?.imageUrl || '') ? note.imageUrl : null;
    }

    function showImage(container, note) {
        const src = imageSource(note);
        if (!src) { container.textContent = '图片不可用，仍可回听原视频。'; return; }
        const image = node('img', 'bcm-note-image');
        image.alt = `${episodeTitle(note)} ${timeLabel(note)} 的记录画面`;
        image.loading = 'lazy';
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

    async function playNote(note, control) {
        control.disabled = true;
        try {
            if (!(await flushDrafts())) {
                setNotice('请先重试保存备注，再回听，以免切换视频时丢失草稿。', true);
                return;
            }
            const result = await player.seek(note, { leadIn: LEAD_IN });
            if (result?.navigated) return;
            const current = player.getCurrent?.();
            const sourceId = note.source?.sourceId || normalizeSource(note.source?.url)?.sourceId;
            if (!current?.sourceReady || (sourceId && current.identity?.source?.sourceId !== sourceId)) {
                throw new Error('视频正在切换，请画面就绪后重试');
            }
            if (typeof current.media?.play !== 'function') throw new Error('播放器暂时无法播放，请手动继续');
            await current.media.play();
        } catch (error) {
            const message = `回听失败：${readableError(error)}`;
            setNotice(message, true);
            notify(message, { kind: 'error' });
        }
        finally { control.disabled = false; }
    }

    function renderNote(note) {
        let draft = drafts.get(note.id);
        if (draft && !draft.dirty && !draft.saving &&
            (note.updatedAt > draft.savedAt || note.userNote === draft.values.userNote)) {
            drafts.delete(note.id);
            draft = null;
        }
        const data = { ...note, ...(draft?.values || {}) };
        const article = node('article', 'bcm-note');
        article.dataset.noteId = note.id;
        const tags = node('div', 'bcm-meta-tags');
        tags.append(node('span', 'bcm-tag-series', seriesTitle(note)), node('span', 'bcm-tag-episode', episodeTitle(note)));
        const removeButton = button('删除', async () => {
            removeButton.disabled = true;
            try {
                if (!(await saveDraft(note.id))) return;
                const previous = await repo.remove(note.id);
                drafts.delete(note.id);
                if (previous) {
                    undoNote = previous;
                    undoRegion.hidden = false;
                }
                signalChange();
                await refresh();
            } catch (error) { setNotice(`删除失败：${readableError(error)}。请重试。`, true); }
            finally { removeButton.disabled = false; }
        }, 'bcm-button-quiet bcm-delete');
        removeButton.setAttribute('aria-label', `删除 ${timeLabel(note)} 的记录`);
        const imageContainer = node('div', 'bcm-image-placeholder', '正在载入场景…');
        imageContainer.dataset.noteId = note.id;
        imageContainer.dataset.generation = String(renderGeneration);
        const playback = node('div', 'bcm-playback-row');
        const playButton = button(`${timeLabel(note)} · 回听此句`, () => playNote(note, playButton), 'bcm-button bcm-play-button');
        playButton.title = `提前 ${LEAD_IN} 秒回听`;
        playback.append(playButton, removeButton);
        const noteInput = node('textarea', 'bcm-input bcm-note-input');
        noteInput.rows = 2;
        noteInput.maxLength = 100000;
        noteInput.setAttribute('aria-label', `${episodeTitle(note)} ${timeLabel(note)} 的备注`);
        noteInput.placeholder = '写下这句想学的词、短语或表达，方便导出后给 AI 整理制卡…';
        noteInput.value = data.userNote || '';
        noteInput.addEventListener('input', () => queueDraft(note.id, { userNote: noteInput.value }));
        noteInput.addEventListener('blur', () => saveDraft(note.id));
        const saveState = node('span', 'bcm-save-state');
        saveState.setAttribute('role', 'status');
        article.append(tags);
        if (note.hasImage || note.imageUrl || note.imageBlob) {
            article.append(imageContainer);
            if (observer) observer.observe(imageContainer);
            else setTimeout(() => loadImage(imageContainer, note.id, Number(imageContainer.dataset.generation)), 0);
        }
        article.append(playback, field('备注', noteInput), saveState);
        controls.set(note.id, { saveState, noteInput });
        updateSaveState(note.id);
        return article;
    }

    function scopeFilter() {
        const scope = scopeSelect.value;
        const identity = player.getCurrent?.()?.identity;
        if (scope === 'all') return {};
        if (!identity?.seriesId) return null;
        if (scope === 'series') return { seriesId: identity.seriesId };
        return identity.source?.sourceId ? { sourceId: identity.source.sourceId } : null;
    }

    async function refresh() {
        if (disposed) return;
        const generation = ++refreshGeneration;
        await flushDrafts();
        if (disposed || generation !== refreshGeneration || !opened) return;
        const filters = scopeFilter();
        const query = searchInput.value.trim();
        list.setAttribute('aria-busy', 'true');
        previousButton.disabled = true;
        nextButton.disabled = true;
        if (!resultSummary.textContent) resultSummary.textContent = '正在加载记录…';
        try {
            const [result, scopeTotal] = filters ? await Promise.all([
                repo.list({ ...filters, query, offset, limit: PAGE_SIZE }),
                query ? repo.count(filters.seriesId, filters.sourceId) : null
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
                const empty = node('div', 'bcm-empty');
                empty.append(node('h3', '', !filters ? '当前没有可用的视频' : query ? '没有匹配的记录' : '还没有场景记录'));
                empty.append(node('p', '', !filters ? '切换到「全部记录」查看历史，或打开一个视频。' : query ? '试试其他关键词，或扩大查看范围。' : '遇到想再听的片段，点播放器上方的「记录」。'));
                fragment.append(empty);
            }
            list.replaceChildren(fragment);
            const resumedInput = controls.get(editing)?.noteInput;
            if (resumedInput) {
                resumedInput.focus({ preventScroll: true });
                resumedInput.setSelectionRange?.(active.selectionStart, active.selectionEnd);
            }
            resultSummary.textContent = `${scopeCounts[scopeSelect.value]}共 ${formatCount.format(scopeTotal ?? total)} 条记录${query ? ` · 匹配 ${formatCount.format(total)} 条` : ''}`;
            pageLabel.textContent = `${Math.floor(offset / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))}`;
            previousButton.disabled = offset === 0;
            nextButton.disabled = offset + PAGE_SIZE >= total;
            pagination.hidden = total <= PAGE_SIZE;
        } catch (error) {
            if (generation === refreshGeneration) {
                resultSummary.textContent = '记录加载失败';
                setNotice(`无法读取记录：${readableError(error)}。请重新加载。`, true);
                retryLoading.hidden = false;
            }
        } finally {
            if (generation === refreshGeneration) list.removeAttribute('aria-busy');
        }
    }

    function refreshSource() {
        if (!opened || scopeSelect.value === 'all') return;
        offset = 0;
        void refresh();
    }

    async function download(format, extension, mime, serialize, action) {
        const filters = scopeFilter();
        if (!filters) {
            setNotice('当前没有可用的视频。请选择「全部记录」再导出。', true);
            return;
        }
        const scopeLabel = scopeLabels.get(scopeSelect.value);
        const query = searchInput.value.trim();
        action.disabled = true;
        try {
            if (!(await flushDrafts())) throw new Error('请先重试保存备注');
            const data = await repo.exportBackup({ ...filters, query, includeImages: extension !== 'md' });
            if (disposed) return;
            const blob = new Blob([serialize(data, scopeLabel)], { type: `${mime};charset=utf-8` });
            downloadBlob(blob, `B站场景记录_${scopeLabel}_${formatDate.format(new Date(data.exportedAt))}.${extension}`);
            setNotice(`已导出 ${data.notes.length} 条记录 · ${format}`);
        } catch (error) { setNotice(`${format} 导出失败：${readableError(error)}`, true); }
        finally { action.disabled = false; }
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
            importText.textContent = `${file.name} · 共 ${preview.total} 条，新增 ${preview.newCount} 条，保留已有 ${preview.existing} 条。`;
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
            if (!(await flushDrafts())) throw new Error('请先重试保存备注');
            const result = await repo.importBackup(importData);
            importData = null;
            importRegion.hidden = true;
            setNotice(`导入完成：新增 ${result.imported} 条，保留已有 ${result.skipped} 条。`);
            signalChange();
            offset = 0;
            await refresh();
        } catch (error) { setNotice(`导入失败：${readableError(error)}。可以重试。`, true); }
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
    scopeSelect.addEventListener('change', () => { offset = 0; return refresh(); });
    fileInput.addEventListener('change', previewFile);
    function protectDrafts(event) {
        if (![...drafts.values()].some(draft => draft.dirty || draft.saving)) return;
        event.preventDefault();
        event.returnValue = '';
    }
    window.addEventListener('beforeunload', protectDrafts);

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
            if (returnFocus?.isConnected && typeof returnFocus.focus === 'function') returnFocus.focus({ preventScroll: true });
            if (!saved) notify('备注尚未保存，草稿保留在当前页面。请重新打开记录库重试。');
        })().finally(() => { closing = null; });
        return closing;
    }

    async function dispose() {
        await flushDrafts();
        disposed = true;
        opened = false;
        refreshGeneration += 1;
        renderGeneration += 1;
        clearTimeout(searchTimer);
        window.removeEventListener('beforeunload', protectDrafts);
        for (const draft of drafts.values()) clearTimeout(draft.timer);
        clearImages();
        controls.clear();
        element.remove();
    }

    return { element, open, close, toggle: () => opened ? close() : open(), refresh, refreshSource, dispose, isOpen: () => opened, flushDrafts };
}
