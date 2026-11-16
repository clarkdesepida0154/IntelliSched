@echo off
setlocal
cd /d "%~dp0"
echo IntelliSched: making the handover file for the office PC.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0make-handover.ps1" %*
set CODE=%ERRORLEVEL%
echo.
pause
exit /b %CODE%
