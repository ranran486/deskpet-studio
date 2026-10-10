@echo off
rem Compatibility wrapper for the shared Node workflow.
setlocal
set "ROOT=%~dp0.."
set "ELECTRON_RUN_AS_NODE="
cd /d "%ROOT%"
call npm.cmd run selfcheck -- %*
exit /b %ERRORLEVEL%
