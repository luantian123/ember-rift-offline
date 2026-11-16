/**
 * sw.js 离线逻辑仿真测试（不需要浏览器）
 * 目的：在部署前证明这四件事成立
 *   1. install 把 index.html / 图标 / manifest 全部写进缓存
 *   2. 断网后导航请求仍能拿到缓存（这就是"断网可玩"）
 *   3. 联网时导航先返回缓存（秒开），后台拿到新包后给页面发 shell-updated
 *   4. 外域请求（Cloudflare 统计等）不被拦截、不污染缓存
 *
 * 跑法：node test/sw-sim.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SW_PATH = join(here, '..', 'dist', 'sw.js');
const BASE = process.env.SW_BASE || 'https://demo.example.com/';

/* ---------------- 假服务器 ---------------- */
let online = true;
let version = 1;
const server = new Map(); // url -> { body, etag }

const setVersion = (v) => {
  version = v;
  server.set(BASE, { body: `<html>v${v} 游戏本体</html>`, etag: `"w/idx-${v}"` });
  server.set(BASE + 'index.html', { body: `<html>v${v} 游戏本体</html>`, etag: `"w/idx-${v}"` });
};
setVersion(1);
server.set(BASE + 'manifest.webmanifest', { body: '{"name":"x"}', etag: '"m1"' });
server.set(BASE + 'icon-192.png', { body: 'PNG192', etag: '"i192"' });
server.set(BASE + 'icon-512.png', { body: 'PNG512', etag: '"i512"' });
server.set(BASE + 'apple-touch-icon.png', { body: 'PNG180', etag: '"i180"' });

const abs = (u) => new URL(u, BASE).href;

globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? abs(input) : abs(input.url || String(input));
  if (!online) throw new TypeError('Failed to fetch (offline)');
  const hit = server.get(url);
  if (!hit) return new Response('not found', { status: 404 });
  return new Response(hit.body, {
    status: 200,
    headers: { 'content-type': 'text/html', etag: hit.etag, 'content-length': String(hit.body.length) },
  });
};

/* ---------------- 假 CacheStorage ---------------- */
const norm = (req) => {
  if (typeof req === 'string') return abs(req);
  return abs(req.url);
};

/* 存储的是「响应内容快照」，每次 match 返回全新 Response
   —— 真实 Cache API 每次 match 也给新的 body，不能被读一次就废掉。 */
class FakeCache {
  constructor() { this.map = new Map(); }
  async add(req) {
    const url = norm(req);
    const res = await fetch(url);
    if (!res.ok) throw new Error('add failed ' + url);
    this.map.set(url, { body: await res.text(), headers: [...res.headers] });
  }
  async addAll(reqs) { for (const r of reqs) await this.add(r); }
  async put(req, res) {
    this.map.set(norm(req), { body: await res.text(), headers: [...res.headers] });
  }
  async match(req) {
    const e = this.map.get(norm(req));
    if (!e) return undefined;
    return new Response(e.body, { status: 200, headers: Object.fromEntries(e.headers) });
  }
  async keys() { return [...this.map.keys()]; }
  async delete(req) { return this.map.delete(norm(req)); }
}

const storage = new Map();
const caches = {
  async open(name) {
    if (!storage.has(name)) storage.set(name, new FakeCache());
    return storage.get(name);
  },
  async keys() { return [...storage.keys()]; },
  async delete(name) { return storage.delete(name); },
  async match(req) {
    for (const c of storage.values()) {
      const hit = await c.match(req);
      if (hit) return hit;
    }
    return undefined;
  },
};

/* ---------------- 假 ServiceWorkerGlobalScope ---------------- */
const handlers = new Map();
const posted = [];
const sandbox = {
  console,
  caches,
  fetch: globalThis.fetch,
  Request, Response, Headers, URL,
  setTimeout, clearTimeout, Promise, Math, String, Number, Array, Object, JSON, RegExp,
  self: {
    location: { origin: new URL(BASE).origin, href: BASE + 'sw.js' },
    addEventListener: (t, fn) => handlers.set(t, fn),
    skipWaiting: async () => {},
    clients: {
      claim: async () => {},
      matchAll: async () => [{ postMessage: (m) => posted.push(m) }],
    },
  },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(SW_PATH, 'utf8'), sandbox, { filename: 'sw.js' });

const run = async (type, event) => {
  const waits = [];
  const e = { ...event, waitUntil: (p) => waits.push(p), respondWith: (p) => { e._res = p; } };
  handlers.get(type)(e);
  await Promise.all(waits);
  return e._res ? await e._res : undefined;
};

/* ---------------- 断言 ---------------- */
let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fail++; console.log('  ✗ ' + label); }
};

console.log('\n[1] install 预缓存');
await run('install', {});
const shell = await caches.open('ember-offline-v1-shell');
const shellKeys = await shell.keys();
ok(shellKeys.includes(abs('./index.html')), 'index.html 已缓存');
ok(shellKeys.includes(abs('./icon-192.png')), '图标已缓存');
ok(shellKeys.includes(abs('./manifest.webmanifest')), 'manifest 已缓存');

console.log('\n[2] 在线导航：返回缓存 + 后台校验');
const nav = async () => run('fetch', {
  request: { method: 'GET', mode: 'navigate', url: BASE },
});
let res = await nav();
let body = await res.text();
ok(body.includes('v1'), '首屏来自缓存（v1）');

console.log('\n[3] 官方发新版 → 后台通知页面');
setVersion(2);
posted.length = 0;
await nav();
await new Promise((r) => setTimeout(r, 150)); // revalidate 是后台跑的
ok(posted.includes('shell-updated'), '已向页面发送 shell-updated');
res = await nav();
body = await res.text();
ok(body.includes('v2'), '缓存已刷新到 v2（两个入口键同步）');

console.log('\n[4] 断网导航：仍可开');
online = false;
res = await nav();
body = await res.text();
ok(res.status === 200 && body.includes('v2'), '断网时返回最后缓存的版本');
posted.length = 0;
await new Promise((r) => setTimeout(r, 100));
ok(posted.length === 0, '断网时后台校验静默失败，不报错');

console.log('\n[5] 外域请求不拦截');
const ext = await run('fetch', {
  request: { method: 'GET', mode: 'cors', url: 'https://static.cloudflareinsights.com/beacon.min.js' },
});
ok(ext === undefined, '跨域请求直接放行（respondWith 未调用）');

console.log('\n[6] 静态资源缓存优先');
online = true;
await nav();
const assetReq = { method: 'GET', mode: 'no-cors', url: BASE + 'icon-192.png' };
const a1 = await run('fetch', { request: assetReq });
ok((await a1.text()) === 'PNG192', '图标命中缓存');

console.log('\n[7] 消息指令');
let skipped = false;
sandbox.self.skipWaiting = async () => { skipped = true; };
await run('message', { data: { type: 'SKIP_WAITING' } });
ok(skipped, 'SKIP_WAITING 生效');
await run('message', { data: { type: 'CLEAR' } });
ok((await caches.keys()).length === 0, 'CLEAR 清空缓存');

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
