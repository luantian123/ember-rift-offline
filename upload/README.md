# 余烬裂隙 · 离线版（iPhone 主屏幕 App）

把官方单文件游戏包 + 一个 Service Worker 打成可**彻底断网运行**的 PWA。
飞行模式下从主屏幕图标冷启动，能直接进标题画面、进角色、继续刷。

包内已就绪，`dist/` 就是最终产物，直接部署即可；官方发新版时重跑一次 `build.ps1`。

---

## 目录

```
ember-offline/
├─ build.ps1                 构建：拉官方包 → 剥统计 → 注入 SW 注册 → 输出 dist/
├─ static/                   部署用的静态文件（构建时复制进 dist）
│  ├─ sw.js                  Service Worker：预缓存 + 缓存优先 + 后台校验更新
│  ├─ manifest.webmanifest   PWA 清单（standalone / 横屏 / 图标）
│  ├─ pwa-register.html      注入片段（只用于注入，不部署）
│  ├─ _headers               Cloudflare Pages 响应头（sw.js 必须 no-cache）
│  ├─ icon-192.png / icon-512.png / apple-touch-icon.png
│  └─ …
├─ test/
│  ├─ sw-sim.mjs             离线逻辑仿真（12 条断言，不需要浏览器）
│  ├─ unlock-sim.mjs         全解锁补丁功能验证（12 条断言）
│  └─ serve.mjs              本地预览服务器（127.0.0.1:8787）
└─ dist/                     ← 部署这个目录
   ├─ index.html             官方包（4.64MB）+ 注入的 SW 注册 + 统计已剥离
   ├─ sw.js
   ├─ manifest.webmanifest
   ├─ _headers
   └─ icon-192.png / icon-512.png / apple-touch-icon.png
```

---

## 三步上线

### 1) 部署到任意 HTTPS 静态托管

四条路，按省事程度排：

**① Surge（最快，1 分钟拿到网址，不用开控制台）**

```bash
npx surge ./dist            # 首次会让你填邮箱+密码（注册即用）
# 拿到 https://<你起的名字>.surge.sh
```

**② Cloudflare Pages 网页拖拽（永久免费，不用装任何东西）**

`dash.cloudflare.com` → Workers & Pages → Create → Pages → **Upload assets** →
把 `dist/` 里 7 个文件全选拖进去 → Deploy → 得到 `xxx.pages.dev`。

**③ Cloudflare Pages 命令行（和官方同一套基建）**

```bash
npx wrangler pages deploy dist --project-name ember-rift-offline
# 浏览器里点一下授权，拿到 https://ember-rift-offline.pages.dev
```

**④ GitHub Pages（你已登录 GitHub 就走这条）**

网页版（不用装任何东西）：`github.com/new` → 仓库名 `ember-rift-offline` → **Public** → Create →
`uploading an existing file` → 把 `dist/` 里 8 个文件（含 `.nojekyll`）全选拖进去 → Commit →
Settings → Pages → Source `Deploy from a branch` → `main` / `(root)` → Save →
1 分钟后 `https://<你的用户名>.github.io/ember-rift-offline/`。

命令行（一个 token 搞定全部，含自动开 Pages）：

```powershell
$env:GITHUB_TOKEN = 'ghp_xxx'          # github.com/settings/tokens → classic → 勾 repo
.\deploy-github.ps1 -Repo ember-rift-offline
```

GitHub Pages 三个注意点：
- 免费账号的 Pages **只支持 public 仓库**，等于这份副本谁都能打开；要私有选 Cloudflare Pages。
- 仓库里必须有 `.nojekyll`（`dist/` 已带），否则 Jekyll 会去构建并忽略 `_` 开头的文件。
- 项目站跑在**子路径** `/ember-rift-offline/` 下，SW 已经用相对路径注册（`./sw.js`，scope `./`），
  manifest 的 `id/start_url/scope` 也都改成 `./` 了，子路径仿真 12/12 通过。
- Pages 的 CDN 缓存约 10 分钟，更新后页面最多 10 分钟才感知到新版本。

拿到域名后，想让它出现在分享链接和分享图上，重跑一次：

```powershell
.\build.ps1 -UnlockAll -SiteUrl '你拿到的域名'
```

然后重新上传 `dist/`。`_headers` 只有 Cloudflare Pages 和 Netlify 认，其它平台忽略也无所谓——
SW 脚本浏览器本身默认就绕过 HTTP 缓存。


### 2) iPhone 用 **Safari** 打开你的地址
Chrome / Edge 在 iOS 上不能装主屏幕应用，必须是 Safari。

### 3) 分享 → 添加到主屏幕 → 从**主屏幕图标**启动

- 第一次必须联网，让 SW 把 4.64MB 主文档 + 图标吃进缓存（2~5 秒，看网速）。
- 然后开飞行模式，从主屏幕图标冷启动 → 能进标题界面 = 成功。
- 地址栏消失、全屏、横屏，就是独立 App 的样子。

---

---

## 不想公开？暴露面三档

先分清一件事：你上传的**不是源码**——官方站本来就是 4.6MB 单文件，任何人打开 `ember-rift.pages.dev` 都能另存为拿到同一份产物。
真正的增量暴露只有一个：**多了一个可被搜索、可被人点开的公开镜像**。所以按"谁能找到它"来控制就够了。

| 档位 | 做法 | 谁能访问 | 代价 |
|---|---|---|---|
| **① 装上就删**（最干净） | 部署 → iPhone 装好主屏并缓存完 → **立刻删掉 Pages 项目** | 只有你的手机（缓存留在本地） | 之后不能更新，清缓存就没了 |
| **② 直传 + 反索引**（推荐日常用） | Cloudflare Pages **Direct Upload**，不建仓库；`dist/` 已带 `robots.txt` + `noindex` | 拿到那串随机 `xxx.pages.dev` 的人 | 无 |
| **③ 加认证** | `.\build.ps1 -UnlockAll -NoIndex -BasicAuth '用户名:密码'` → 生成 `_worker.js` | 只有输对账号的人 | iOS 首次启动可能弹一次登录框；离线缓存后不影响 |

```powershell
# ③ 的具体命令（只在 Cloudflare Pages 生效，其它平台不认 _worker.js）
.\build.ps1 -UnlockAll -NoIndex -BasicAuth 'me:YourPassword'
```

已经传到 GitHub 了怎么收：

- 仓库 **Settings → 最底部 Danger Zone → Change repository visibility → Private**
  （免费账号的 Pages 会随之停掉，正好）
- 或者直接 **Delete this repository**
- 然后改走 Cloudflare **Direct Upload**：不产生任何公开仓库页面，URL 即凭证

万一真被投诉：托管商会先下架站点，`dist/` 在你本地原样还在，
换个域名重新上传 5 分钟就恢复。所以别用 `ember-rift` 这种品牌词做仓库名/子域名，
也别把链接贴到公开群里——这两件事决定了它是"私人副本"还是"可检索镜像"。

---

## 为什么一定要 HTTPS

iOS 只在**安全上下文**里允许注册 Service Worker：

| 访问方式 | 能否离线 |
|---|---|
| `https://xxx.pages.dev` | ✅ |
| `http://127.0.0.1:8787`（电脑本机） | ✅（localhost 例外，只在电脑上有意义） |
| `http://192.168.1.x:8787`（手机连电脑） | ❌ 不是安全上下文，SW 注册失败 |

想在 iPhone 上先试又不注册托管账号，用隧道临时给个 https：

```bash
node test/serve.mjs            # 终端 A：本地预览 127.0.0.1:8787
cloudflared tunnel --url http://127.0.0.1:8787   # 终端 B：拿到临时 https 域名
```

---

## 自动跟随官方更新（GitHub Actions）

仓库里已经放好 `.github/workflows/update-deploy.yml`：定时拉官方最新包 → 重新处理 → 回归测试 → 发布到 Pages。
**sw.js / manifest / 图标来自 `static/`，官方更新只替换 `index.html`，SW 不受影响。**

需要做的一次性配置：

1. 仓库 **Settings → Pages → Source** 选 **GitHub Actions**（不是 Deploy from a branch）
2. 仓库结构按下面摆（根目录放源码，`dist/` 不进版本库）：

```
你的仓库/
├─ .github/workflows/update-deploy.yml
├─ tools/build.mjs
├─ static/            ← sw.js / manifest / 图标 / _headers / pwa-register.html
├─ test/              ← unlock-sim.mjs / sw-sim.mjs
└─ .gitignore         ← dist/ 已被忽略
```

3. 想手动跑一次：Actions → 「抓取官方更新并部署」→ **Run workflow**
4. 改频率：编辑 `cron: '17 */6 * * *'`（UTC；`*/30 * * * *` 就是每 30 分钟）

流程里有两道保险，任何一道不过就**不会发布**，线上继续留上一版：

- 构建自检：游戏本体完整、SW 注册只有一处、统计已剥离、包体 > 3MB、全解锁真的生效
- 回归测试：`unlock-sim`（12 条）+ `sw-sim`（12 条）

> 本地已有 `dist/` 是老版本；CI 第一次跑会用新包覆盖。想本地先看效果：
> `node tools/build.mjs --unlock --noindex`

### 为什么 `build.mjs` 不按变量名打补丁

官方每次重新压缩都会换标识符（这版是 `jf/cn/m/J0`，上一版是 `Kl/wo/p/sf`），
所以解锁补丁按**代码形状**匹配，换版本照样命中；两个版本的包都实测过 12/12。

---

## 手动更新（不用 CI 的话）

```powershell
powershell -ExecutionPolicy Bypass -File .\build.ps1
npx wrangler pages deploy dist --project-name ember-rift-offline
```

玩家那端不用手动清缓存：SW 每次打开都会**先用缓存秒开**，同时在后台拉一份新的，
发现包变了就在屏幕下方弹一个「有新版本，点此刷新」，点一下换成新版。

`sw.js` 顶部的 `VERSION` 只在需要**强制丢弃全部旧缓存**时才改（比如调试期缓存脏了）。

---

## 五个可选开关

```powershell
# 1) 把分享链接/分享图水印改成你自己的域名（默认指向官方站）
.\build.ps1 -SiteUrl 'ember-rift-offline.pages.dev'

# 2) 自托管时标题界面会显示「这不是官方版本」提示（这是游戏自带的平台识别）。
#    不想看到就固定成官网版本：
.\build.ps1 -AsOfficial

# 3) 解锁全部外观（宠物 / 称号 / 光环 / 翅膀 / 坐骑 / 技能皮肤）
.\build.ps1 -UnlockAll

# 4) 反索引：写 robots.txt(Disallow: /) + index.html 里加 noindex meta
.\build.ps1 -NoIndex

# 5) 加 HTTP Basic Auth（只有 Cloudflare Pages 认 _worker.js）
.\build.ps1 -BasicAuth '用户名:密码'

# 可以叠加，例如日常这套：
.\build.ps1 -UnlockAll -NoIndex -SiteUrl 'xxx.pages.dev'
```

> **当前 `dist/` = `-UnlockAll -NoIndex`**。想要干净的重新跑 `.\build.ps1`（不带参数）。

### `-UnlockAll` 到底改了什么

只动两处"是否拥有"的判定，**不写存档、不改数值、不加属性**：

| 原代码 | 补丁后 | 效果 |
|---|---|---|
| `Kl=e=>!!wo[e]&&(!!wo[e].free\|\|!!(p&&(p.pets\|\|[]).includes(e)))` | `Kl=e=>!!wo[e]` | 4 只宠物全部可选（含群破 1000 限定「千烬游龙」、第 90 层「虚空之眼」、绝版「符镇太岁」） |
| `function sf(e,t){return!p\|\|!Zr(e)[t]?!1:…}` | `function sf(e,t){return!p\|\|!Zr(e)[t]?!1:!0}` | 称号 / 光环 / 翅膀 / 坐骑 / 各职业技能皮肤全部可选 |

保留的部分：`!p||!Zr(e)[t]` 这道"这个外观是否属于当前职业/是否存在"的校验没动，
所以不会出现选到不属于该职业的东西、或者空 id 崩掉。

游戏内路径：进游戏 → `Esc` 菜单 → **外观**，29 个外观条目（宠物 4 + 坐骑 2 + 称号/光环/翅膀/皮肤）
全部可选；点一下立刻穿上，选择会正常存进存档。

验证：

```bash
node test/unlock-sim.mjs    # 抽出补丁后的函数，喂假角色跑 12 条断言
```

说明一下第 2 条的原委：游戏里有一段平台判定
`claude.ai → preview`、`itch.io → itch`、`ur.hosts → web`、其余 `→ other`，
`other` 分支会在标题界面红字提示「这不是官方版本，可能被改过」。
自托管域名不在它的名单里，所以默认会看到这行字。`-AsOfficial` 只是把判定固定成 `web`，
**不会改变任何玩法**，存档位置也不受影响。

---

## 已验证的行为

```bash
node test/sw-sim.mjs
```

12 条断言，模拟浏览器 CacheStorage + 断网，覆盖：

1. install 把主文档 / 图标 / manifest 写进缓存
2. 首次导航走缓存
3. 官方发新版 → 后台校验发现 → 给页面发 `shell-updated` → 两个入口键同步刷新
4. 断网导航仍返回最后缓存的版本，后台校验静默失败不报错
5. 跨域请求（Cloudflare 统计等）不拦截、不进缓存
6. 静态资源命中缓存
7. `SKIP_WAITING` / `CLEAR` 指令生效

全解锁补丁另有一组：`node test/unlock-sim.mjs` → 12/12，
证明限定宠物/绝版宠物/坐骑/翅膀/称号/光环都能选，而不存在或不属于该职业的 id 仍然被拦住。

---

## iPhone 上的几个坑

- **必须"添加到主屏幕"。** 普通 Safari 标签页里，iOS 对非安装站点的可写存储有 7 天清理策略；
  装成主屏幕 App 后才稳定保留（存档也一起受益）。
- **删掉主屏幕图标 = 清掉这个 App 的存储 = 存档没了。** 换机/重装前先在游戏里
  用「导出存档码」备份一份。
- 游戏本身零网络请求（实测 `fetch` / `XHR` / `WebSocket` 全部为 0），存档在 `localStorage`，
  所以断网不影响任何玩法，只影响"检查更新"。
- 横屏是 manifest 里声明的，iOS 不一定强制锁定，转一下手机即可。
- 单个站点的缓存配额 iOS 大约 1GB，这个包 4.64MB，随便造。
- 首次进入如果看到白屏，先联网刷新一次；SW 装好后就不会再出现。

---

## 排查

| 现象 | 原因 / 处理 |
|---|---|
| 装了但断网打不开 | 不是 https，或没走"从主屏幕图标启动" |
| 一直显示旧版 | `sw.js` 被平台缓存了；确认 `_headers` 生效，或在控制台跑 `__erOffline.update()` |
| 控制台 `ServiceWorker registration failed` | 路径不对：`sw.js` 必须和 `index.html` 同目录 |
| 想要干净重来 | 控制台 `__erOffline.clear()` 然后刷新 |

`window.__erOffline` 是注入片段暴露的调试入口：`.reg` / `.update()` / `.clear()`。
