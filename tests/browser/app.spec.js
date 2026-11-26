import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';

const origin = 'https://www.bilibili.com';
const url = `${origin}/video/BV1xx411c7mD/`;
const fixture = await readFile(new URL('../fixtures/player.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../../bilibili-caption-blur-mask.user.js', import.meta.url), 'utf8');
async function boot(page) {
  await page.route(`${origin}/**`, route => route.fulfill({
    status: 200, contentType: route.request().url().includes('/__bcm__/bundle.js') ? 'text/javascript' : 'text/html',
    body: route.request().url().includes('/__bcm__/bundle.js') ? script : fixture,
  }));
  await page.goto(url);
  await expect(page.locator('#bcm-app')).toHaveAttribute('data-version', '3.1.1');
  await expect(page.locator('.bcm-dock')).toBeVisible();
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
}
async function dockClick(page, action) {
  await page.locator('.bpx-player-video-wrap').hover({ position: { x: 8, y: 8 } });
  await page.locator(`.bcm-dock [data-action="${action}"]`).click();
}
async function captureAndOpen(page) { await dockClick(page,'capture');await expect(page.locator('.bcm-notification')).toContainText('已记录');await dockClick(page,'notebook');await expect(page.locator('.bcm-note')).toHaveCount(1); }

async function downloadFile(page, format) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: `导出 ${format}`, exact: true }).click();
  const download = await pending;
  return { path: await download.path(), filename: download.suggestedFilename() };
}

test('capture, safely edit, reload, search, delete and undo retain a committed image note', async ({ page }) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await boot(page);await captureAndOpen(page);
  const input=page.locator('.bcm-note-input');
  await input.fill('<b>literal markup</b> tomorrow');
  await page.getByRole('button',{name:'关闭记录库',exact:true}).click();
  // The notebook hides only after its drafts commit; reloading sooner abandons the write.
  await expect(page.locator('.bcm-notebook')).toBeHidden();
  await page.reload();await dockClick(page,'notebook');
  await expect(input).toHaveValue('<b>literal markup</b> tomorrow');
  await expect(page.locator('.bcm-note b')).toHaveCount(0);
  await page.getByRole('searchbox',{name:'搜索记录'}).fill('tomorrow');
  await expect(page.locator('.bcm-note')).toHaveCount(1);
  await expect(page.locator('.bcm-note img')).toBeVisible();
  await page.getByRole('button',{name:/删除 .* 的记录/}).click();
  await expect(page.locator('.bcm-note')).toHaveCount(0);
  await page.getByRole('button',{name:'撤销删除',exact:true}).click();
  await expect(page.locator('.bcm-note')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('real IndexedDB backup downloads and imports into a fresh browser context', async ({ page, browser }) => {
  await boot(page);await captureAndOpen(page);
  const { path } = await downloadFile(page, 'JSON');
  const data=JSON.parse(await readFile(path,'utf8'));expect(data.notes).toHaveLength(1);expect(data.notes[0].imageUrl).toMatch(/^data:image\/jpeg/);
  const context=await browser.newContext();const target=await context.newPage();await boot(target);await dockClick(target,'notebook');
  await target.locator('.bcm-notebook input[type=file]').setInputFiles(path);
  await expect(target.getByRole('region',{name:'备份导入预览'})).toBeVisible();
  await expect(target.locator('.bcm-note')).toHaveCount(0);
  await target.getByRole('button',{name:'确认导入',exact:true}).click();
  await expect(target.locator('.bcm-note')).toHaveCount(1);
  await context.close();
});

test('scopes update across parts and all three formats download the requested records', async ({ page }) => {
  await boot(page);
  await captureAndOpen(page);
  await expect(page.locator('.bcm-tag-series')).toHaveText('英语练习片段');
  await expect(page.locator('.bcm-tag-episode')).toHaveText('第一段');
  await page.locator('.bcm-note-input').fill('thumb through');
  await page.getByRole('button', { name: '关闭记录库' }).click();
  await expect(page.locator('.bcm-notebook')).toBeHidden();
  await page.goto(`${origin}/video/BV1Q541167Qg/`);
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
  await dockClick(page, 'capture');
  await expect(page.locator('.bcm-notification')).toContainText('已记录');
  await page.goto(url);
  await dockClick(page, 'notebook');
  const summary = page.locator('.bcm-result-summary');
  await expect(summary).toHaveText('本集共 1 条记录');
  await page.getByRole('button', { name: '下一 P', exact: true }).evaluate(button => button.click());
  await expect(summary).toHaveText('本集共 0 条记录');
  await page.getByRole('button', { name: '关闭记录库' }).click();
  await dockClick(page, 'capture');
  await dockClick(page, 'notebook');
  await expect(page.locator('.bcm-tag-episode')).toHaveText('第二段');

  const scope = page.getByRole('combobox', { name: '记录范围' });
  const json = await downloadFile(page, 'JSON');
  expect(json.filename).toMatch(/当前本集.*\.json$/);
  const backup = JSON.parse(await readFile(json.path, 'utf8'));
  expect(backup.notes).toHaveLength(1);
  expect(backup.notes[0].imageUrl).toMatch(/^data:image\/jpeg;base64,/);
  expect(backup.notes[0].timestampUrl).toBe(`${url}?p=2&t=42`);

  await scope.selectOption('series');
  await expect(summary).toHaveText('本剧共 2 条记录');
  const markdown = await downloadFile(page, 'Markdown');
  expect(markdown.filename).toMatch(/当前整部剧.*\.md$/);
  const memo = await readFile(markdown.path, 'utf8');
  expect(memo).toContain('## 英语练习片段');
  expect(memo).toContain('### 第一段');
  expect(memo).toContain('### 第二段');
  expect(memo).toContain('thumb through');
  expect(memo).toContain(`${url}?t=42`);
  expect(memo).not.toContain('base64');

  await scope.selectOption('all');
  await expect(summary).toHaveText('全部共 3 条记录');
  const html = await downloadFile(page, 'HTML');
  expect(html.filename).toMatch(/全部记录.*\.html$/);
  const offline = await page.context().newPage();
  await offline.setContent(await readFile(html.path, 'utf8'));
  await expect(offline.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(offline.locator('article')).toHaveCount(3);
  await expect(offline.locator('img')).toHaveCount(3);
  await expect(offline.getByText('thumb through')).toBeVisible();
  await offline.close();

  await scope.selectOption('series');
  await page.getByRole('searchbox', { name: '搜索记录' }).fill('第一段');
  await expect(summary).toHaveText('本剧共 2 条记录 · 匹配 1 条');
  await page.getByRole('button', { name: '00:42 · 回听此句' }).click();
  await expect(page).toHaveURL(url);
  await expect.poll(()=>page.evaluate(()=>window.fixture.time)).toBe(40);
});

test('native fullscreen retains shortcut access while its button is focused', async ({page}) => {
  await boot(page);
  const fullscreenButton = page.getByRole('button', { name: '进入播放器全屏' });
  await fullscreenButton.click();
  await expect(fullscreenButton).toBeFocused();
  await page.keyboard.press('c');
  await expect(page.locator('.bcm-notification')).toHaveText('已记录 00:42');
  await page.keyboard.press('Alt+b');await expect(page.locator('.bcm-notebook')).toBeVisible();
  expect(await page.evaluate(()=>document.fullscreenElement.contains(document.querySelector('#bcm-app')))).toBe(true);
  await page.keyboard.press('Escape');await expect(page.locator('.bcm-notebook')).toBeHidden();
  expect(await page.locator('.bcm-notebook').evaluate(node=>node.inert)).toBe(true);
  await expect(fullscreenButton).toBeFocused();
});

test('defaults keep working on the progress slider and after focus returns to the toolbar', async ({ page }) => {
  await boot(page);
  const slider = page.getByRole('slider', { name: '播放进度' });
  await slider.focus();
  await expect(slider).toBeFocused();
  const mask = page.locator('.bcm-mask');
  await page.keyboard.down('Alt');
  await expect(mask).toHaveClass(/bcm-peek/);
  await page.keyboard.up('Alt');
  await expect(mask).not.toHaveClass(/bcm-peek/);
  await page.keyboard.press('Alt+a');
  await expect(mask).toBeHidden();
  await page.keyboard.press('Alt+a');
  await expect(mask).toBeVisible();
  await page.keyboard.press('Alt+z');
  await expect(mask).toHaveClass(/bcm-edit/);
  await page.keyboard.press('Alt+z');
  await expect(mask).not.toHaveClass(/bcm-edit/);

  const playback = () => page.evaluate(() => [document.querySelector('video').paused, window.fixture.pauses, window.fixture.plays]);
  const before = await playback();
  await page.keyboard.press('c');
  const toast = page.locator('.bcm-notification');
  await expect(toast).toHaveText('已记录 00:42');
  await expect(toast).toHaveCSS('pointer-events', 'none');
  const player = page.locator('.bpx-player-video-wrap');
  const playerBounds = await player.boundingBox();
  const toastBounds = await toast.boundingBox();
  expect(toastBounds.y - playerBounds.y).toBeCloseTo(56, 0);
  expect(toastBounds.x + toastBounds.width / 2).toBeCloseTo(playerBounds.x + playerBounds.width / 2, 0);
  expect(toastBounds.y + toastBounds.height).toBeLessThan(playerBounds.y + playerBounds.height);
  await expect(page.locator('[data-action=notebook]')).toHaveText('记录库 1');
  await expect(page.locator('.bcm-notebook')).toBeHidden();
  await expect(page.locator('.bcm-panel')).toBeHidden();
  expect(await playback()).toEqual(before);
  await expect(toast).toBeHidden({ timeout: 2500 });
  await page.keyboard.press('Alt+b');
  await expect(page.locator('.bcm-notebook')).toBeVisible();
  await page.keyboard.press('Alt+b');
  await expect(page.locator('.bcm-notebook')).toBeHidden();
  await expect(slider).toBeFocused();
  await dockClick(page, 'notebook');
  await page.getByRole('button', { name: '关闭记录库' }).click();
  await expect(page.locator('[data-action="notebook"]')).toBeFocused();
  await page.keyboard.press('c');
  await expect(page.locator('[data-action="notebook"]')).toHaveText('记录库 2');
  await page.keyboard.press('Alt+b');
  await expect(page.locator('.bcm-note')).toHaveCount(2);
});

test('custom Space and arrow shortcuts yield to focused controls and work on the player container', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('bili_caption_mask_v240_global',
    JSON.stringify({ shortcuts: { capture: 'Space', toggleMask: 'ArrowRight' } })));
  await boot(page);
  const play = page.getByRole('button', { name: '播放 / 暂停' });
  const mask = page.locator('.bcm-mask');
  await play.focus();
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => window.fixture.pauses)).toBe(1);
  await expect(page.locator('[data-action="notebook"]')).toHaveText('记录库 0');
  const slider = page.getByRole('slider', { name: '播放进度' });
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveValue('43');
  await expect(mask).toBeVisible();

  await page.locator('.bpx-player-video-wrap').focus();
  await page.keyboard.press('ArrowRight');
  await expect(mask).toBeHidden();
  await page.keyboard.press('Space');
  await expect(page.locator('[data-action="notebook"]')).toHaveText('记录库 1');
});

test('empty episode and search results do not download files', async ({ page }) => {
  await boot(page);
  const downloads = [];
  page.on('download', download => downloads.push(download.suggestedFilename()));
  await dockClick(page, 'notebook');
  await expect(page.locator('.bcm-result-summary')).toHaveText('本集共 0 条记录');
  const notice = page.locator('.bcm-notices');
  for (const format of ['JSON', 'Markdown', 'HTML']) {
    const exportButton = page.getByRole('button', { name: `导出 ${format}` });
    await exportButton.click();
    await expect(exportButton).toBeEnabled();
    await expect(notice.getByText('当前范围没有可导出的记录。', { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '关闭记录库' }).click();
  await page.keyboard.press('c');
  await expect(page.locator('[data-action="notebook"]')).toHaveText('记录库 1');
  await page.keyboard.press('Alt+b');
  await page.getByRole('searchbox', { name: '搜索记录' }).fill('未出现的词');
  await expect(page.locator('.bcm-result-summary')).toHaveText('本集共 1 条记录 · 匹配 0 条');
  await page.getByRole('button', { name: '导出 Markdown' }).click();
  await expect(notice.getByText('当前范围没有可导出的记录。', { exact: true })).toBeVisible();
  expect(downloads).toEqual([]);
});

test('input focus and repeated keydown do not create duplicate captures; outside wheel is preserved', async ({page}) => {
  await boot(page);await page.getByRole('textbox',{name:'评论',exact:true}).fill('ccccc');
  await page.keyboard.press('c');
  const outside=await page.evaluate(()=>{const e=new WheelEvent('wheel',{bubbles:true,cancelable:true,altKey:true,deltaY:10});document.querySelector('.outside').dispatchEvent(e);return e.defaultPrevented;});
  expect(outside).toBe(false);
  await page.getByRole('button', { name: '播放 / 暂停' }).focus();
  await page.evaluate(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'c',code:'KeyC',repeat:true,bubbles:true,cancelable:true}));});
  await dockClick(page,'notebook');await expect(page.locator('.bcm-note')).toHaveCount(0);
  await page.getByRole('button',{name:'关闭记录库',exact:true}).click();
  await expect(page.locator('[data-action="notebook"]')).toBeFocused();
  await page.keyboard.press('c');
  await expect(page.locator('.bcm-notification')).toContainText('已记录');await dockClick(page,'notebook');await expect(page.locator('.bcm-note')).toHaveCount(1);
});

test('same-container navigation applies each video mask position immediately',async({page})=>{
  await boot(page);
  await page.evaluate(()=>{
    localStorage.setItem('bili_caption_mask_v200_cfg',JSON.stringify({global:{enabled:true,left:15,top:84,width:70,height:7.2},series:{bv_BV1xx411c7mD:{left:15,top:60,width:70,height:7.2},bv_BV1Q541167Qg:{left:15,top:30,width:70,height:7.2}}}));
  });
  await page.reload();const before=await page.locator('.bcm-mask').evaluate(el=>parseFloat(el.style.top));
  await page.evaluate(()=>{history.pushState({},'','/video/BV1Q541167Qg/');document.querySelector('video').dispatchEvent(new Event('loadedmetadata'));});
  await expect.poll(()=>page.locator('.bcm-mask').evaluate(el=>parseFloat(el.style.top))).toBeLessThan(before-80);
});

test('desktop and narrow layouts keep controls inside the viewport',async({page})=>{
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await boot(page);
  const dock = page.locator('.bcm-dock');
  await expect(dock).toHaveCSS('right', '176px');
  await expect(dock).toHaveCSS('z-index', '100');
  const dockBounds = await dock.boundingBox();
  const nativeBounds = await page.locator('.native-actions').boundingBox();
  expect(dockBounds.x + dockBounds.width).toBeLessThan(nativeBounds.x);
  await mkdir('artifacts',{recursive:true});
  await dockClick(page, 'help');
  await expect(page.locator('.bcm-panel')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.bcm-panel')).toContainText('Alt + 滚轮');
  await page.keyboard.press('Escape');
  await dockClick(page, 'capture');
  await expect(page.locator('.bcm-notification')).toHaveText('已记录 00:42');
  await page.screenshot({path:'artifacts/v3.1.1-desktop-player.png'});
  await dockClick(page, 'notebook');
  await expect(page.locator('.bcm-note-image')).toBeVisible();
  await expect(page.locator('.bcm-notification')).toBeHidden();
  await page.screenshot({path:'artifacts/v3.1.1-desktop.png'});
  await page.setViewportSize({width:390,height:780});
  const notebook = page.locator('.bcm-notebook');
  await expect(notebook).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(dock).toHaveCSS('top', '48px');
  expect(await notebook.evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(false);
  expect(await notebook.locator('.bcm-notebook-scroll').evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(false);
  await page.screenshot({path:'artifacts/v3.1.1-narrow.png'});
  await notebook.getByRole('button', { name: '设置' }).click();
  const panel = page.locator('.bcm-panel');
  await expect(panel).toHaveCSS('color-scheme', 'light');
  expect(await panel.evaluate(el => el.scrollWidth > el.clientWidth + 1)).toBe(false);
  await page.screenshot({path:'artifacts/v3.1.1-narrow-settings.png'});
  expect(errors).toEqual([]);
});

test('a rejected IndexedDB write never announces success or leaves a phantom card',async({page})=>{
  await boot(page);
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='notes')throw new DOMException('Test quota failure','QuotaExceededError');return original.apply(this,args);};
  });
  await dockClick(page,'capture');
  await expect(page.locator('.bcm-notification')).toHaveAttribute('data-kind','error');
  await expect(page.locator('.bcm-notification')).not.toContainText('已记录');
  await dockClick(page,'notebook');await expect(page.locator('.bcm-note')).toHaveCount(0);
});

test('plain and plaintext-only contenteditable fields keep single-letter typing',async({page})=>{
  await boot(page);
  await page.evaluate(()=>{for(const value of ['', 'plaintext-only']){const input=document.createElement('div');input.setAttribute('contenteditable',value);input.setAttribute('aria-label',value||'plain');input.textContent='edit here';document.querySelector('.outside').append(input);}});
  for(const selector of ['[aria-label="plain"]','[contenteditable="plaintext-only"]']){await page.locator(selector).click();await page.keyboard.type('ccc');}
  await dockClick(page,'notebook');await expect(page.locator('.bcm-note')).toHaveCount(0);
});

test('typing inside shadow DOM comment box and reply box does not trigger shortcuts', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => {
    class MockComments extends HTMLElement {
      constructor() {
        super();
        const root = this.attachShadow({ mode: 'open' });
        const box = document.createElement('bili-comment-box');
        const boxRoot = box.attachShadow({ mode: 'open' });
        const editor = document.createElement('div');
        editor.className = 'ProseMirror';
        editor.setAttribute('contenteditable', 'true');
        editor.setAttribute('role', 'textbox');
        editor.textContent = '发一条友善的评论';
        boxRoot.append(editor);
        root.append(box);

        const reply = document.createElement('bili-comment-reply-box');
        const replyRoot = reply.attachShadow({ mode: 'open' });
        const replyEditor = document.createElement('div');
        replyEditor.className = 'reply-box-textarea';
        replyEditor.setAttribute('contenteditable', 'plaintext-only');
        replyEditor.textContent = '回复评论';
        replyRoot.append(replyEditor);
        root.append(reply);
      }
    }
    customElements.define('bili-comments', MockComments);
    document.querySelector('.outside').append(document.createElement('bili-comments'));
  });

  const mainEditor = page.locator('bili-comments').locator('bili-comment-box').locator('.ProseMirror');
  await mainEditor.click();
  await page.keyboard.type('cccc');

  const replyEditor = page.locator('bili-comments').locator('bili-comment-reply-box').locator('.reply-box-textarea');
  await replyEditor.click();
  await page.keyboard.type('cccc');

  await expect(page.locator('.bcm-notification')).not.toContainText('已记录');
  await expect(page.locator('.bcm-notebook')).toBeHidden();
  await dockClick(page, 'notebook');
  await expect(page.locator('.bcm-note')).toHaveCount(0);
});

test('custom shortcuts can be recorded, conflict-checked, disabled, persisted and used', async ({ page }) => {
  await boot(page);
  await dockClick(page, 'version');
  await expect(page.locator('.bcm-panel')).toBeVisible();

  const captureKey = page.getByLabel('一键记录此句快捷键', { exact: true });
  await captureKey.click();
  await expect(captureKey).toHaveValue('请按下快捷键…');
  await page.keyboard.press('Control+Shift+KeyK');
  await expect(captureKey).toHaveValue('Ctrl + Shift + K');

  // Recording the same shortcut on another global action must be blocked on save.
  const notebookKey = page.getByLabel('开关记录库快捷键', { exact: true });
  await notebookKey.click();
  await page.keyboard.press('Control+Shift+KeyK');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.bcm-notification')).toContainText('快捷键冲突');
  await expect(page.locator('.bcm-panel')).toBeVisible();

  // Fix the conflict, disable edit and customize peek.
  await notebookKey.click();
  await page.keyboard.press('Alt+KeyJ');
  await expect(notebookKey).toHaveValue('Alt + J');
  await page.getByRole('button', { name: '禁用遮罩位置调节快捷键', exact: true }).click();
  await expect(page.getByLabel('遮罩位置调节快捷键', { exact: true })).toHaveValue('已禁用');

  const peekKey = page.getByLabel('按住临时查看中文快捷键', { exact: true });
  await peekKey.click();
  await page.keyboard.press('KeyV');
  await expect(peekKey).toHaveValue('V');

  // Verify narrow viewport has no horizontal overflow in Settings panel with shortcut section.
  await page.setViewportSize({ width: 390, height: 780 });
  const panelOverflow = await page.locator('.bcm-panel').evaluate(el => el.scrollWidth > el.clientWidth + 1);
  expect(panelOverflow).toBe(false);
  await page.setViewportSize({ width: 1280, height: 850 });

  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.bcm-panel')).toBeHidden();

  // Reload and verify custom shortcuts persist and replace old bindings.
  await page.reload();
  await expect(page.locator('.bcm-dock')).toBeVisible();
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);

  // The overridden capture key and the disabled edit shortcut must do nothing.
  await page.keyboard.press('c');
  await page.keyboard.press('Alt+KeyZ');
  await expect(page.locator('.bcm-mask')).not.toHaveClass(/bcm-edit/);
  await expect(page.locator('.bcm-notification')).not.toContainText('已记录');

  // Custom peek key 'V' reveals while held and restores on release.
  await page.keyboard.down('KeyV');
  await expect(page.locator('.bcm-mask')).toHaveClass(/bcm-peek/);
  await page.keyboard.up('KeyV');
  await expect(page.locator('.bcm-mask')).not.toHaveClass(/bcm-peek/);

  // Custom capture & notebook shortcuts work.
  await page.keyboard.press('Control+Shift+KeyK');
  await expect(page.locator('.bcm-notification')).toContainText('已记录');
  await page.keyboard.press('Alt+KeyJ');
  await expect(page.locator('.bcm-notebook')).toBeVisible();

});

test('pairs locally, retries an offline send and skips acknowledged notes after reload', async ({ page }) => {
  await page.addInitScript(() => {
    const values = new Map();
    window.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
    window.GM_setValue = (key, value) => values.set(key, value);
    window.GM_xmlhttpRequest = options => {
      const url = new URL(options.url);
      if (url.origin !== 'http://127.0.0.1:8765' || options.redirect !== 'error' ||
          options.headers['X-Scene-Sync-Token'] !== 'synthetic-pair-code') {
        options.onload({ status: 403, finalUrl: options.url });
        return;
      }
      if (options.method === 'GET') {
        options.onload({ status: 200, finalUrl: options.url, responseText: '{"ok":true}' });
        return;
      }
      const note = JSON.parse(options.data).notes[0];
      if (!note.imageUrl.startsWith('data:image/jpeg') || !note.source.url.includes('bilibili.com')) {
        options.onload({ status: 400, finalUrl: options.url });
        return;
      }
      const count = Number(sessionStorage.getItem('test-push-count') || 0) + 1;
      sessionStorage.setItem('test-push-count', count);
      if (count === 1) options.onerror();
      else options.onload({ status: 200, finalUrl: options.url,
        responseText: note.userNote === '看完后补记' ? '{"imported":0,"updated":1,"duplicates":0}'
          : '{"imported":1,"duplicates":0}' });
    };
  });
  await boot(page);
  await dockClick(page, 'version');
  page.once('dialog', dialog => dialog.accept('synthetic-pair-code'));
  await page.getByRole('button', { name: '输入配对码' }).click();
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByText('桌面学习器连接正常。')).toBeVisible();
  await page.locator('.bcm-panel').getByRole('button', { name: '关闭', exact: true }).click();
  await captureAndOpen(page);
  const send = page.getByRole('button', { name: '发送到本机学习器' });
  await send.click();
  await expect(page.getByText(/部分或全部场景待发送/)).toBeVisible();
  await send.click();
  await expect(page.getByText('已发送 1 条，跳过 0 条已发送记录。')).toBeVisible();
  await page.reload();
  await dockClick(page, 'version');
  page.once('dialog', dialog => dialog.accept('synthetic-pair-code'));
  await page.getByRole('button', { name: '输入配对码' }).click();
  await expect(page.getByText('配对码已保存，可以测试连接。')).toBeVisible();
  await page.locator('.bcm-panel').getByRole('button', { name: '关闭', exact: true }).click();
  await dockClick(page, 'notebook');
  await send.click();
  await expect(page.getByText('已发送 0 条，跳过 1 条已发送记录。')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('test-push-count'))).toBe('2');
  await page.locator('.bcm-note-input').fill('看完后补记');
  await send.click();
  await expect(page.getByText(/更新 1 条备注/)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('test-push-count'))).toBe('3');
});


test('saves the loopback address and auto-send preference before pairing', async ({ page }) => {
  await page.addInitScript(() => {
    const values = new Map();
    window.GM_getValue = (key, fallback) => values.get(key) ?? fallback;
    window.GM_setValue = (key, value) => values.set(key, value);
  });
  await boot(page);
  await dockClick(page, 'version');
  await page.getByLabel('本机地址').fill('http://localhost:8768');
  await page.getByLabel('记录后自动发送').check();
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.locator('.bcm-notification')).toContainText('配对后才会自动发送');
  await dockClick(page, 'version');
  await expect(page.getByLabel('本机地址')).toHaveValue('http://localhost:8768');
  await expect(page.getByLabel('记录后自动发送')).toBeChecked();
});
