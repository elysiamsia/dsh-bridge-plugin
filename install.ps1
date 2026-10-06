# 安装 dsh-bridge-plugin 到 DSH profile（本地离线安装）。
#
# 与官方 `dsh plugin add` 等效，只是不联网。做四件事：
#   1. 把插件登记进 profile 的 package.json（dependencies + dsh.profile.bundles）
#   2. 复制插件源码到 <profile>/node_modules/dsh-bridge-plugin
#   3. 备份原 package.json（便于回滚）
#   4. 安装后**真实 import 验证**（不只是查文件存在）
#
# 注意：插件自带 cordis.patch.yml（由 package.json 的 dsh.bundle.patch 声明），
#       所以**不需要**手改 profile 的 cordis.patch.yml。
#
# 用法：
#   pwsh -File install.ps1              # 安装
#   pwsh -File install.ps1 -Uninstall   # 卸载（回滚 package.json + 删目录）

param(
  [string]$Source = $PSScriptRoot,
  [string]$Profile = 'desktop',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$pluginName = 'dsh-bridge-plugin'

# 写回 profile 清单：**必须是无 BOM 的 UTF-8**。
# Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` 会写上 UTF-8 BOM，
# 而 DSH 宿主读取 profile 的 package.json 时直接 JSON.parse、不去 BOM，
# 结果就是启动阶段抛 `Unexpected token '﻿'` → DesktopHostFatalError 崩溃。
function Write-NoBomJson {
  param([string]$LiteralPath, $Object)
  $json = $Object | ConvertTo-Json -Depth 32
  [System.IO.File]::WriteAllText($LiteralPath, $json, (New-Object System.Text.UTF8Encoding($false)))
}

$profileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $Profile
$manifestPath = Join-Path $profileDir 'package.json'
$packageDir = Join-Path $profileDir "node_modules\$pluginName"
$backupPath = "$manifestPath.bak-$pluginName"

if (-not (Test-Path -LiteralPath $manifestPath)) {
  throw "DSH profile not found: $manifestPath"
}
if (-not (Test-Path -LiteralPath (Join-Path $Source 'package.json'))) {
  throw "Plugin source not found: $Source (缺 package.json)"
}

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json

# ────────────────────────────── 卸载 ──────────────────────────────
if ($Uninstall) {
  $deps = @($manifest.dependencies.PSObject.Properties.Name)
  if ($deps -contains $pluginName) {
    $manifest.dependencies.PSObject.Properties.Remove($pluginName)
  }
  $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne $pluginName })
  Write-NoBomJson -LiteralPath $manifestPath -Object $manifest
  if (Test-Path -LiteralPath $packageDir) {
    Remove-Item -LiteralPath $packageDir -Recurse -Force
  }
  Write-Output "已卸载 $pluginName。请完全退出并重启 DeepSeek Harness Desktop。"
  return
}

# ────────────────────────────── 备份 ──────────────────────────────
Copy-Item -LiteralPath $manifestPath -Destination $backupPath -Force
Write-Output "已备份 profile 清单 -> $backupPath"

# ─────────────────── 1. 登记到 dependencies + bundles ───────────────────
if ($null -eq $manifest.dependencies) {
  $manifest | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
}
# 用 link: 让 pnpm/DSH 直接指向源码目录；离线安装则靠下面的复制。
$linkTarget = "link:$($Source -replace '\\','/')"
if (-not ($manifest.dependencies.PSObject.Properties.Name -contains $pluginName)) {
  $manifest.dependencies | Add-Member -NotePropertyName $pluginName -NotePropertyValue $linkTarget -Force
} else {
  $manifest.dependencies.$pluginName = $linkTarget
}
if (-not ($manifest.dsh.profile.bundles -contains $pluginName)) {
  $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles) + @($pluginName)
}
Write-NoBomJson -LiteralPath $manifestPath -Object $manifest
Write-Output "已登记 $pluginName 到 profile 清单（dependencies + bundles）"

# ─────────────────── 2. 复制插件到 node_modules ───────────────────
if (Test-Path -LiteralPath $packageDir) {
  Remove-Item -LiteralPath $packageDir -Recurse -Force
}
New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
# 只复制运行所需内容：lib/ + package.json + cordis.patch.yml（probe/ 是开发自检，不入安装）
foreach ($item in @('lib', 'package.json', 'cordis.patch.yml')) {
  $src = Join-Path $Source $item
  if (Test-Path -LiteralPath $src) {
    Copy-Item -LiteralPath $src -Destination $packageDir -Recurse -Force
  } else {
    throw "缺必需文件：$src"
  }
}
Write-Output "已复制插件到 $packageDir"

# ─────────────────── 3. 静态自检 ───────────────────
$installed = Get-Content -LiteralPath (Join-Path $packageDir 'package.json') -Raw | ConvertFrom-Json
if ($installed.name -ne $pluginName) {
  throw "Unexpected package name: $($installed.name)"
}
if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'lib\index.js'))) {
  throw 'Verification failed: lib/index.js is missing.'
}
if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'lib\mcp-client.js'))) {
  throw 'Verification failed: lib/mcp-client.js is missing.'
}
if (-not (Test-Path -LiteralPath (Join-Path $packageDir 'cordis.patch.yml'))) {
  throw 'Verification failed: cordis.patch.yml is missing.'
}
if ($installed.dsh.bundle.patch -ne './cordis.patch.yml') {
  throw 'Verification failed: unexpected bundle patch declaration.'
}
if (-not (Select-String -LiteralPath $manifestPath -Pattern $pluginName -Quiet)) {
  throw 'Verification failed: the profile manifest does not list the plugin.'
}
# 自检写回的文件没有 BOM——有 BOM 时 DSH 宿主会在启动阶段直接崩，且报错信息很不直观。
$head = ([System.IO.File]::ReadAllBytes($manifestPath))[0..2]
if ($head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF) {
  throw 'Verification failed: profile manifest starts with a UTF-8 BOM; the DSH host will fail to start.'
}

# ─────────────────── 4. 真实 import 验证 ───────────────────
# 从安装位置 import，确认 ESM 语法与模块解析在宿主视角下都成立。
# ⚠️ Windows 上必须用 file:// URL —— 裸 `C:/...` 会被 Node 拒绝：
#    "Only URLs with a scheme in: file, data, and node are supported ... Received protocol 'c:'"
$entryUrl = 'file:///' + ($packageDir -replace '\\', '/') + '/lib/index.js'
$importScript = @"
import('$entryUrl')
  .then(m => {
    if (typeof m.apply !== 'function') { console.error('NO_APPLY'); process.exit(1) }
    if (!m.Config) { console.error('NO_CONFIG'); process.exit(1) }
    console.log('IMPORT_OK name=' + m.name + ' inject=' + JSON.stringify(m.inject))
  })
  .catch(e => { console.error('IMPORT_FAILED: ' + e.message); process.exit(1) })
"@
$importScript | node --input-type=module
if ($LASTEXITCODE -ne 0) {
  throw "安装后 import 验证失败（见上方输出）。回滚请运行：powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall"
}
Write-Output '安装后 import 验证通过'

Write-Output ""
Write-Output "✅ 安装完成：$($installed.name)@$($installed.version) -> $profileDir"
Write-Output "   现在完全退出并重启 DeepSeek Harness Desktop。"
Write-Output "   重启后模型应能看到工具 ask_deepseek。"
