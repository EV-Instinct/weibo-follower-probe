@echo off
setlocal
set "edge=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%edge%" set "edge=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%edge%" set "edge=%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"
if not exist "%edge%" (
  echo Microsoft Edge was not found.
  pause
  exit /b 1
)
start "" "%edge%" --user-data-dir="%LOCALAPPDATA%\WeiboFollowerProbe\profiles\A" --no-first-run --new-window "https://weibo.com/"
