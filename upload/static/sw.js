/* ============================================================
   余烬裂隙 · 离线壳 Service Worker
   ------------------------------------------------------------
   这个游戏是「单文件应用」：全部逻辑 + 数值表 + 字体 + 图标都内联在
   index.html（≈4.9MB）里，运行时零网络请求。所以只要把它缓存住，
   就是 100% 断网可玩，飞行模式也不影响（存档本来就在 localStorage）。

   策略：
     install  → 预缓存应用壳（index + manifest + 图标）
     activate → 清掉旧版本缓存
     navigate → stale-while-revalidate：先给缓存（秒开/断网可玩），
                后台再拉一份新的，指纹变了就通知页面「有新版本」
     asset    → cache-first
    跨域请求（Cloudflare 统计等）一律放行，不进缓存。

   更新方法：改下面的 VERSION，重新部署即可让所有客户端换新壳。
   ============================================================ */

const VERSION = 'ember-offline-v1';
const SHELL_CACHE = VERSION + '-shell';
const META_CACHE = VERSION + '-meta';
const SHELL_ENTRY = './index.html';
/* 相对路径 → 绝对 URL。SW 的 location.href 是 sw.js 自己的地址，
   所以 './index.html' 会解析成站点根目录下同一层，部署在子目录也不会错。 */
const abs = (u) => new URL(u, self.location.href).href;
/* 主文档在缓存里的两个等价键：'/' 和 '/index.html'。
   两个都要写、都要同步，否则会出现「开了 / 走旧版，开了 /index.html 走新版」。 */
const DOC_KEYS = [abs('./'), abs(SHELL_ENTRY)];

function primeDoc(cache, res) {
  return Promise.all(DOC_KEYS.map((k) => cache.put(k, res.clone())));
}

/* 预缓存清单。站点根和 /index.html 都试一遍：
   Cloudflare Pages 会把 /index.html 308 跳到 /，GitHub Pages 则是反过来，
   两边都拿一份，装到哪都能开。 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

/* ---------------- 安装：预缓存 ---------------- */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    let docOk = false;

    for (const url of PRECACHE) {
      try {
        await cache.add(new Request(abs(url), { cache: 'reload' }));
        if (url === './' || url === SHELL_ENTRY) docOk = true;
      } catch (err) {
        /* 单个资源失败（重定向、404）不阻断整个安装 */
      }
    }
    if (!docOk) throw new Error('[sw] 主文档预缓存失败，离线不可用');

    try {
      const res = (await cache.match(abs('./'))) || (await cache.match(SHELL_ENTRY));
      if (res) {
        await primeDoc(cache, res); // 让 '/' 和 '/index.html' 指向同一份
        await remember(await fingerprint(res));
      }
    } catch (err) { /* 指纹失败不影响离线 */ }

    await self.skipWaiting();
  })());
});

/* ---------------- 激活：清旧缓存 ---------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k !== SHELL_CACHE && k !== META_CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------------- 请求分流 ---------------- */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return; // 外域直接交给网络

  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }
  event.respondWith(handleAsset(req));
});

/* 导航：缓存优先 + 后台校验更新 */
async function handleNavigation(req) {
  const cache = await caches.open(SHELL_CACHE);
  const cached =
    (await cache.match(req)) ||
    (await cache.match(SHELL_ENTRY)) ||
    (await cache.match(abs('./')));

  if (!cached) {
    // 首次访问 / 缓存被系统清掉
    try {
      const res = await fetch(req);
      if (res && res.ok) await primeDoc(cache, res);
      return res;
    } catch (err) {
      return new Response('离线，且本地还没有缓存副本。请联网打开一次。', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  }

  revalidate(req); // 不 await：不拖慢首屏
  return cached;
}

async function revalidate(req) {
  try {
    const res = await fetch(req, { cache: 'no-store' });
    if (!res || !res.ok) return;
    // 被重定向到别处（Cloudflare Access 登录页、Basic Auth 跳转）就别拿它污染应用壳。
    // 只有 /index.html ↔ / 这种同一页面的规范化跳转才放行。
    if (res.redirected && res.url) {
      const norm = (p) => p.replace(/\/index\.html$/, '/');
      const to = new URL(res.url);
      const from = new URL(req.url);
      if (to.origin !== from.origin || norm(to.pathname) !== norm(from.pathname)) return;
    }

    const fp = await fingerprint(res);
    const old = await recall();
    const cache = await caches.open(SHELL_CACHE);
    await primeDoc(cache, res);

    if (!old) { await remember(fp); return; }
    if (fp && fp !== old) {
      await remember(fp);
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) {
        try { c.postMessage('shell-updated'); } catch (e) {}
      }
    }
  } catch (err) {
    /* 断网：静默，继续用缓存 */
    if (self.console && console.warn) console.warn('[sw] 后台校验跳过:', err && err.message);
  }
}

/* 静态资源：缓存优先 */
async function handleAsset(req) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res && res.ok && res.type === 'basic') {
      await cache.put(req, res.clone());
    }
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

/* ---------------- 包指纹：用于判断「官方发新版了」 ---------------- */
async function fingerprint(res) {
  const tag = res.headers.get('etag') || res.headers.get('last-modified') || '';
  const len = res.headers.get('content-length') || '';
  if (tag || len) return 'hdr:' + tag + '|' + len;
  // 没有头信息就自己对内容做一次 FNV-1a
  const txt = await res.clone().text();
  let h = 2166136261;
  for (let i = 0; i < txt.length; i++) {
    h ^= txt.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return 'fnv:' + (h >>> 0) + '|' + txt.length;
}

async function remember(fp) {
  const cache = await caches.open(META_CACHE);
  await cache.put(
    './__fingerprint',
    new Response(String(fp || ''), { headers: { 'content-type': 'text/plain' } })
  );
}

async function recall() {
  const cache = await caches.open(META_CACHE);
  const res = await cache.match('./__fingerprint');
  return res ? await res.text() : '';
}

/* ---------------- 指令 ---------------- */
self.addEventListener('message', (event) => {
  const data = event.data;
  const type = typeof data === 'string' ? data : (data && data.type);

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (type === 'CLEAR') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    })());
  }
});
