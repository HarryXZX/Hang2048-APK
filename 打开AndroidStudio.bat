@echo off
chcp 936 >nul
title 用 Android Studio 打开 Hang2048
setlocal

set "PROJ=%~dp0android"
set "AS="
for %%P in (
  "D:\Program Files\Android\Android Studio\bin\studio64.exe"
  "%LOCALAPPDATA%\Programs\Android Studio\bin\studio64.exe"
  "C:\Program Files\Android\Android Studio\bin\studio64.exe"
) do (
  if exist %%P if not defined AS set "AS=%%~P"
)

if not defined AS (
  echo [错误] 没找到 Android Studio 的 studio64.exe
  echo 请先用 Device Manager 里那个 Android Studio 打开，或者手工改本脚本里的路径。
  pause
  exit /b 1
)

echo 正在用 Android Studio 打开：%PROJ%
echo   如果这是第一次，首次同步会下载 Gradle 8.9（走腾讯镜像），耐心等一下。
echo.
start "" "%AS%" "%PROJ%"
endlocal