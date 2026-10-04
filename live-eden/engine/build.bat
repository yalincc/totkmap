@echo off
rem Build xnavi-core-eden.exe (Go 1.21+, Windows amd64)
setlocal
set GO=D:\tools\go\bin\go.exe
if not exist "%GO%" set GO=go
%GO% build -ldflags "-s -w" -o "xnavi-core-eden.exe" .
if %errorlevel%==0 (
  echo build ok: xnavi-core-eden.exe
) else (
  echo build failed
)
