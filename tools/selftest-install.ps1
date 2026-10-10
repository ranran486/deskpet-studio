$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$releaseVersion = (Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json).version + '-beta.1'
$installerFile = Join-Path $projectRoot ('release\framework-beta\DeskPet-Framework-Beta-' + $releaseVersion + '-Setup-x64.exe')
$installTestDir = [IO.Path]::GetFullPath((Join-Path $projectRoot ('.runtime\nsis-install-smoke-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())))
if (-not $installTestDir.StartsWith((Join-Path $projectRoot '.runtime\'), [StringComparison]::OrdinalIgnoreCase)) { throw '安装测试目录不在项目范围内' }
if (Test-Path -LiteralPath $installTestDir) { throw '测试目录已存在，拒绝覆盖' }
if (-not (Test-Path -LiteralPath $installerFile)) { throw '安装包不存在' }
$installedBeta = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq 'DeskPet 框架内测版' -or $_.DisplayName -eq 'DeskPet Beta' }
if ($installedBeta) { throw '本机已有内测安装，跳过自动安装测试以免覆盖现有配置' }
$env:DESKPET_DATA_DIR = Join-Path $projectRoot '.runtime\nsis-launch-data'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$installResult = Start-Process -FilePath $installerFile -ArgumentList '/S', "/D=$installTestDir" -WindowStyle Hidden -Wait -PassThru
if ($installResult.ExitCode -ne 0) { throw "安装器退出码 $($installResult.ExitCode)" }
$installedExe = Join-Path $installTestDir 'DeskPet Beta.exe'
if (-not (Test-Path -LiteralPath $installedExe)) { throw '安装器未在指定测试目录生成主程序，请检查安装记录' }
$testExit = 1
try {
  Set-Location -LiteralPath $projectRoot
  & node (Join-Path $projectRoot 'tools\selftest-package.cjs') $installedExe
  $testExit = $LASTEXITCODE
} finally {
  $uninstallerFile = [IO.Path]::GetFullPath((Join-Path $installTestDir 'Uninstall DeskPet Beta.exe'))
  if (-not $uninstallerFile.StartsWith($installTestDir + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw '卸载目标不在测试安装目录内' }
  if (-not (Test-Path -LiteralPath $uninstallerFile)) { throw '测试安装缺少卸载器，未自动清理' }
  $uninstallResult = Start-Process -FilePath $uninstallerFile -ArgumentList '/S', "_?=$installTestDir" -WindowStyle Hidden -Wait -PassThru
  if ($uninstallResult.ExitCode -ne 0) { throw "测试卸载退出码 $($uninstallResult.ExitCode)" }
}
if ($testExit -ne 0) { throw '安装后的程序测试失败' }
if (Test-Path -LiteralPath $installedExe) { throw '卸载后主程序仍存在' }
@{ generatedAt = [DateTimeOffset]::UtcNow.ToString('o'); installer = $installerFile; installDir = $installTestDir; installedAndRan = $true; uninstalled = $true; passed = $true } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $projectRoot '.runtime\installer-smoke-report.json') -Encoding utf8
Write-Output 'NSIS install, packaged app and uninstall checks passed'
