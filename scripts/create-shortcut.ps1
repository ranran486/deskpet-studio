<#
  在桌面创建「桌面宠物」快捷方式：双击即启动，没有控制台黑窗。

  用法：
    scripts\create-shortcut.cmd                  只创建桌面快捷方式
    scripts\create-shortcut.cmd -StartMenu       顺便放进开始菜单
    scripts\create-shortcut.cmd -Name "我的猫"    换个名字

  脚本正文含中文，因此必须以「UTF-8 带 BOM」保存：PowerShell 5.1 对无 BOM 的
  .ps1 会按系统 ANSI 代码页解析，中文会变乱码。
#>
[CmdletBinding()]
param(
  [string]$Name = '桌面宠物',
  [switch]$StartMenu
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$vbs = Join-Path $root 'scripts\launch.vbs'
$icon = Join-Path $root 'assets\deskpet-blue-maid.ico'
$dist = Join-Path $root 'dist\main\index.js'

if (-not (Test-Path -LiteralPath $exe)) {
  throw "找不到 Electron 运行时：$exe`n请先双击 scripts\setup.cmd 完成首次安装。"
}
if (-not (Test-Path -LiteralPath $icon)) {
  Write-Host '生成图标…'
  & node (Join-Path $root 'tools\pack-blue-maid.mjs') | Out-Null
}
if (-not (Test-Path -LiteralPath $dist)) {
  Write-Host '首次编译…'
  & cmd.exe /c "`"$(Join-Path $root 'scripts\build.cmd')`""
  if ($LASTEXITCODE -ne 0) { throw '编译失败。先单独运行 scripts\build.cmd 看具体错误。' }
}

# 组策略禁用 Windows Script Host 时退化为直接指向 electron.exe：
# 仍然双击启动、仍然没有黑窗，代价是改了源码不会再自动重编译。
$wshEnabled = $true
try {
  $settings = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows Script Host\Settings' -ErrorAction Stop
  if ($null -ne $settings.Enabled -and $settings.Enabled -eq 0) { $wshEnabled = $false }
} catch { }

$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop)) { throw '取不到桌面目录（Desktop 路径为空）。' }

$targets = @((Join-Path $desktop ($Name + '.lnk')))
if ($StartMenu) {
  $programs = [Environment]::GetFolderPath('Programs')
  if (-not [string]::IsNullOrWhiteSpace($programs)) { $targets += (Join-Path $programs ($Name + '.lnk')) }
}

$shell = New-Object -ComObject WScript.Shell
foreach ($lnkPath in $targets) {
  $lnk = $shell.CreateShortcut($lnkPath)
  if ($wshEnabled) {
    $lnk.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $lnk.Arguments = '"' + $vbs + '"'
    $lnk.Description = '桌面宠物（双击启动，无控制台窗口）'
  }
  else {
    $lnk.TargetPath = $exe
    $lnk.Arguments = '"' + $root + '" --data-dir=.runtime/userdata'
    $lnk.Description = '桌面宠物（双击启动）'
  }
  $lnk.WorkingDirectory = $root
  if (Test-Path -LiteralPath $icon) { $lnk.IconLocation = $icon + ',0' }
  $lnk.Save()
  Write-Host ('已创建： ' + $lnkPath)
}

# 回读验证：不是"我说创建成功了"，而是把快捷方式读回来给你看
foreach ($lnkPath in $targets) {
  $check = $shell.CreateShortcut($lnkPath)
  Write-Host ''
  Write-Host ('快捷方式 : ' + $lnkPath)
  Write-Host ('目标     : ' + $check.TargetPath)
  Write-Host ('参数     : ' + $check.Arguments)
  Write-Host ('起始位置 : ' + $check.WorkingDirectory)
  Write-Host ('图标     : ' + $check.IconLocation)
  Write-Host ('脚本宿主 : ' + $(if ($wshEnabled) { '启用（源码改动会自动重编译）' } else { '被禁用（已退化为直接启动）' }))
}
