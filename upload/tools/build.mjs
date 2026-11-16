#!/usr/bin/env node
/**
 * 余烬裂隙 · 离线包构建（Node 版，CI 与本地通用）
 *
 * 与 build.ps1 做同一件事，但跨平台、无 BOM 问题，GitHub Actions 直接用：
 *   拉官方单文件 → 剥 Cloudflare 统计 → 可选改站点地址/平台识别/全解锁/反索引
 *   → 注入 SW 注册片段 → 复制 static/ → 自检
 *
 * 用法：
 *   node tools/build.mjs --unlock --noindex
 *   node tools/build.mjs --source ./game.html --out dist
 *   node tools/build.mjs --site-url ember-offline.pages.dev --as-official
 *
 * 退出码：0 = 成功；非 0 = 自检失败（CI 里就不要部署了）
 */

import { readFile, writeFile, mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

/* ---------------- 参数 ---------------- */
function parseArgs(argv) {
  const out = {
    source: 'https://ember-rift.pages.dev/',
    outDir: 'dist',
    siteUrl: '',
    asOfficial: false,
    unlock: false,
    noindex: false,
    basicAuth: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--source') out.source = next();
    else if (a === '--out') out.outDir = next();
    else if (a === '--site-url') out.siteUrl = next();
    else if (a === '--as-official') out.asOfficial = true;
    else if (a === '--unlock') out.unlock = true;
    else if (a === '--noindex') out.noindex = true;
    else if (a === '--basic-auth') out.basicAuth = next();
    else if (a === '--help' || a === '-h') {
      console.log('用法: node tools/build.mjs [--source URL|PATH] [--out DIR] [--site-url HOST] [--as-official] [--unlock] [--noindex] [--basic-auth user:pass]');
      process.exit(0);
    } else {
      throw new Error('未知参数: ' + a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const outDir = resolve(root, args.outDir);
const staticDir = join(root, 'static');

const say = (step, msg) => console.log(`[${step}] ${msg}`);
const fail = (msg) => { console.error('✗ ' + msg); process.exit(1); };

/* ---------------- 1. 取官方产物 ---------------- */
say('1/5', '取官方产物');
let html;

if (/^https?:\/\//i.test(args.source)) {
  const res = await fetch(args.source, {
    headers: { 'user-agent': 'ember-offline-build/1.0' },
    redirect: 'follow',
  });
  if (!res.ok) fail(`下载失败 HTTP ${res.status}`);
  html = await res.text();
  say('    ', `下载 ${Buffer.byteLength(html, 'utf8').toLocaleString()} 字节`);
} else {
  html = await readFile(resolve(root, args.source), 'utf8');
  say('    ', `读本地 ${Buffer.byteLength(html, 'utf8').toLocaleString()} 字节`);
}

if (!html.includes('<html')) fail('拿到的内容不像 index.html，检查 --source');
if (html.length < 1_000_000) fail(`内容只有 ${html.length} 字节，太小了，可能拿到错误页`);

// 官方没有稳定的公开版本号（包里 v17.4 / v19.2 混着出现），
// 所以用内容指纹判断"这次和上次是不是同一份"，提交信息和日志都用它。
const fingerprint = createHash('sha256').update(html, 'utf8').digest('hex').slice(0, 12);
say('    ', `内容指纹: ${fingerprint}`);

/* ---------------- 2. 处理 HTML ---------------- */
say('2/5', '处理 HTML');

// 2.1 剥掉 Cloudflare 统计（自托管时它只往作者账号上报，断网还刷报错）
const before = html.length;
html = html.replace(/<!-- Cloudflare Pages Analytics -->[\s\S]*?<!-- Cloudflare Pages Analytics -->/g, '');
html = html.replace(/<script[^>]*cloudflareinsights[^>]*>\s*<\/script>/g, '');
say('    ', `剥离统计: -${(before - html.length).toLocaleString()} 字节`);

// 2.2 站点地址（分享链接 / 分享图水印）
const sitePattern = /var ur=\{url:"([^"]+)",hosts:\[[^\]]*\]\}/;
if (args.siteUrl) {
  let u = args.siteUrl.trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  u = u.replace(/\/+$/, '');
  const host = new URL(u).host;
  const m = html.match(sitePattern);
  if (m) {
    const oldUrl = m[1];
    const hosts = [...m[0].matchAll(/"([^"]+)"/g)]
      .map((x) => x[1])
      .filter((h) => h !== oldUrl);
    const list = [...new Set([host, ...hosts])];
    html = html.replace(m[0], `var ur={url:"${u}",hosts:[${list.map((h) => `"${h}"`).join(',')}]}`);
    say('    ', `站点地址: ${oldUrl} → ${u}`);
  } else {
    say('    ', '站点地址: 未找到 Site 配置，跳过');
  }
}

// 2.3 平台识别：自托管会被判为 other，标题界面提示「这不是官方版本」
if (args.asOfficial) {
  const pat = 'IT(t,ur.hosts)?"web":"other"';
  if (html.includes(pat)) {
    html = html.split(pat).join('"web"');
    say('    ', '平台识别: 固定为 web（--as-official）');
  } else {
    say('    ', '平台识别: 模式未匹配，保持原样');
  }
} else {
  say('    ', '平台识别: 保持原样');
}

// 2.4 全解锁外观（只改"是否拥有"的判定，不写存档、不改数值）
//
// 官方每次更新都会重新压缩，变量名会变（Kl→jf、wo→cn、p→m…），
// 所以这里按**代码形状**匹配，不按名字匹配，换版本也能命中。
let unlockPet = 0;
let unlockCos = 0;

if (args.unlock) {
  // 形状：<名>=<参数>=>!!<目录>[<参数>]&&(!!<目录>[<参数>].free||!!(<状态>&&(<状态>.pets||[]).includes(<参数>)))
  const petShape = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>!!([A-Za-z_$][\w$]*)\[\2\]&&\(!!\3\[\2\]\.free\|\|!!\(([A-Za-z_$][\w$]*)&&\(\4\.pets\|\|\[\]\)\.includes\(\2\)\)\)/;
  const pet = html.match(petShape);
  if (pet) {
    const [whole, fn, arg, cat] = pet;
    html = html.replace(whole, `${fn}=${arg}=>!!${cat}[${arg}]`);
    unlockPet = 1;
    say('    ', `全解锁: 宠物判定已放开（${fn}）`);
  } else if (/([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)=>!!([A-Za-z_$][\w$]*)\[\2\][,;]/.test(html)) {
    unlockPet = 1;
    say('    ', '全解锁: 宠物判定已是解锁形态，跳过');
  } else {
    say('    ', '全解锁: 宠物判定形状未匹配');
  }

  // 形状：function <名>(<a>,<b>){return!<状态>||!<目录>(<a>)[<b>]?!1:<三元…>}
  // 保留"这个外观是否属于该职业"的校验，其余一律放行
  const cosShape = /function ([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)\{return!([A-Za-z_$][\w$]*)\|\|!([A-Za-z_$][\w$]*)\(\2\)\[\3\]\?!1:[^}]*\}/;
  const cos = html.match(cosShape);
  if (cos) {
    const [whole, fn, a, b, state, cat] = cos;
    html = html.replace(whole, `function ${fn}(${a},${b}){return!${state}||!${cat}(${a})[${b}]?!1:!0}`);
    unlockCos = 1;
    say('    ', `全解锁: 称号/光环/翅膀/坐骑/皮肤已放开（${fn}）`);
  } else if (/function [A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*,[A-Za-z_$][\w$]*\)\{return![A-Za-z_$][\w$]*\|\|![A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\[[A-Za-z_$][\w$]*\]\?!1:!0\}/.test(html)) {
    unlockCos = 1;
    say('    ', '全解锁: 外观判定已是解锁形态，跳过');
  } else {
    say('    ', '全解锁: 外观判定形状未匹配');
  }
} else {
  say('    ', '全解锁: 未开启');
}

// 2.5 反索引 + iOS meta
if (args.noindex && !html.includes('name="robots"')) {
  html = html.replace('</head>', '<meta name="robots" content="noindex,nofollow,noarchive">\n</head>');
  say('    ', '反索引: 已注入 noindex meta');
}
const headAdds = [];
if (!html.includes('apple-mobile-web-app-capable')) {
  headAdds.push('<meta name="apple-mobile-web-app-capable" content="yes">');
}
if (!html.includes('format-detection')) {
  headAdds.push('<meta name="format-detection" content="telephone=no">');
}
if (!html.includes('apple-touch-icon')) {
  headAdds.push('<link rel="apple-touch-icon" href="apple-touch-icon.png">');
}
if (headAdds.length) html = html.replace('</head>', headAdds.join('\n') + '\n</head>');

// 2.6 注入 SW 注册片段
const snippet = await readFile(join(staticDir, 'pwa-register.html'), 'utf8');
if (html.includes('离线 / PWA 支持')) {
  say('    ', '已注入过，跳过');
} else {
  const idx = html.lastIndexOf('</body>');
  html = idx < 0 ? html + '\n' + snippet : html.slice(0, idx) + snippet + '\n' + html.slice(idx);
  say('    ', `注入 SW 注册: +${snippet.length.toLocaleString()} 字节`);
}

/* ---------------- 3. 写文件 ---------------- */
say('3/5', '写文件');
await mkdir(outDir, { recursive: true });
const outHtml = join(outDir, 'index.html');
await writeFile(outHtml, html, 'utf8');
const size = (await stat(outHtml)).size;
say('    ', `index.html ${size.toLocaleString()} 字节 (${(size / 1048576).toFixed(2)} MB)`);

/* ---------------- 4. 复制静态文件 ---------------- */
say('4/5', '复制静态文件');
for (const name of await readdir(staticDir)) {
  if (name === 'pwa-register.html') continue; // 构建期片段，不部署
  const src = join(staticDir, name);
  if (!(await stat(src)).isFile()) continue;
  await copyFile(src, join(outDir, name));
  say('    ', `${name.padEnd(26)} ${(await stat(src)).size.toLocaleString()} 字节`);
}

if (args.noindex) {
  await writeFile(join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');
  say('    ', 'robots.txt 已生成（Disallow: /）');
}

if (args.basicAuth) {
  const b64 = Buffer.from(args.basicAuth, 'ascii').toString('base64');
  const worker = `// Cloudflare Pages 入口：没通过 Basic Auth 一律 401
const CREDS = 'Basic ${b64}';
export default {
  async fetch(request, env) {
    const auth = request.headers.get('Authorization') || '';
    if (auth !== CREDS) {
      return new Response('需要登录', {
        status: 401,
        headers: { 'WWW-Authenticate': 'Basic realm="ember", charset="UTF-8"' },
      });
    }
    return env.ASSETS.fetch(request);
  },
};
`;
  await writeFile(join(outDir, '_worker.js'), worker, 'utf8');
  say('    ', '_worker.js 已生成（Basic Auth，仅 Cloudflare Pages 生效）');
}

/* ---------------- 5. 自检（失败就不要部署） ---------------- */
say('5/5', '自检');
const checks = [
  ['游戏本体完整', html.includes('state:"title"') && html.includes('window.__testSeed')],
  ['有且只有一处 SW 注册', (html.match(/register\('\.\/sw\.js'/g) || []).length === 1],
  ['Cloudflare 统计已剥离', !html.includes('cloudflareinsights')],
  ['manifest 引用存在', html.includes('manifest.webmanifest')],
  ['apple-touch-icon 存在', html.includes('apple-touch-icon')],
  ['sw.js 已就位', existsSync(join(outDir, 'sw.js'))],
  ['包体 > 3MB', size > 3 * 1024 * 1024],
];
if (args.unlock) {
  checks.push(['全解锁已生效', unlockPet === 1 && unlockCos === 1]);
}
if (args.siteUrl) {
  checks.push(['站点地址已改写', html.includes(new URL(/^https?:\/\//i.test(args.siteUrl) ? args.siteUrl : 'https://' + args.siteUrl).host)]);
}

let bad = 0;
for (const [label, ok] of checks) {
  console.log(`    ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) bad++;
}

console.log('');
if (bad) {
  console.error(`${bad} 项自检失败 —— 不要部署这一版，继续用上一次成功的产物。`);
  process.exit(1);
}
console.log(`构建完成 · 指纹 ${fingerprint} · ${(size / 1048576).toFixed(2)} MB → ${outDir}`);
