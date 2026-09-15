import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const download = 'https://raw.githubusercontent.com/black-customer/CaptionNoChinese/main/bilibili-caption-blur-mask.user.js';
// Keep name AND namespace stable: managers should update the existing installation.
const metadata = `// ==UserScript==
// @name         Bilibili 剧集双语字幕羽化遮罩与生词本 (看剧学英语)
// @namespace    https://github.com/CaptionNoChinese
// @version      ${version}
// @description  中文字幕遮罩、可靠场景收藏、跨集回听、片段循环、搜索复习与本地备份恢复。
// @author       black-customer
// @homepageURL  https://github.com/black-customer/CaptionNoChinese
// @supportURL   https://github.com/black-customer/CaptionNoChinese/issues
// @updateURL    ${download}
// @downloadURL  ${download}
// @match        *://*.bilibili.com/*
// @match        *://bilibili.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-start
// @noframes
// @license      MIT
// ==/UserScript==`;

await build({
  entryPoints: ['src/main.js'], bundle: true, format: 'iife', target: ['chrome109', 'firefox115'],
  outfile: 'bilibili-caption-blur-mask.user.js', charset: 'utf8', legalComments: 'none',
  loader: { '.css': 'text' }, define: { __APP_VERSION__: JSON.stringify(version) },
  banner: { js: metadata }, logLevel: 'info',
});
await writeFile('bilibili-caption-blur-mask.meta.js', metadata + '\n');
