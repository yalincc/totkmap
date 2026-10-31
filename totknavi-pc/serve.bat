@echo off
chcp 65001 >nul
cd /d "%~dp0"
start "" http://127.0.0.1:8766/
totknavi-pc.exe --serve --log pos.log
echo.
echo === exited ===
pause
