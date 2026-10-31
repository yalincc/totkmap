@echo off
chcp 65001 >nul
cd /d "%~dp0"
totknavi-pc.exe --watch --log pos.log
echo.
echo === exited ===
pause
