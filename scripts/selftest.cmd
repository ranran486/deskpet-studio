@echo off
setlocal
cd /d "%~dp0.."
call npm.cmd test
exit /b %ERRORLEVEL%
