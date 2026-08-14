@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Inkwell · 墨稿（Python DEBUG）
echo.
echo  [DEBUG ONLY] Python 桌面壳 — 非正式发行
echo  正式请用: ..\mogao-tauri\release\Inkwell.exe
echo  书库: %~dp0vault\books
echo  关闭窗口即退出
echo.

where py >nul 2>nul && set "PY=py" && goto :run
where python >nul 2>nul && set "PY=python" && goto :run
echo 未找到 Python 3，请先安装。
pause
exit /b 1

:run
%PY% -c "import webview" 1>nul 2>nul
if errorlevel 1 (
  echo 首次运行：安装 pywebview …
  %PY% -m pip install -r requirements.txt
  if errorlevel 1 (
    echo 安装失败，请手动: pip install -r requirements.txt
    pause
    exit /b 1
  )
)

%PY% desktop.py
if errorlevel 1 (
  echo.
  echo 启动失败。若提示缺少 WebView2，请安装:
  echo   https://developer.microsoft.com/microsoft-edge/webview2/
  pause
)
