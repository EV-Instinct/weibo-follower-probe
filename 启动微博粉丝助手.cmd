@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "%~dp0启动新版微博粉丝助手.exe" (
  start "" "%~dp0启动新版微博粉丝助手.exe"
) else if exist "%~dp0dist\微博粉丝助手_0.3.0\微博粉丝助手.exe" (
  start "" "%~dp0dist\微博粉丝助手_0.3.0\微博粉丝助手.exe"
) else (
  echo 未找到预编译的可执行文件，正在以源码模式启动...
  npm start
)
