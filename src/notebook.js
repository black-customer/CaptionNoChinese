const PAGE_SIZE = 30;
const SAVE_DELAY = 550;
const REVIEW_STATES = [['new', '待复习'], ['learning', '仍不会'], ['mastered', '已掌握']];

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
export function createNotebook({ repo, player, notify = () => {}, version = '2.4.0', onChange = () => {}, onLoop, onHelp, onSettings, getLeadIn = () => 3 }) {
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
    const statusSelect = select([['all', '全部状态'], ...REVIEW_STATES], '复习状态');
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

    async function loadImage(container, id, generation) {
        if (disposed || generation !== renderGeneration || container.dataset.loaded) return;
        container.dataset.loaded = 'true';
        try {
            const note = await repo.get(id);
            if (disposed || generation !== renderGeneration || !container.isConnected) return;
            let src = null;
            if (note?.imageBlob instanceof Blob && /^image\/(jpeg|png|webp|gif|avif)$/i.test(note.imageBlob.type)) {
                src = URL.createObjectURL(note.imageBlob);
                imageUrls.add(src);
            } else if (/^data:image\/(jpeg|png|webp|gif|avif);base64,/i.test(note?.imageUrl || '')) {
                src = note.imageUrl;
            }
            if (!src) throw new Error('图片不可用');
            const image = node('img', 'bcm-note-image');
            image.alt = `${note.epTitle || note.seriesTitle || '视频'} ${note.timeStr || timeLabel(note.time)} 的收藏画面`;
            image.decoding = 'async';
            image.addEventListener('error', () => { container.textContent = '图片无法显示，仍可回听原视频。'; });
            image.src = src;
            container.replaceChildren(image);
        } catch {
            if (!disposed && generation === renderGeneration) container.textContent = '图片无法加载，仍可回听原视频。';
        }
    }

    async function playNote(note, control, loop = false) {
        control.disabled = true;
        try {
            if (!(await flushDrafts())) {
                setNotice('笔记尚未保存成功。请先重试保存，再回听，避免切换视频时丢失草稿。', true);
                return;
            }
            if (loop && onLoop) await onLoop(note);
            else {
                const result = await player.seek(note, { leadIn: leadInFor(note) });
                if (!result?.navigated) {
                    const current = player.getCurrent?.();
                    if (!current?.sourceReady || (note.source?.sourceId && current.identity?.source?.sourceId !== note.source.sourceId)) {
                        throw new Error('视频正在切换，请画面就绪后重试');
                    }
                    if (typeof current.media?.play !== 'function') throw new Error('播放器暂时无法播放，请手动继续');
                    await current.media.play();
                }
            }
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
            queueDraft(note.id, { reviewState: reviewSelect.value });
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
                empty.append(node('h3', '', noPlayer ? '当前没有可用的视频' : filtered ? '没有符合条件的收藏' : '把想再听的瞬间留下来'));
                empty.append(node('p', '', noPlayer ? '切换到“全部收藏”查看历史记录，或打开 B 站视频。' : filtered ? '试试其他关键词，或将复习状态设为“全部状态”。' : '播放时按 Alt + S 收藏画面；之后可从这里回听、做笔记。'));
                fragment.append(empty);
            }
            list.replaceChildren(fragment);
            resultSummary.textContent = `共 ${new Intl.NumberFormat('zh-CN').format(total)} 条收藏`;
            pageLabel.textContent = `${Math.floor(offset / PAGE_SIZE) + 1} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))}`;
            previousButton.disabled = offset === 0;
            nextButton.disabled = offset + PAGE_SIZE >= total;
            pagination.hidden = total <= PAGE_SIZE;
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
        clearTimeout(searchTimer);
        window.removeEventListener('beforeunload', protectDrafts);
        for (const draft of drafts.values()) clearTimeout(draft.timer);
        clearImages();
        controls.clear();
        element.remove();
    }

    return { element, open, close, toggle: () => opened ? close() : open(), refresh, dispose, isOpen: () => opened, flushDrafts };
}
