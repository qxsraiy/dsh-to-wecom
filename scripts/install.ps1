# dsh-to-wecom 安装脚本（Windows PowerShell）
#  1) 在 <profile>/node_modules 下建 junction 指向本仓库
#  2) 在 <profile>/package.json 里补 dependencies 与 dsh.profile.bundles（写前自动备份）
# 用法:
#   .\scripts\install.ps1                 # 默认 profile=desktop
#   .\scripts\install.ps1 -Profile web
#   .\scripts\install.ps1 -DryRun        # 只打印将要做什么
param(
  [string]$Profile = 'desktop',
  [string]$RepoDir = (Split-Path -Parent $PSScriptRoot),
  [string]$DshHome = '',
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME } else { $DshHome = Join-Path $env:USERPROFILE '.dsh' }
}
$profileDir = Join-Path (Join-Path $DshHome 'profiles') $Profile
if (-not (Test-Path $profileDir)) { throw ('找不到 profile 目录: ' + $profileDir + ' —— 先启动一次 DSH 让它生成') }
$pkgPath = Join-Path $profileDir 'package.json'
$linkPath = Join-Path (Join-Path $profileDir 'node_modules') 'dsh-wecom-notify'

Write-Host ('仓库目录 : ' + $RepoDir)
Write-Host ('profile  : ' + $profileDir)
Write-Host ('链接路径 : ' + $linkPath)

if (-not $DryRun) {
  if (Test-Path $linkPath) {
    $existing = Get-Item $linkPath -Force
    if ($existing.LinkType) { Remove-Item -Force $linkPath } else { throw ($linkPath + ' 已存在且不是链接，先手动删掉再装') }
  }
  New-Item -ItemType Junction -Path $linkPath -Target $RepoDir | Out-Null
  Write-Host '已建立 junction'
}

$raw = Get-Content $pkgPath -Raw -Encoding UTF8
$json = $raw | ConvertFrom-Json
if (-not $json.PSObject.Properties.Name.Contains('dependencies')) { $json | Add-Member -NotePropertyName dependencies -NotePropertyValue (New-Object psobject) }
if ($json.dependencies.PSObject.Properties.Name.Contains('dsh-wecom-notify')) {
  $json.dependencies.'dsh-wecom-notify' = ('link:' + $RepoDir)
} else {
  $json.dependencies | Add-Member -NotePropertyName 'dsh-wecom-notify' -NotePropertyValue ('link:' + $RepoDir)
}
if (-not $json.dsh -or -not $json.dsh.profile -or -not $json.dsh.profile.bundles) { throw '这个 package.json 不像 DSH profile（缺 dsh.profile.bundles）' }
$bundles = @($json.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-wecom-notify') {
  $bundles += 'dsh-wecom-notify'
  $json.dsh.profile.bundles = $bundles
  Write-Host 'bundles 已追加 dsh-wecom-notify'
} else {
  Write-Host 'bundles 里已有 dsh-wecom-notify'
}

if ($DryRun) {
  Write-Host '--- DryRun: 将写入的 package.json ---'
  $json | ConvertTo-Json -Depth 10
  exit 0
}

$backup = $pkgPath + '.bak-dsh-to-wecom'
Copy-Item $pkgPath $backup -Force
$text = ($json | ConvertTo-Json -Depth 10) + [string][char]10
[System.IO.File]::WriteAllText($pkgPath, $text, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('已更新 package.json（备份: ' + $backup + '）')
Write-Host ''
Write-Host '下一步：完全退出 DSH 再启动 -> 设置 -> 插件 -> 通知推送 -> 选服务/填凭据 -> 发送测试'
Write-Host '然后到要收通知的会话，点标题右上角的 推送关 变绿。'
