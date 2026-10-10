@echo off
rem Create the "desktop pet" shortcut on the Desktop: double-click to launch, no console window.
rem ASCII only: cmd.exe parses .cmd with the system codepage, non-ASCII breaks the lines.
setlocal
set "ELECTRON_RUN_AS_NODE="
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-shortcut.ps1" %*
exit /b %ERRORLEVEL%
