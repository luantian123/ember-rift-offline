# 一键部署到 GitHub Pages
#
# 用法（把 <TOKEN> 换成 GitHub Personal Access Token，勾 repo 权限就够了）：
#   $env:GITHUB_TOKEN = '<TOKEN>'
#   .\deploy-github.ps1 -Repo ember-rift-offline
#
# 它做的事：建仓库(已存在则跳过) → 把 dist/ 推上去 → 开启 Pages → 等构建完成 → 打印网址。
# 仓库必须是 public，免费账号的 Pages 不支持私有仓库（要私有就用 Cloudflare Pages）。

param(
  [Parameter(Mandatory = $true)][string]$Repo,
  [string]$Token = $env:GITHUB_TOKEN,
  [ValidateSet('public', 'private')][string]$Visibility = 'public',
  [string]$OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dist = Join-Path $here $OutDir

if (-not (Test-Path (Join-Path $dist 'index.html'))) {
  throw "没找到 $dist\index.html，先跑 .\build.ps1 -UnlockAll"
}

if (-not $Token) {
  Write-Host ''
  Write-Host '没有 token —— 两条路二选一：' -ForegroundColor Yellow
  Write-Host '  A) 网页拖拽（不用 token）：'
  Write-Host '     github.com/new → 建仓库 → Add file → Upload files → 把 dist 里所有文件拖进去 → Commit'
  Write-Host '     Settings → Pages → Source: Deploy from a branch → main / (root) → Save'
  Write-Host '  B) 生成 token 后重跑本脚本：'
  Write-Host '     github.com/settings/tokens → Generate new token (classic) → 勾 repo → 复制'
  Write-Host ("     `$env:GITHUB_TOKEN = 'ghp_xxx'; .\deploy-github.ps1 -Repo {0}" -f $Repo)
  Write-Host ''
  exit 1
}

$api = 'https://api.github.com'
$headers = @{
  Authorization          = "token $Token"
  Accept                 = 'application/vnd.github+json'
  'User-Agent'           = 'ember-offline-deploy'
  'X-GitHub-Api-Version' = '2022-11-28'
}

Write-Host '[1/5] 验证 token' -ForegroundColor Cyan
$me = Invoke-RestMethod -Uri "$api/user" -Headers $headers -Method Get
$login = $me.login
Write-Host "      账号: $login"

Write-Host '[2/5] 建仓库' -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri "$api/user/repos" -Headers $headers -Method Post -Body (
    @{ name = $Repo; private = ($Visibility -eq 'private'); auto_init = $false; has_issues = $false } | ConvertTo-Json
  ) | Out-Null
  Write-Host "      已创建 $login/$Repo（$Visibility）"
} catch {
  $code = $null
  try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
  if ($code -eq 422) {
    Write-Host "      仓库已存在，直接复用：$login/$Repo"
  } else {
    throw
  }
}

Write-Host '[3/5] 推送 dist/' -ForegroundColor Cyan
Push-Location $dist
try {
  if (-not (Test-Path '.git')) { git init -b main | Out-Null }
  git add -A
  git -c "user.name=$login" -c "user.email=$login@users.noreply.github.com" `
    commit -m "ember rift offline build $(Get-Date -Format 'yyyy-MM-dd HH:mm')" --allow-empty | Out-Null

  $origin = "https://github.com/$login/$Repo.git"
  $remotes = @(git remote)
  if ($remotes -contains 'origin') { git remote set-url origin $origin } else { git remote add origin $origin }

  # token 只放在这次命令里，不写进 .git/config
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$Token"))
  git -c "http.extraheader=AUTHORIZATION: basic $b64" push -u origin main --force 2>&1 |
    ForEach-Object { Write-Host "      $_" }
} finally {
  Pop-Location
}

Write-Host '[4/5] 开启 Pages' -ForegroundColor Cyan
try {
  Invoke-RestMethod -Uri "$api/repos/$login/$Repo/pages" -Headers $headers -Method Post -Body (
    @{ source = @{ branch = 'main'; path = '/' } } | ConvertTo-Json
  ) | Out-Null
  Write-Host '      Pages 已开启（main / root）'
} catch {
  $code = $null
  try { $code = $_.Exception.Response.StatusCode.value__ } catch {}
  if ($code -eq 409) { Write-Host '      Pages 之前已开启，跳过' }
  else { Write-Host '      自动开启失败，去 Settings → Pages 手动选 main / (root)' -ForegroundColor Yellow }
}

Write-Host '[5/5] 等构建' -ForegroundColor Cyan
$url = "https://$login.github.io/$Repo/"
$ready = $false
for ($i = 0; $i -lt 24; $i++) {
  Start-Sleep -Seconds 5
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 15 -Method Head
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
  Write-Host "      ...第 $($i + 1) 次探测还没好"
}

Write-Host ''
if ($ready) {
  Write-Host '好了，网址是：' -ForegroundColor Green
} else {
  Write-Host '通常 1~2 分钟就好，稍等再看这个地址：' -ForegroundColor Yellow
}
Write-Host "  $url" -ForegroundColor Green
Write-Host ''
Write-Host 'iPhone：Safari 打开上面这个地址 → 分享 → 添加到主屏幕 → 从图标启动（首次联网 3 秒建缓存）'
Write-Host ("之后断网可玩。想改分享链接域名就重跑：.\build.ps1 -UnlockAll -SiteUrl '{0}{1}/'" -f $login, $Repo) -ForegroundColor DarkGray
