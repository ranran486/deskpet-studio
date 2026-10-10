@echo off
rem Electron 44 exposes an explicit official installer instead of a lifecycle hook.
setlocal
if /i "%~1"=="--sandbox" goto sandbox
call "%~dp0install.cmd" %*
if errorlevel 1 exit /b 1
node "%~dp0..\tools\setup-runtime.mjs"
exit /b %ERRORLEVEL%
:sandbox
call "%~dp0install.cmd" --ignore-scripts
if errorlevel 1 exit /b 1
python "%~dp0fetch-electron.py"
exit /b %ERRORLEVEL%
