import { createRepository } from './storage.js';
import { createPlayerAdapter, formatTime } from './player.js';
import { createConfigStore } from './config.js';
import { createNotebook } from './notebook.js';
import { createReviewController } from './review.js';
import appStyles from './app.css';
import notebookStyles from './notebook.css';

const VERSION = __APP_VERSION__;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const editable = target => !!(target?.isContentEditable || target?.closest?.('input,textarea,select,[role="textbox"]'));
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, className = '') {
  const node = el('button', className, text); node.type = 'button';
  node.addEventListener('click', event => { event.stopPropagation(); action(event); });
  return node;
}

function start() {
  if (document.getElementById('bcm-app')) return;
  const root = el('div', 'bcm-root'); root.id = 'bcm-app'; root.dataset.version = VERSION;
  const style = el('style'); style.id = 'bcm-styles'; style.textContent = appStyles + '\n' + notebookStyles;
  (document.head || document.documentElement).append(style);
  document.body.append(root);
  let local;
  try { local = window.localStorage; } catch { /* Database errors will explain unavailable storage. */ }
  const gmGet = typeof GM_getValue === 'function' ? GM_getValue : undefined;
  const gmSet = typeof GM_setValue === 'function' ? GM_setValue : undefined;
  const repo = createRepository({ localStorage: local, gmGet, gmSet });
  const settings = createConfigStore({ localStorage: local, gmGet, gmSet, window });
  const player = createPlayerAdapter({ window, document });
  let snapshot = null, config, container, mask, dock, resizeObserver, mountAbort;
  let edit = false, peek = false, wheeling = false, captureBusy = false, initialized = false;
  let hideTimer, wheelTimer, saveTimer, toastTimer, frame, drag, configSeries;
  let countGeneration = 0, panelReturnFocus;
  let geometryDirty = false;
  const notification = el('div', 'bcm-notification'); notification.hidden = true;
  notification.setAttribute('role', 'status'); notification.setAttribute('aria-live', 'polite');
  root.append(notification);
  function notify(message, { kind = 'info', duration = kind === 'error' ? 7000 : 3000 } = {}) {
    notification.textContent = message; notification.dataset.kind = kind; notification.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { notification.hidden = true; }, duration);
  }
  const fail = error => notify(error?.message || '操作失败，请重试。', { kind: 'error' });
  const panel = el('section', 'bcm-panel'); panel.hidden = true; panel.inert = true;
  panel.setAttribute('aria-label', '遮罩与复习设置'); root.append(panel);
  function closePanel() {
    panel.hidden = true; panel.inert = true;
    if (panelReturnFocus?.isConnected) panelReturnFocus.focus();
    wakeDock();
  }
  function showPanel(title) {
    panelReturnFocus = document.activeElement; panel.replaceChildren(el('h2', '', title));
    panel.hidden = false; panel.inert = false; wakeDock();
  }
  function showHelp() {
    showPanel(`看剧学英语 v${VERSION}`);
    panel.append(el('p', '', '先遮中文听一遍；遇到难句收藏，再回到原片段复听。'));
    const list = el('dl');
    for (const [key, desc] of [
      ['Alt + S / S', '收藏当前画面与来源时间；关闭单字母快捷键后，仅 Alt 组合有效。'],
      ['Alt + B / B', '打开场景复习本，搜索、标记掌握或导出备份。'],
      ['Alt + 滚轮', '只在播放器内微调遮罩高度。'],
      ['悬停遮罩 / 按住 Alt', '临时看清中文，移开或松键恢复。'],
      ['Alt + Z / Shift + Z', '进入或退出拖动、拉伸模式。'],
      ['Alt + C / Shift + C', '开关中文字幕遮罩。'],
      ['循环复听', '以收藏点前后几秒为区间，完成后返回开始复习前的进度。'],
    ]) list.append(el('dt', '', key), el('dd', '', desc));
    panel.append(list, el('p', '', '收藏只保存在当前浏览器的本机数据中。建议定期在复习本导出 JSON 备份；HTML 用于离线阅读。'));
    const done = button('开始看剧', closePanel, 'bcm-primary'); panel.append(done); done.focus();
  }
  function showSettings() {
    if (!snapshot) return;
    config = settings.get(snapshot.identity.seriesId);
    showPanel('遮罩与复习设置');
    panel.append(el('p', '', `v${VERSION} · 位置按剧集记忆，其他偏好全局生效。`));
    const form = el('form'); const inputs = new Map();
    const add = (key, label, type, min, max, step) => {
      const row = el('label'); row.append(el('span', '', label));
      const input = el(type === 'select' ? 'select' : 'input'); input.name = key;
      if (type === 'select') {
        for (const [value, text] of [['blur', '羽化模糊'], ['solid', '不透明遮挡']]) { const opt = el('option', '', text); opt.value = value; input.append(opt); }
        input.value = config[key];
      } else {
        input.type = type;
        if (type === 'checkbox') input.checked = config[key];
        else { input.value = config[key]; input.min = min; input.max = max; input.step = step ?? 1; input.required = true; }
      }
      row.append(input); form.append(row); inputs.set(key, input);
    };
    add('mode', '遮挡方式', 'select'); add('blur', '模糊强度', 'number', 0, 40);
    add('singleKeys', '启用 S / B 单字母快捷键', 'checkbox');
    add('leadIn', '回听提前（秒）', 'number', 0, 30, .5);
    add('loopBefore', '循环向前（秒）', 'number', 0, 60, .5);
    add('loopAfter', '循环向后（秒）', 'number', .5, 60, .5);
    add('loopCount', '循环次数', 'number', 1, 20);
    add('loopGap', '循环间隔（秒）', 'number', 0, 10, .5);
    add('playbackRate', '复听倍速', 'number', .5, 2, .25);
    const actions = el('div', 'bcm-panel-actions');
    const submit = el('button', 'bcm-primary', '保存设置'); submit.type = 'submit';
    actions.append(submit, button('重置本剧位置', () => {
      try { config = settings.reset(snapshot.identity.seriesId); paint(); notify('本剧遮罩已恢复默认位置'); } catch (error) { fail(error); }
    }), button('关闭', closePanel));
    form.append(actions); form.addEventListener('submit', event => {
      event.preventDefault(); const patch = {};
      for (const [key, input] of inputs) patch[key] = input.type === 'checkbox' ? input.checked : input.tagName === 'SELECT' ? input.value : Number(input.value);
      if (patch.loopBefore + patch.loopAfter <= 0) { notify('循环区间需要大于 0 秒', { kind: 'error' }); return; }
      try { config = settings.patch(snapshot.identity.seriesId, patch); paint(); closePanel(); notify('设置已保存'); } catch (error) { fail(error); }
    });
    panel.append(form); inputs.get('mode').focus();
  }
  const loopbar = el('div', 'bcm-loopbar'); loopbar.hidden = true;
  const loopText = el('span'); root.append(loopbar);
  const review = createReviewController({ player, notify, onState(state) {
    loopbar.hidden = !state.active;
    loopText.textContent = `循环 ${state.iteration || 1} / ${state.count || 1} · ${formatTime(state.start)}–${formatTime(state.end)}`;
  } });
  loopbar.append(loopText, button('结束并返回', () => review.stop({ restore: true }).catch(fail)));
  const notebook = createNotebook({ repo, player, notify, version: VERSION, onChange: updateCount,
    getLeadIn: () => settings.get(snapshot?.identity.seriesId || 'global_default').leadIn,
    onHelp: showHelp, onSettings: showSettings, onLoop: async note => {
      config = settings.get(snapshot?.identity.seriesId || note.seriesId);
      await review.start(note, { before: config.loopBefore, after: config.loopAfter, count: config.loopCount, gap: config.loopGap, rate: config.playbackRate });
    },
  });
  root.append(notebook.element);

  async function updateCount() {
    const generation = ++countGeneration; const sid = snapshot?.identity.seriesId;
    if (!sid) return;
    try {
      const total = await repo.count(sid);
      if (generation === countGeneration && dock) dock.querySelector('[data-action="notebook"]').textContent = `复习本 ${total}`;
    } catch { /* Initial load/capture shows the actual error; never replace it with a fake count. */ }
  }
  function saveGeometry() {
    clearTimeout(saveTimer); saveTimer = null;
    if (!geometryDirty || !config || !configSeries) return;
    try {
      config = settings.patch(configSeries, { left: config.left, top: config.top, width: config.width, height: config.height });
      geometryDirty = false;
    } catch (error) { fail(error); }
  }
  function paint() {
    frame = null;
    if (!mask || !snapshot || !config) return;
    const rect = player.getVideoRect(); if (!rect) return;
    Object.assign(mask.style, {
      left: `${rect.left + rect.width * config.left / 100}px`,
      top: `${rect.top + rect.height * config.top / 100}px`,
      width: `${rect.width * config.width / 100}px`, height: `${rect.height * config.height / 100}px`,
    });
    mask.style.setProperty('--bcm-blur', `${config.blur}px`);
    mask.hidden = !config.enabled;
    for (const [name, active] of [['bcm-edit', edit], ['bcm-peek', peek], ['bcm-wheeling', wheeling], ['bcm-solid', config.mode === 'solid']]) mask.classList.toggle(name, active);
    if (dock) {
      dock.querySelector('[data-action="toggle"]').textContent = config.enabled ? '遮罩 开' : '遮罩 关';
      dock.querySelector('[data-action="edit"]').textContent = edit ? '完成调节' : '调节';
      dock.querySelector('[data-action="toggle"]').setAttribute('aria-pressed', String(config.enabled));
      dock.querySelector('[data-action="edit"]').setAttribute('aria-pressed', String(edit));
    }
  }
  function schedulePaint() { if (frame == null) frame = requestAnimationFrame(paint); }
  function wakeDock() {
    if (!dock) return;
    dock.classList.remove('bcm-idle'); clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (dock && !edit && !notebook.isOpen() && panel.hidden && !dock.matches(':hover,:focus-within')) dock.classList.add('bcm-idle');
    }, 2500);
  }
  function toggleEdit() {
    if (!snapshot) return; edit = !edit;
    if (edit && !config.enabled) config = settings.patch(configSeries, { enabled: true });
    paint(); wakeDock();
    notify(edit ? '拖动遮罩或边缘手柄调整，完成后点击「完成调节」' : '遮罩已锁定');
  }
  function toggleMask() { if (snapshot) { config = settings.patch(configSeries, { enabled: !config.enabled }); paint(); wakeDock(); } }
  async function capture() {
    if (captureBusy || !snapshot) return;
    captureBusy = true; const btn = dock?.querySelector('[data-action="capture"]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      let shot;
      try { shot = await player.capture(); }
      catch (error) {
        if (!['FRAME_UNAVAILABLE', 'CAPTURE_FAILED', 'CAPTURE_TIMEOUT'].includes(error.code)) throw error;
        const current = player.getCurrent(); const time = player.getTime();
        if (!current || time === null || !current.sourceReady) throw error;
        // An unavailable image must not erase the useful source bookmark.
        shot = { identity: current.identity, time, imageBlob: null };
      }
      const note = {
        id: `note_${crypto.randomUUID()}`, ...shot.identity, time: shot.time, timeStr: formatTime(shot.time),
        userNote: '', tags: [], reviewState: 'new', createdAt: Date.now(), updatedAt: Date.now(),
      };
      if (shot.imageBlob) note.imageBlob = shot.imageBlob;
      await repo.save(note);
      await updateCount(); if (notebook.isOpen()) await notebook.refresh();
      notify(shot.imageBlob ? `已收藏 ${note.timeStr} · 可在复习本回听` : `画面无法截取，已保存 ${note.timeStr} 的来源书签`, { kind: 'success' });
    } catch (error) { fail(error); }
    finally { captureBusy = false; if (btn?.isConnected) { btn.disabled = false; btn.textContent = '收藏此句'; } }
  }
  function cancelDrag(save = true) {
    if (!drag) return; const pointer = drag.pointerId; drag = null;
    try { if (mask?.hasPointerCapture(pointer)) mask.releasePointerCapture(pointer); } catch { /* Pointer already canceled. */ }
    if (save) saveGeometry();
  }
  function mount(current) {
    cancelDrag();
    mountAbort?.abort(); resizeObserver?.disconnect(); clearTimeout(hideTimer);
    mask?.remove(); dock?.remove(); mask = dock = null;
    if (container?.dataset.bcmPositionOwner === VERSION) {
      container.style.position = container.dataset.bcmPreviousPosition || ''; delete container.dataset.bcmPositionOwner; delete container.dataset.bcmPreviousPosition;
    }
    container = current?.container;
    if (!container) return;
    mountAbort = new AbortController(); const signal = mountAbort.signal;
    if (getComputedStyle(container).position === 'static') {
      container.dataset.bcmPreviousPosition = container.style.position; container.dataset.bcmPositionOwner = VERSION; container.style.position = 'relative';
    }
    mask = el('div', 'bcm-mask'); mask.setAttribute('aria-label', '中文字幕遮罩');
    const tools = el('div', 'bcm-mask-tools'); tools.append(el('span', '', '调整字幕区域'), button('完成', toggleEdit)); mask.append(tools);
    for (const pos of ['n','s','e','w','nw','ne','sw','se']) { const h = el('span', 'bcm-handle'); h.dataset.handle = pos; mask.append(h); }
    mask.addEventListener('dblclick', event => { event.stopPropagation(); toggleEdit(); }, { signal });
    mask.addEventListener('click', event => {
      event.stopPropagation();
      if (!edit && !event.target.closest('button')) {
        const media = player.getCurrent()?.media;
        if (media?.paused) media.play?.().catch(fail);
        else media?.pause?.();
      }
    }, { signal });
    mask.addEventListener('pointerdown', event => {
      if (!edit || event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault(); event.stopPropagation();
      const rect = player.getVideoRect(); if (!rect?.width || !rect?.height) return;
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, initial: { ...config }, handle: event.target.dataset.handle || '' };
      mask.setPointerCapture(event.pointerId);
    }, { signal });
    mask.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const dx = (event.clientX - drag.x) / drag.rect.width * 100, dy = (event.clientY - drag.y) / drag.rect.height * 100;
      let { left, top, width, height } = drag.initial;
      if (!drag.handle) { left = clamp(left + dx, 0, 100 - width); top = clamp(top + dy, 0, 100 - height); }
      else {
        if (drag.handle.includes('w')) { const next = clamp(left + dx, 0, left + width - 5); width += left - next; left = next; }
        if (drag.handle.includes('e')) width = clamp(width + dx, 5, 100 - left);
        if (drag.handle.includes('n')) { const next = clamp(top + dy, 0, top + height - 2); height += top - next; top = next; }
        if (drag.handle.includes('s')) height = clamp(height + dy, 2, 100 - top);
      }
      Object.assign(config, { left, top, width, height }); geometryDirty = true; schedulePaint();
    }, { signal });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) mask.addEventListener(type, () => cancelDrag(), { signal });
    dock = el('div', 'bcm-dock'); dock.setAttribute('role', 'toolbar'); dock.setAttribute('aria-label', `看剧学英语 v${VERSION}`);
    for (const [name, title, action] of [
      ['version', `v${VERSION}`, showSettings], ['toggle', '遮罩 开', toggleMask], ['edit', '调节', toggleEdit],
      ['capture', '收藏此句', capture], ['notebook', '复习本', () => notebook.toggle().catch(fail)], ['help', '帮助', showHelp],
    ]) {
      const b = button(title, () => { try { action(); } catch (error) { fail(error); } }, name === 'version' ? 'bcm-version-button' : '');
      b.dataset.action = name; dock.append(b);
    }
    container.append(mask, dock);
    container.addEventListener('pointermove', wakeDock, { signal, passive: true });
    container.addEventListener('pointerenter', wakeDock, { signal, passive: true });
    dock.addEventListener('focusin', wakeDock, { signal });
    if (window.ResizeObserver) { resizeObserver = new ResizeObserver(schedulePaint); resizeObserver.observe(container); if (current.media) resizeObserver.observe(current.media); }
    paint(); wakeDock(); updateCount();
  }
  function fullscreen() {
    const full = document.fullscreenElement;
    const parent = full && !['VIDEO', 'CANVAS', 'BWP-VIDEO'].includes(full.tagName) ? full : document.body;
    if (root.parentElement !== parent) parent.append(root);
    schedulePaint();
  }
  const unsubscribe = player.subscribe(current => {
    const prev = snapshot;
    if (current?.identity.seriesId !== configSeries) {
      if (drag || saveTimer) { cancelDrag(); saveGeometry(); }
      configSeries = current?.identity.seriesId;
      if (configSeries) config = settings.get(configSeries);
      edit = peek = wheeling = false;
    }
    snapshot = current;
    if (!current || current.container !== container || current.media !== prev?.media) mount(current);
    else paint();
    if (current?.identity.seriesId !== prev?.identity.seriesId) { updateCount(); if (notebook.isOpen()) notebook.refresh().catch(fail); }
    if (current && !initialized) {
      initialized = true;
      repo.ready().then(updateCount).catch(fail);
      player.resumePendingSeek().then(result => {
        if (result.resumed) { notify('已返回收藏片段'); player.getCurrent()?.media.play?.().catch(() => notify('已定位收藏片段，点击播放继续')); }
      }).catch(fail);
      try {
        if (!local?.getItem('bili_caption_welcome_v240')) {
          notify(`v${VERSION} 已就绪 · S 收藏，B 打开复习本；帮助中可查看全部操作`, { duration: 6000 });
          local?.setItem('bili_caption_welcome_v240', '1');
        }
      } catch { /* A welcome message never prevents viewing. */ }
    }
    fullscreen();
  });
  const events = new AbortController();
  window.addEventListener('wheel', event => {
    if (!snapshot || !event.altKey || event.ctrlKey || event.metaKey || !config.enabled || edit || editable(event.target) || !container.contains(event.target) || !event.deltaY) return;
    event.preventDefault(); event.stopImmediatePropagation();
    config.top = clamp(config.top + (event.deltaY > 0 ? .5 : -.5), 0, 100 - config.height);
    geometryDirty = true;
    wheeling = true; paint(); wakeDock(); clearTimeout(wheelTimer); clearTimeout(saveTimer);
    saveTimer = setTimeout(saveGeometry, 180);
    wheelTimer = setTimeout(() => { wheeling = false; paint(); }, 600);
  }, { capture: true, passive: false, signal: events.signal });
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (!panel.hidden) { event.stopPropagation(); closePanel(); }
      else if (notebook.isOpen()) { event.stopPropagation(); notebook.close().catch(fail); }
      else if (edit) { edit = false; cancelDrag(); paint(); }
      return;
    }
    if (!snapshot || editable(event.target) || event.isComposing || event.ctrlKey || event.metaKey) return;
    if (event.key === 'Alt') { peek = true; paint(); return; }
    if (event.repeat) return;
    const key = (event.code?.replace(/^Key/, '') || event.key).toUpperCase();
    const oneKey = config.singleKeys && !event.altKey && !event.shiftKey;
    let action;
    if ((event.altKey || oneKey) && key === 'S') action = capture;
    if ((event.altKey || oneKey) && key === 'B') action = () => notebook.toggle().catch(fail);
    if ((event.altKey || event.shiftKey) && key === 'C') action = toggleMask;
    if ((event.altKey || event.shiftKey) && key === 'Z') action = toggleEdit;
    if (action) { event.preventDefault(); event.stopImmediatePropagation(); try { action(); } catch (error) { fail(error); } wakeDock(); }
  }, { capture: true, signal: events.signal });
  window.addEventListener('keyup', event => { if (event.key === 'Alt') { peek = false; paint(); } }, { signal: events.signal });
  window.addEventListener('blur', () => { peek = false; cancelDrag(); paint(); }, { signal: events.signal });
  document.addEventListener('fullscreenchange', fullscreen, { signal: events.signal });
  window.addEventListener('resize', schedulePaint, { passive: true, signal: events.signal });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && snapshot) { config = settings.get(configSeries); paint(); } }, { signal: events.signal });
  window.addEventListener('pagehide', () => { saveGeometry(); }, { signal: events.signal });
  window.addEventListener('unload', () => {
    unsubscribe(); player.dispose(); review.dispose(); notebook.dispose(); settings.dispose(); repo.close();
    events.abort(); mountAbort?.abort(); resizeObserver?.disconnect();
    for (const timer of [hideTimer, wheelTimer, saveTimer, toastTimer]) clearTimeout(timer);
    if (frame != null) cancelAnimationFrame(frame);
  }, { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
