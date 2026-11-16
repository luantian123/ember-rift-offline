/**
 * dist/ 本地预览服务器（零依赖）
 * 用途：部署前在电脑上验证「注册 SW + 断网重开」是否正常。
 * localhost 属于安全上下文，所以桌面浏览器可以直接注册 SW。
 * 跑法：node test/serve.mjs   → http://127.0.0.1:8787
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', 'dist');
const PORT = Number(process.env.PORT || 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path === '/' || path === '') path = '/index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }

    const buf = await readFile(file);
    const headers = {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': buf.length,
      // SW 脚本不缓存，改完刷新就能生效
      'cache-control': path === '/sw.js' ? 'no-cache' : 'public, max-age=60',
    };
    if (path === '/sw.js') headers['service-worker-allowed'] = '/';
    res.writeHead(200, headers).end(buf);
  } catch (err) {
    if (err.code === 'ENOENT') res.writeHead(404).end('not found');
    else res.writeHead(500).end(String(err && err.message));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`预览：http://127.0.0.1:${PORT}/   （Ctrl+C 停止）`);
});
