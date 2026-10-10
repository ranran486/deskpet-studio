@echo off
setlocal
cd /d "%~dp0.."
call npm.cmd run dist:beta
if errorlevel 1 (
  echo [deskpet] Packaging failed. Read the error above.
  pause
  exit /b 1
)
explorer.exe "%CD%\release\framework-beta"
echo [deskpet] Send only the Setup exe and the test instructions.
pause
