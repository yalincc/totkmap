@echo off
rem 一键构建：产出 totknavi-core.exe（需要 Go 1.21+，Windows amd64）
setlocal
set GO=D:\tools\go\bin\go.exe
if not exist "%GO%" set GO=go
%GO% build -ldflags "-s -w" -o "totknavi-core.exe" .
if %errorlevel%==0 (
  echo build ok: totknavi-core.exe
) else (
  echo build failed
)
