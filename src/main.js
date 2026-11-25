import { createRepository } from './storage.js';
import { createPlayerAdapter, formatTime } from './player.js';
import { createConfigStore } from './config.js';
import { createNotebook } from './notebook.js';
import { getDeepActiveElement, isEditableEvent as editable } from './editable.js';
import { DEFAULT_SHORTCUTS, SHORTCUT_ACTIONS, eventToShortcut, findShortcutConflict, formatShortcut, matchesPeekRelease } from './shortcuts.js';
import appStyles from './app.css';
import notebookStyles from './notebook.css';

const VERSION = __APP_VERSION__;
const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
const BUTTON_LIKE = 'button, a[href], summary, [role="button"], [role="link"]';
const SLIDER_LIKE = 'input[type="range"], [role="slider"]';
const SLIDER_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
function yieldsToFocusedControl(event, spec) {
  const selector = spec === 'Space' || spec === 'Enter' ? BUTTON_LIKE : SLIDER_KEYS.has(spec) ? SLIDER_LIKE : null;
  return selector && (getDeepActiveElement()?.closest?.(selector) ||
    event.composedPath().some(node => node.matches?.(selector)));
}
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
  function positionNotification() {
    if (notification.hidden) return;
    const viewport = root.getBoundingClientRect();
    const playerBox = container?.getBoundingClientRect();
    const inset = 8;
    if (playerBox && container.isConnected && getComputedStyle(container).visibility === 'visible') {
      const left = Math.max(playerBox.left, viewport.left);
      const right = Math.min(playerBox.right, viewport.right);
      const top = Math.max(playerBox.top, viewport.top);
      const bottom = Math.min(playerBox.bottom, viewport.bottom);
      if (right - left > 32 && bottom - top > 32) {
        notification.style.setProperty('--bcm-toast-max-width', `${right - left - inset * 2}px`);
        const { width, height } = notification.getBoundingClientRect();
        const center = clamp(playerBox.left + playerBox.width / 2, left + width / 2 + inset, right - width / 2 - inset);
        const topLimit = Math.max(top, bottom - height - inset);
        notification.style.left = `${center - viewport.left}px`;
        notification.style.top = `${clamp(playerBox.top + 56, top, topLimit) - viewport.top}px`;
        return;
      }
    }
    notification.style.removeProperty('--bcm-toast-max-width');
    notification.style.removeProperty('left');
    notification.style.removeProperty('top');
  }
  function notify(message, { kind = 'info', duration = kind === 'error' ? 7000 : 3000 } = {}) {
    notification.textContent = message; notification.dataset.kind = kind; notification.hidden = false;
    positionNotification();
    notification.getAnimations().forEach(animation => animation.cancel());
    if (duration === 1600 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      notification.animate([{ opacity: 1, offset: 0 }, { opacity: 1, offset: .88 }, { opacity: 0 }], duration);
    }
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { notification.hidden = true; }, duration);
  }
  const fail = error => notify(error?.message || '操作失败，请重试。', { kind: 'error' });
  const panel = el('section', 'bcm-panel'); panel.hidden = true; panel.inert = true;
  root.append(panel);
  function closePanel() {
    panel.hidden = true; panel.inert = true;
    if (panelReturnFocus?.isConnected) panelReturnFocus.focus();
    wakeDock();
  }
  function showPanel(title) {
    panelReturnFocus = getDeepActiveElement(); panel.replaceChildren(el('h2', '', title));
    panel.setAttribute('aria-label', title);
    panel.hidden = false; panel.inert = false; wakeDock();
  }
  function showHelp() {
    const shortcuts = settings.get(snapshot?.identity.seriesId).shortcuts;
    showPanel('操作帮助');
    const captureHint = shortcuts.capture ? `按 ${formatShortcut(shortcuts.capture)}` : '点击「记录」';
    panel.append(el('p', '', `看剧时${captureHint}即可静默记录。看完一集，打开记录库回听、写备注，再导出 JSON 或 Markdown。`));
    const list = el('dl');
    for (const { id, label } of SHORTCUT_ACTIONS) {
      const description = el('dd');
      description.append(el('kbd', '', formatShortcut(shortcuts[id])));
      if (id === 'peek') description.append(' 也可悬停在遮罩上');
      list.append(el('dt', '', label), description);
    }
    list.append(el('dt', '', '微调遮罩高度'), el('dd', '', '在播放器内按 Alt + 滚轮'));
    panel.append(list, el('p', '', '记录保存在当前浏览器。JSON 含截图并可重新导入，Markdown 用于整理文字，HTML 可离线查看截图和备注。'));
    const done = button('关闭', closePanel, 'bcm-primary'); panel.append(done); done.focus();
  }
  function showSettings() {
    if (!snapshot) return;
    config = settings.get(snapshot.identity.seriesId);
    showPanel('设置');
    panel.append(el('p', '', '遮罩位置按剧集保存，其他设置全局生效。'));
    const form = el('form'); const inputs = new Map();
    const add = (key, label, type, min, max, step) => {
      const row = el('label'); row.append(el('span', '', label));
      const input = el(type === 'select' ? 'select' : 'input'); input.name = key;
      if (type === 'select') {
        for (const [value, text] of [['blur', '羽化模糊'], ['solid', '不透明遮挡']]) { const opt = el('option', '', text); opt.value = value; input.append(opt); }
        input.value = config[key];
      } else {
        input.type = type;
        input.value = config[key]; input.min = min; input.max = max; input.step = step ?? 1; input.required = true;
      }
      row.append(input); form.append(row); inputs.set(key, input);
    };
    add('mode', '遮挡方式', 'select'); add('blur', '模糊强度', 'number', 0, 40);
    const shortcutDrafts = { ...DEFAULT_SHORTCUTS, ...(config.shortcuts || {}) };
    const shortcutInputs = new Map();
    const shortcutSection = el('fieldset', 'bcm-shortcut-section');
    const shortcutHeader = el('div', 'bcm-shortcut-header');
    shortcutSection.append(el('legend', '', '快捷键'));
    shortcutHeader.append(el('p', 'bcm-shortcut-hint', '点击按键框录入，按 Esc 取消。'), button('恢复默认快捷键', () => {
      Object.assign(shortcutDrafts, DEFAULT_SHORTCUTS);
      for (const action of SHORTCUT_ACTIONS) {
        const input = shortcutInputs.get(action.id);
        if (input) input.value = formatShortcut(shortcutDrafts[action.id]);
      }
    }, 'bcm-shortcut-reset'));
    shortcutSection.append(shortcutHeader);
    for (const action of SHORTCUT_ACTIONS) {
      const row = el('div', 'bcm-shortcut-row');
      const id = `bcm-shortcut-${action.id}`;
      const label = el('label', 'bcm-shortcut-label', action.label);
      label.htmlFor = id;
      const control = el('div', 'bcm-shortcut-control');
      const input = el('input', 'bcm-shortcut-input');
      input.id = id;
      input.type = 'text';
      input.readOnly = true;
      input.dataset.shortcutAction = action.id;
      input.setAttribute('aria-label', `${action.label}快捷键`);
      input.value = formatShortcut(shortcutDrafts[action.id]);
      let pendingModifier = null;
      input.addEventListener('focus', () => {
        pendingModifier = null;
        input.dataset.recording = 'true';
        input.value = '请按下快捷键…';
      });
      input.addEventListener('blur', () => {
        delete input.dataset.recording;
        input.value = formatShortcut(shortcutDrafts[action.id]);
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') { input.blur(); return; }
        if (event.isComposing || event.repeat) return;
        const spec = eventToShortcut(event, { allowModifierOnly: action.allowModifierOnly });
        if (!spec) return;
        if (action.allowModifierOnly && ['Alt', 'Shift', 'Ctrl'].includes(spec)) {
          pendingModifier = spec;
          input.value = formatShortcut(spec);
        } else {
          pendingModifier = null;
          shortcutDrafts[action.id] = spec;
          input.blur();
        }
      });
      input.addEventListener('keyup', event => {
        if (pendingModifier && matchesPeekRelease(event, pendingModifier) && input.dataset.recording === 'true') {
          event.preventDefault();
          event.stopPropagation();
          shortcutDrafts[action.id] = pendingModifier;
          pendingModifier = null;
          input.blur();
        }
      });
      const clearBtn = button('禁用', () => {
        shortcutDrafts[action.id] = '';
        input.value = formatShortcut('');
      }, 'bcm-shortcut-clear');
      clearBtn.setAttribute('aria-label', `禁用${action.label}快捷键`);
      control.append(input, clearBtn);
      row.append(label, control);
      shortcutSection.append(row);
      shortcutInputs.set(action.id, input);
    }
    form.append(shortcutSection);
    const actions = el('div', 'bcm-panel-actions');
    const submit = el('button', 'bcm-primary', '保存设置'); submit.type = 'submit';
    actions.append(submit, button('重置本剧位置', () => {
      try { config = settings.reset(snapshot.identity.seriesId); paint(); notify('本剧遮罩已恢复默认位置'); } catch (error) { fail(error); }
    }), button('关闭', closePanel));
    form.append(actions); form.addEventListener('submit', event => {
      event.preventDefault(); const patch = {};
      for (const [key, input] of inputs) patch[key] = input.tagName === 'SELECT' ? input.value : Number(input.value);
      const conflict = findShortcutConflict(shortcutDrafts);
      if (conflict) {
        notify(`快捷键冲突：「${conflict.first.label}」与「${conflict.second.label}」不能同为 ${formatShortcut(conflict.shortcut)}`, { kind: 'error' });
        return;
      }
      patch.shortcuts = { ...shortcutDrafts };
      try { config = settings.patch(snapshot.identity.seriesId, patch); peek = false; paint(); closePanel(); notify('设置已保存'); } catch (error) { fail(error); }
    });
    panel.append(form); inputs.get('mode').focus();
  }
  const notebook = createNotebook({ repo, player, notify, version: VERSION, onChange: updateCount,
    onHelp: showHelp, onSettings: showSettings });
  root.append(notebook.element);

  async function updateCount() {
    const generation = ++countGeneration; const sid = snapshot?.identity.seriesId;
    if (!sid) return;
    try {
      const total = await repo.count(sid);
      if (generation === countGeneration && dock) dock.querySelector('[data-action="notebook"]').textContent = `记录库 ${total}`;
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
    positionNotification();
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
    captureBusy = true;
    try {
      const current = player.getCurrent(); const time = player.getTime();
      let shot;
      try { shot = await player.capture(); }
      catch (error) {
        if (!['FRAME_UNAVAILABLE', 'CAPTURE_FAILED', 'CAPTURE_TIMEOUT'].includes(error.code)) throw error;
        if (!current || time === null || !current.sourceReady) throw error;
        // An unavailable image must not erase the useful source bookmark.
        shot = { identity: current.identity, time, imageBlob: null };
      }
      const note = {
        id: `note_${crypto.randomUUID()}`, ...shot.identity, time: shot.time, timeStr: formatTime(shot.time),
        userNote: '', createdAt: Date.now(),
      };
      if (shot.imageBlob) note.imageBlob = shot.imageBlob;
      await repo.save(note);
      notify(shot.imageBlob ? `已记录 ${note.timeStr}` : `已记录 ${note.timeStr}，截图不可用`, { kind: 'success', duration: 1600 });
      void updateCount();
      if (notebook.isOpen()) void notebook.refresh();
    } catch (error) { fail(error); }
    finally { captureBusy = false; }
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
    mask = el('div', 'bcm-mask bcm-theme'); mask.setAttribute('aria-label', '中文字幕遮罩');
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
    dock = el('div', 'bcm-dock bcm-theme'); dock.setAttribute('role', 'toolbar'); dock.setAttribute('aria-label', `看剧学英语 v${VERSION}`);
    for (const [name, title, action] of [
      ['version', `v${VERSION}`, showSettings], ['toggle', '遮罩 开', toggleMask], ['edit', '调节', toggleEdit],
      ['capture', '记录', capture], ['notebook', '记录库', () => notebook.toggle().catch(fail)], ['help', '帮助', showHelp],
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
    if (current?.identity.seriesId !== prev?.identity.seriesId) {
      dock?.querySelector('[data-action="notebook"]').replaceChildren('记录库');
      updateCount();
    }
    if (current?.identity.seriesId !== prev?.identity.seriesId ||
        current?.identity.source.sourceId !== prev?.identity.source.sourceId) notebook.refreshSource();
    if (current && !initialized) {
      initialized = true;
      repo.ready().then(updateCount).catch(fail);
      player.resumePendingSeek().then(result => {
        if (result.resumed) { notify('已定位记录片段'); player.getCurrent()?.media.play?.().catch(() => notify('已定位记录片段，点击播放继续')); }
      }).catch(fail);
    }
    fullscreen();
  });
  const events = new AbortController();
  window.addEventListener('wheel', event => {
    if (!snapshot || !panel.hidden || !event.altKey || event.ctrlKey || event.metaKey || !config.enabled || edit || editable(event) || !container.contains(event.target) || !event.deltaY) return;
    event.preventDefault(); event.stopImmediatePropagation();
    config.top = clamp(config.top + (event.deltaY > 0 ? .5 : -.5), 0, 100 - config.height);
    geometryDirty = true;
    wheeling = true; paint(); wakeDock(); clearTimeout(wheelTimer); clearTimeout(saveTimer);
    saveTimer = setTimeout(saveGeometry, 180);
    wheelTimer = setTimeout(() => { wheeling = false; paint(); }, 600);
  }, { capture: true, passive: false, signal: events.signal });
  window.addEventListener('keydown', event => {
    if (event.target?.dataset?.shortcutAction) return;
    if (event.key === 'Escape') {
      if (!panel.hidden) { event.stopPropagation(); closePanel(); }
      else if (notebook.isOpen()) { event.stopPropagation(); notebook.close().catch(fail); }
      else if (edit) { edit = false; cancelDrag(); paint(); }
      return;
    }
    if (!snapshot || !panel.hidden || editable(event) || event.isComposing) return;
    const spec = eventToShortcut(event, { allowModifierOnly: true });
    if (!spec || yieldsToFocusedControl(event, spec)) return;
    const shortcuts = config.shortcuts || DEFAULT_SHORTCUTS;
    if (spec === shortcuts.peek) {
      if (!peek) { peek = true; paint(); }
      if (!['Alt', 'Shift', 'Ctrl'].includes(shortcuts.peek)) { event.preventDefault(); event.stopImmediatePropagation(); }
      return;
    }
    if (event.repeat) return;
    let action;
    if (spec === shortcuts.capture) action = capture;
    else if (spec === shortcuts.notebook) action = () => notebook.toggle().catch(fail);
    else if (spec === shortcuts.toggleMask) action = toggleMask;
    else if (spec === shortcuts.editMask) action = toggleEdit;
    if (action) {
      event.preventDefault(); event.stopImmediatePropagation();
      try { action(); } catch (error) { fail(error); }
      if (action !== capture) wakeDock();
    }
  }, { capture: true, signal: events.signal });
  window.addEventListener('keyup', event => {
    if (peek && matchesPeekRelease(event, config?.shortcuts?.peek ?? DEFAULT_SHORTCUTS.peek)) { peek = false; paint(); }
  }, { signal: events.signal });
  window.addEventListener('blur', () => { peek = false; cancelDrag(); paint(); }, { signal: events.signal });
  document.addEventListener('fullscreenchange', fullscreen, { signal: events.signal });
  window.addEventListener('resize', schedulePaint, { passive: true, signal: events.signal });
  window.addEventListener('scroll', () => {
    if (!notification.hidden) schedulePaint();
  }, { capture: true, passive: true, signal: events.signal });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && snapshot) {
      config = settings.get(configSeries); peek = false; paint(); updateCount();
      if (notebook.isOpen()) void notebook.refresh();
    }
  }, { signal: events.signal });
  window.addEventListener('pagehide', () => { saveGeometry(); }, { signal: events.signal });
  window.addEventListener('unload', () => {
    unsubscribe(); player.dispose(); notebook.dispose(); settings.dispose(); repo.close();
    events.abort(); mountAbort?.abort(); resizeObserver?.disconnect();
    for (const timer of [hideTimer, wheelTimer, saveTimer, toastTimer]) clearTimeout(timer);
    if (frame != null) cancelAnimationFrame(frame);
  }, { once: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
