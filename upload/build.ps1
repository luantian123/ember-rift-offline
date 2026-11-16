# 余烬裂隙 · 离线包构建（iPhone 主屏幕 App 用）
#
# 作用：拉官方最新单文件产物 → 剥掉 Cloudflare 统计 → 注入 SW 注册片段 → 输出 dist/
# 用法：pwsh -File build.ps1              （默认拉官方最新）
#       pwsh -File build.ps1 -Source .\game.html   （用本地已下载的包）
#
# 官方发新版后，重复跑这一条即可，其它文件不用动。

param(
  [string]$Source = 'https://ember-rift.pages.dev/',
  [string]$OutDir = 'dist',
  # 你的站点地址，例如 https://ember-abc.pages.dev（用于分享链接与分享图水印）
  [string]$SiteUrl = '',
  # 开关：把自托管站点当成"官网版本"处理。默认关，
  # 关着时标题界面会显示「这不是官方版本」提示（真实情况），打开后显示正常官网面板。
  [switch]$AsOfficial,
  # 开关：解锁全部外观（宠物 / 称号 / 光环 / 翅膀 / 坐骑 / 各职业技能皮肤），
  # 只改"是否拥有"的判定，不写存档、不改数值。
  [switch]$UnlockAll,
  # 开关：反索引（noindex meta + robots.txt），别让搜索引擎把这份副本收进去
  [switch]$NoIndex,
  # 可选：HTTP Basic Auth 账号，格式 '用户名:密码'。只在 Cloudflare Pages 生效
  # （会生成 _worker.js，其它平台不认）
  [string]$BasicAuth = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$staticDir = Join-Path $here 'static'
$out = Join-Path $here $OutDir

Write-Host '[1/5] 准备目录' -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host '[2/5] 取官方产物' -ForegroundColor Cyan
$tmp = Join-Path $env:TEMP ('ember-' + [guid]::NewGuid().ToString('N') + '.html')
if ($Source -like 'http*') {
  Invoke-WebRequest -Uri $Source -UseBasicParsing -TimeoutSec 180 -OutFile $tmp
  Write-Host ('      下载 {0:N0} 字节' -f (Get-Item $tmp).Length)
} else {
  Copy-Item -LiteralPath $Source -Destination $tmp -Force
  Write-Host ('      读本地 {0:N0} 字节' -f (Get-Item $tmp).Length)
}

$html = [IO.File]::ReadAllText($tmp, [Text.Encoding]::UTF8)
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

if ($html -notmatch '<html') { throw '拿到的内容不像 index.html，检查 -Source' }

Write-Host '[3/5] 处理 HTML' -ForegroundColor Cyan

# 3.1 剥掉 Cloudflare Pages 统计（自托管时它只会往作者账号上报数据，且断网时刷报错）
$before = $html.Length
$html = [regex]::Replace(
  $html,
  '(?s)<!-- Cloudflare Pages Analytics -->.*?<!-- Cloudflare Pages Analytics -->',
  ''
)
$html = [regex]::Replace($html, '(?s)<script[^>]*cloudflareinsights[^>]*>\s*</script>', '')
Write-Host ('      剥离统计: -{0:N0} 字节' -f ($before - $html.Length))

# 3.1b 站点地址：游戏内部 Site 配置的 url 决定分享链接与分享图上的域名水印
$sitePattern = 'var ur=\{url:"([^"]+)",hosts:\[[^\]]*\]\}'
if ($SiteUrl) {
  $u = $SiteUrl.Trim()
  if ($u -notmatch '^https?://') { $u = 'https://' + $u }
  $u = $u.TrimEnd('/')
  $hostOnly = ([uri]$u).Host
  $m = [regex]::Match($html, $sitePattern)
  if ($m.Success) {
    $old = $m.Groups[1].Value
    $hosts = [regex]::Matches($m.Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value } |
      Where-Object { $_ -ne $old } | Select-Object -Unique
    $list = @($hostOnly) + @($hosts) | Select-Object -Unique
    $new = 'var ur={url:"' + $u + '",hosts:["' + ($list -join '","') + '"]}'
    $html = $html.Replace($m.Value, $new)
    Write-Host ('      站点地址: {0} → {1}' -f $old, $u)
  } else {
    Write-Host '      站点地址: 未找到 Site 配置，跳过' -ForegroundColor Yellow
  }
}

# 3.1c 平台识别：自托管时游戏会判定为 "other" 并在标题界面提示「这不是官方版本」
if ($AsOfficial) {
  $pat = 'IT(t,ur.hosts)?"web":"other"'
  if ($html.Contains($pat)) {
    $html = $html.Replace($pat, '"web"')
    Write-Host '      平台识别: 固定为 web（-AsOfficial）'
  } else {
    Write-Host '      平台识别: 模式未匹配，保持原样' -ForegroundColor Yellow
  }
} else {
  Write-Host '      平台识别: 保持原样（标题界面会提示这是非官方版本）'
}

# 3.2 全解锁外观：只改两处"是否拥有"的判定，不动存档结构、不动数值
if ($UnlockAll) {
  # (1) 宠物拥有判定：原本要 free 或在 p.pets 里，改成"目录里有就算有"
  $petOld = 'Kl=e=>!!wo[e]&&(!!wo[e].free||!!(p&&(p.pets||[]).includes(e)))'
  if ($html.Contains($petOld)) {
    $html = $html.Replace($petOld, 'Kl=e=>!!wo[e]')
    Write-Host '      全解锁: 宠物 4/4（含群限定/绝版）'
  } else {
    Write-Host '      全解锁: 宠物判定未匹配（官方可能改过代码）' -ForegroundColor Yellow
  }

  # (2) 外观可用判定 sf(kind,id)：保留"这个外观是否属于该职业"的校验，其余一律放行
  $sfPattern = 'function sf\(e,t\)\{return[^}]*\}'
  $sfHits = ([regex]::Matches($html, $sfPattern)).Count
  if ($sfHits -eq 1) {
    $html = [regex]::Replace($html, $sfPattern, 'function sf(e,t){return!p||!Zr(e)[t]?!1:!0}')
    Write-Host '      全解锁: 称号/光环/翅膀/坐骑/皮肤 全部可用'
  } else {
    Write-Host ("      全解锁: sf 判定命中 {0} 处（预期 1），已跳过" -f $sfHits) -ForegroundColor Yellow
  }
} else {
  Write-Host '      全解锁: 未开启（外观按正常进度解锁）'
}
# 3.2b 补齐 iOS 主屏幕所需的 meta
if ($NoIndex -and $html -notmatch 'name="robots"') {
  $html = $html.Replace('</head>',
    '<meta name="robots" content="noindex,nofollow,noarchive">' + "`n</head>")
  Write-Host '      反索引: 已注入 noindex meta'
}
if ($html -notmatch 'apple-mobile-web-app-capable') {
  $html = $html.Replace('</head>',
    '<meta name="apple-mobile-web-app-capable" content="yes">' + "`n</head>")
}
if ($html -notmatch 'format-detection') {
  $html = $html.Replace('</head>',
    '<meta name="format-detection" content="telephone=no">' + "`n</head>")
}
if ($html -notmatch 'apple-touch-icon') {
  $html = $html.Replace('</head>',
    '<link rel="apple-touch-icon" href="apple-touch-icon.png">' + "`n</head>")
}

# 3.3 注入 SW 注册片段（放在 </body> 之前，保证 DOM 已就绪）
$snippetPath = Join-Path $staticDir 'pwa-register.html'
$snippet = [IO.File]::ReadAllText($snippetPath, [Text.Encoding]::UTF8)
$marker = '离线 / PWA 支持'

if ($html.Contains($marker)) {
  Write-Host '      已注入过，跳过（重新拉官方包会重置）'
} else {
  $bodyClose = $html.LastIndexOf('</body>')
  if ($bodyClose -lt 0) { $html = $html + "`n" + $snippet }
  else { $html = $html.Insert($bodyClose, $snippet + "`n") }
  Write-Host ('      注入 SW 注册: +{0:N0} 字节' -f $snippet.Length)
}

$outHtml = Join-Path $out 'index.html'
[IO.File]::WriteAllText($outHtml, $html, (New-Object Text.UTF8Encoding($false)))
Write-Host ('      输出 {0} ({1:N0} 字节)' -f $outHtml, (Get-Item $outHtml).Length)

Write-Host '[4/5] 复制静态文件' -ForegroundColor Cyan
# pwa-register.html 是构建期片段，只用于注入，不部署
Get-ChildItem -LiteralPath $staticDir -File | Where-Object { $_.Name -ne 'pwa-register.html' } | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $out $_.Name) -Force
  Write-Host ('      {0,-24} {1,10:N0} 字节' -f $_.Name, $_.Length)
}

# 反索引文件 + 可选的基础认证 Worker（只有 Cloudflare Pages 认 _worker.js）
if ($NoIndex) {
  [IO.File]::WriteAllText((Join-Path $out 'robots.txt'), "User-agent: *`nDisallow: /`n",
    (New-Object Text.UTF8Encoding($false)))
  Write-Host '      robots.txt 已生成（Disallow: /）'
}
if ($BasicAuth) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes($BasicAuth))
  $worker = @"
// Cloudflare Pages 入口：没通过 Basic Auth 一律 401，挡住直接访问
const CREDS = 'Basic $b64';
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
"@
  [IO.File]::WriteAllText((Join-Path $out '_worker.js'), $worker, (New-Object Text.UTF8Encoding($false)))
  Write-Host '      _worker.js 已生成（Basic Auth，仅 Cloudflare Pages 生效）'
}

Write-Host '[5/5] 自检' -ForegroundColor Cyan
$check = [IO.File]::ReadAllText($outHtml)
$siteOk = '（未指定 -SiteUrl）'
if ($SiteUrl) { $siteOk = $check.Contains($u) }

$officialOk = '（未开启 -AsOfficial）'
if ($AsOfficial) { $officialOk = -not $check.Contains('IT(t,ur.hosts)?"web":"other"') }

$unlockOk = '（未开启 -UnlockAll）'
if ($UnlockAll) {
  $unlockOk = $check.Contains('Kl=e=>!!wo[e]') -and
              $check.Contains('function sf(e,t){return!p||!Zr(e)[t]?!1:!0}')
}

$noIndexOk = '（未开启 -NoIndex）'
if ($NoIndex) { $noIndexOk = Test-Path (Join-Path $out 'robots.txt') }

$authOk = '（未设置 -BasicAuth）'
if ($BasicAuth) { $authOk = Test-Path (Join-Path $out '_worker.js') }

$report = [ordered]@{
  'index.html 有 SW 注册'   = $check.Contains("register('./sw.js'")
  'Cloudflare 统计已剥离'   = -not $check.Contains('cloudflareinsights')
  'manifest 链接存在'       = $check.Contains('manifest.webmanifest')
  'apple-touch-icon 存在'   = $check.Contains('apple-touch-icon')
  'sw.js 已就位'            = Test-Path (Join-Path $out 'sw.js')
  '站点地址已改写'          = $siteOk
  '平台固定为 web'          = $officialOk
  '外观已全解锁'            = $unlockOk
  '反索引'                  = $noIndexOk
  '访问认证'                = $authOk
  '体积 (MB)'               = [math]::Round((Get-Item $outHtml).Length / 1MB, 2)
}
$report.GetEnumerator() | ForEach-Object { Write-Host ('      {0,-24} {1}' -f $_.Key, $_.Value) }

Write-Host ''
Write-Host '下一步：把 dist/ 整个目录部署到任意 HTTPS 静态托管，然后 iPhone 用 Safari 打开。' -ForegroundColor Green
