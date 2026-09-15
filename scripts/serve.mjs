import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const file = new URL('../bilibili-caption-blur-mask.user.js', import.meta.url);
createServer(async (req, res) => {
  if (req.url === '/bilibili-caption-blur-mask.user.js') {
    res.writeHead(200, { 'content-type':'text/javascript; charset=utf-8', 'cache-control':'no-store' }); res.end(await readFile(file));
  } else {
    res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
    res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>看剧学英语 — 本地脚本</title><h1>看剧学英语</h1><p>本地开发版本。安装后请在 B 站视频页面体验。</p><a href="/bilibili-caption-blur-mask.user.js">打开已构建的用户脚本</a></html>');
  }
}).listen(4173,'127.0.0.1',()=>console.log('Local script: http://127.0.0.1:4173/bilibili-caption-blur-mask.user.js'));
