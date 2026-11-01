@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==================================================================
echo   TOTK-PC 坐标直达秒锁启动器
echo ==================================================================
echo 请输入游戏右下角当前显示的坐标（以空格隔开，如：2423 -2866 216）：
set /p cinput=">> "
if "%cinput%"=="" (
    echo 未输入坐标，按回车退出。
    pause
    exit /b
)
start "" "http://127.0.0.1:8766/?follow=1"
totknavi-pc.exe --serve --coords %cinput% --log pos.log
echo.
echo === exited ===
pause

