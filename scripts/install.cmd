@echo off
rem Standard reproducible install. Optional npm flags are forwarded.
setlocal
set "ROOT=%~dp0.."
set "npm_config_cache=%ROOT%\.runtime\cache\npm"
set "ELECTRON_CACHE=%ROOT%\.runtime\cache\electron"
if not exist "%ROOT%\.runtime\cache\npm" mkdir "%ROOT%\.runtime\cache\npm"
if not exist "%ROOT%\.runtime\cache\electron" mkdir "%ROOT%\.runtime\cache\electron"
cd /d "%ROOT%"
call npm.cmd ci --no-fund %*
exit /b %ERRORLEVEL%
