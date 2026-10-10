@echo off
rem Compatibility wrapper; the single build implementation is tools/build.mjs.
setlocal
set "ROOT=%~dp0.."
cd /d "%ROOT%"
node tools\build.mjs
exit /b %ERRORLEVEL%
