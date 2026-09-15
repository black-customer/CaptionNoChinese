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
  await expect(page.locator('#bcm-app')).toHaveAttribute('data-version', '2.4.0');
  await expect(page.locator('.bcm-dock')).toBeVisible();
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
}
async function dockClick(page, action) {
  await page.locator('.bpx-player-video-wrap').hover({ position: { x: 8, y: 8 } });
  await page.locator(`.bcm-dock [data-action="${action}"]`).click();
}
async function captureAndOpen(page) { await dockClick(page,'capture');await expect(page.locator('.bcm-notification')).toContainText('已收藏');await dockClick(page,'notebook');await expect(page.locator('.bcm-note')).toHaveCount(1); }

test('capture, safely edit, reload, search, delete and undo retain a committed image note', async ({ page }) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await boot(page);await captureAndOpen(page);
  const input=page.getByRole('textbox',{name:'笔记 / 答案'});
  await input.fill('<b>literal markup</b> tomorrow');
  await page.getByRole('button',{name:'关闭复习本',exact:true}).click();
  await page.reload();await dockClick(page,'notebook');
  await expect(input).toHaveValue('<b>literal markup</b> tomorrow');
  await expect(page.locator('.bcm-note b')).toHaveCount(0);
  await page.getByRole('searchbox',{name:'搜索收藏'}).fill('tomorrow');
  await expect(page.locator('.bcm-note')).toHaveCount(1);
  await expect(page.locator('.bcm-note img')).toBeVisible();
  await page.getByRole('button',{name:/删除 .* 的收藏/}).click();
  await expect(page.locator('.bcm-note')).toHaveCount(0);
  await page.getByRole('button',{name:'撤销删除',exact:true}).click();
  await expect(page.locator('.bcm-note')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('real IndexedDB backup downloads and imports into a fresh browser context', async ({ page, browser }) => {
  await boot(page);await captureAndOpen(page);
  const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'备份全部',exact:true}).click();
  const download=await downloadPromise;const path=await download.path();
  const data=JSON.parse(await readFile(path,'utf8'));expect(data.notes).toHaveLength(1);expect(data.notes[0].imageUrl).toMatch(/^data:image\/jpeg/);
  const context=await browser.newContext();const target=await context.newPage();await boot(target);await dockClick(target,'notebook');
  await target.locator('.bcm-notebook input[type=file]').setInputFiles(path);
  await expect(target.getByRole('region',{name:'备份导入预览'})).toBeVisible();
  await expect(target.locator('.bcm-note')).toHaveCount(0);
  await target.getByRole('button',{name:'确认导入',exact:true}).click();
  await expect(target.locator('.bcm-note')).toHaveCount(1);
  await context.close();
});

test('cross-part replay navigates to the recorded source before seeking', async ({page}) => {
  await boot(page);await captureAndOpen(page);await page.getByRole('button',{name:'关闭复习本',exact:true}).click();
  await page.getByRole('button',{name:'下一 P',exact:true}).click();
  await expect(page).toHaveURL(/\?p=2/);await dockClick(page,'notebook');
  await page.locator('.bcm-note').getByRole('button',{name:/回听/}).first().click();
  await expect(page).toHaveURL(url);
  await expect.poll(()=>page.evaluate(()=>window.fixture.time)).toBe(39);
});

test('native fullscreen keeps the notebook visible and keyboard close restores focus', async ({page}) => {
  await boot(page);await page.getByRole('button',{name:'进入播放器全屏',exact:true}).click();
  await page.keyboard.press('b');await expect(page.locator('.bcm-notebook')).toBeVisible();
  expect(await page.evaluate(()=>document.fullscreenElement.contains(document.querySelector('#bcm-app')))).toBe(true);
  await page.keyboard.press('Escape');await expect(page.locator('.bcm-notebook')).toBeHidden();
  expect(await page.locator('.bcm-notebook').evaluate(node=>node.inert)).toBe(true);
});

test('input focus and repeated keydown do not create duplicate captures; outside wheel is preserved', async ({page}) => {
  await boot(page);await page.getByRole('textbox',{name:'评论',exact:true}).fill('sbsbs');
  await page.keyboard.press('s');
  const outside=await page.evaluate(()=>{const e=new WheelEvent('wheel',{bubbles:true,cancelable:true,altKey:true,deltaY:10});document.querySelector('.outside').dispatchEvent(e);return e.defaultPrevented;});
  expect(outside).toBe(false);
  await page.locator('h1').click();
  await page.evaluate(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'s',code:'KeyS',repeat:true,bubbles:true,cancelable:true}));});
  await dockClick(page,'notebook');await expect(page.locator('.bcm-note')).toHaveCount(0);
  await page.getByRole('button',{name:'关闭复习本',exact:true}).click();await page.keyboard.press('s');
  await expect(page.locator('.bcm-notification')).toContainText('已收藏');await dockClick(page,'notebook');await expect(page.locator('.bcm-note')).toHaveCount(1);
});

test('settings alter replay lead-in and A-B review returns to the previous position', async ({page}) => {
  await boot(page);await captureAndOpen(page);
  await page.getByRole('button',{name:'设置',exact:true}).click();
  await page.getByLabel('回听提前（秒）',{exact:true}).fill('5');
  await page.getByLabel('循环次数',{exact:true}).fill('1');
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.locator('.bcm-note').getByRole('button',{name:/回听/}).first().click();
  await expect.poll(()=>page.evaluate(()=>fixture.time)).toBe(37);
  await page.evaluate(()=>{fixture.time=100;});
  await page.locator('.bcm-note').getByRole('button',{name:'片段循环',exact:true}).click();
  await expect(page.locator('.bcm-loopbar')).toBeVisible();
  await page.evaluate(()=>{fixture.time=45;document.querySelector('video').dispatchEvent(new Event('timeupdate'));});
  await expect(page.locator('.bcm-loopbar')).toBeHidden();
  await expect.poll(()=>page.evaluate(()=>fixture.time)).toBe(100);
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
  await boot(page);await captureAndOpen(page);await mkdir('artifacts',{recursive:true});
  await page.screenshot({path:'artifacts/v2.4.0-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:780});
  await expect(page.locator('.bcm-notebook')).toBeVisible();
  const bounds=await page.locator('.bcm-notebook').boundingBox();expect(bounds.x).toBeGreaterThanOrEqual(-1);expect(bounds.x+bounds.width).toBeLessThanOrEqual(391);
  const overflow=await page.locator('.bcm-notebook').evaluate(el=>el.scrollWidth>el.clientWidth+1);expect(overflow).toBe(false);
  await page.screenshot({path:'artifacts/v2.4.0-narrow.png',fullPage:true});
});

test('a rejected IndexedDB write never announces success or leaves a phantom card',async({page})=>{
  await boot(page);
  await page.evaluate(()=>{
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(...args){if(this.name==='notes')throw new DOMException('Test quota failure','QuotaExceededError');return original.apply(this,args);};
  });
  await dockClick(page,'capture');
  await expect(page.locator('.bcm-notification')).toHaveAttribute('data-kind','error');
  await expect(page.locator('.bcm-notification')).not.toContainText('已收藏');
  await dockClick(page,'notebook');await expect(page.locator('.bcm-note')).toHaveCount(0);
});

test('plain and plaintext-only contenteditable fields keep single-letter typing',async({page})=>{
  await boot(page);
  await page.evaluate(()=>{for(const value of ['', 'plaintext-only']){const input=document.createElement('div');input.setAttribute('contenteditable',value);input.setAttribute('aria-label',value||'plain');input.textContent='edit here';document.querySelector('.outside').append(input);}});
  for(const selector of ['[aria-label="plain"]','[contenteditable="plaintext-only"]']){await page.locator(selector).click();await page.keyboard.type('sbs');}
  await dockClick(page,'notebook');await expect(page.locator('.bcm-note')).toHaveCount(0);
});
