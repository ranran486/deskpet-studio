@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0.."
call npm.cmd start -- %*
exit /b %ERRORLEVEL%
