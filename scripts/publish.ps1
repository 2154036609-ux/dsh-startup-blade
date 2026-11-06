<#
.SYNOPSIS
  把 dsh-startup-blade 一次性发布到 DSH 插件市场（建仓库 + 推代码 + 发 npm + 出 PR 指引）。

.DESCRIPTION
  这个脚本只做**可重复、可回滚**的动作，且每一步失败都会停下来说明原因：
    1. 环境自检（git / gh / gh 登录态 / npm 登录态）
    2. 把 package.json / LICENSE / README / market/*.yml 里的 OWNER 占位符换成你的 GitHub 用户名
    3. git init + commit + `gh repo create --public --push` + 加 `dsh-plugin` topic
    4. `npm publish --access public`（可用 -SkipNpm 跳过）
    5. 打印收录 PR 的两种做法（脚本不替你提 PR：仓库要满 1 天才能过 CI）

  为什么 PR 不自动提：awesome-dsh-plugin 的 CI 要求**仓库创建满 1 天**，刚建的仓库提上去必红。
  脚本会把条目文件、fork/分支命令、PR 正文都准备好，到点执行一条 `gh pr create` 即可。

.PARAMETER Owner
  你的 GitHub 用户名（必填）。会写进 package.json 的 repository/homepage/bugs 与条目 YAML。

.PARAMETER Repo
  仓库名，默认 dsh-startup-blade。

.PARAMETER SkipNpm
  跳过 npm 发布（不发 npm 也能上架，市场里大量条目 npm 为 null）。

.EXAMPLE
  ./publish.ps1 -Owner yourname
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Owner,
  [string]$Repo = 'dsh-startup-blade',
  [switch]$SkipNpm
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Need($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
    throw "缺少 $name。$hint"
  }
}
function Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }

Step '1/5 环境自检'
Need git '装 Git for Windows: https://git-scm.com/download/win'
Need gh '装 GitHub CLI: winget install GitHub.cli'
$auth = gh auth status 2>&1 | Out-String
if ($auth -notmatch 'Logged in') { throw "gh 未登录。先运行：gh auth login" }
if (-not $SkipNpm) {
  $who = (cmd /c "npm whoami 2>&1" | Out-String)
  if ($who -match 'ENEEDAUTH|not authenticated') { throw "npm 未登录。先运行：npm login（或设 NPM_TOKEN 后 npm config set //registry.npmjs.org/:_authToken）" }
  else { Write-Host "npm 已登录：$($who.Trim())" }
}

Step "2/5 写入仓库地址（OWNER → $Owner）"
$files = @('package.json', 'LICENSE', 'README.en.md', 'market/OWNER__dsh-startup-blade.yml')
foreach ($f in $files) {
  if (-not (Test-Path $f)) { Write-Warning "跳过不存在的文件：$f"; continue }
  $text = Get-Content $f -Raw -Encoding UTF8
  $text = $text.Replace('OWNER', $Owner)
  Set-Content -Path $f -Value $text -Encoding UTF8 -NoNewline
}
$oldYml = 'market/OWNER__dsh-startup-blade.yml'
$newYml = "market/$($Owner)__$Repo.yml"
if (Test-Path $oldYml) {
  $text = Get-Content $oldYml -Raw -Encoding UTF8
  $text = $text.Replace("https://github.com/$Owner/dsh-startup-blade", "https://github.com/$Owner/$Repo")
  $text = $text.Replace("name: $Owner/dsh-startup-blade", "name: $Owner/$Repo")
  Set-Content -Path $newYml -Value $text -Encoding UTF8 -NoNewline
  Remove-Item $oldYml
}
Write-Host "条目文件：$newYml"

Step '3/5 建仓库并推送'
if (-not (Test-Path '.git')) {
  git init -b main | Out-Null
  git add -A
  git -c user.name=$Owner -c user.email="$Owner@users.noreply.github.com" commit -m "dsh-startup-blade 1.0.0" | Out-Null
}
gh repo view "$Owner/$Repo" 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
  gh repo create "$Owner/$Repo" --public --source . --remote origin --push
} else {
  git remote get-url origin 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { git remote add origin "https://github.com/$Owner/$Repo.git" }
  git push -u origin main
}
gh repo edit "$Owner/$Repo" --add-topic dsh-plugin | Out-Null
Write-Host "仓库：https://github.com/$Owner/$Repo （已加 dsh-plugin topic）"

if (-not $SkipNpm) {
  Step '4/5 发布 npm'
  npm publish --access public
} else {
  Step '4/5 跳过 npm 发布'
}

Step '5/5 收录 PR（需仓库满 1 天后执行）'
Write-Host @"
条目文件已就绪：$newYml

到点（仓库创建满 24 小时后）执行：
  git clone https://github.com/$Owner/awesome-dsh-plugin 2>`$null
  # 若没有 fork：
  gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
  # 复制条目并提交：
  New-Item -ItemType Directory -Force awesome-dsh-plugin/data/plugins | Out-Null
  Copy-Item "$newYml" "awesome-dsh-plugin/data/plugins/$($Owner)__$Repo.yml"
  cd awesome-dsh-plugin && git checkout -b add-$Repo
  git add data/plugins/$($Owner)__$Repo.yml
  git commit -m "Add $Repo"
  git push -u origin add-$Repo
  gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin --head "$Owner:add-$Repo" ``
    --title "Add $Repo" ``
    --body "拔刀启动动画：刀光沿刀轴扫出、定格在当前壁纸帧。不含任何美术素材。"

合并后市场自动收录，安装命令形如：
  dsh plugin --profile web add github:$Owner/$Repo
"@ -ForegroundColor Gray
