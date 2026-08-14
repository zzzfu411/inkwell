@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo  Inkwell / 墨稿
echo  ============================================================
echo  正式客户端（推荐）:
echo    ..\mogao-tauri\release\Inkwell.exe
echo.
echo  本目录 Python 路径仅为 DEBUG ONLY，请勿生产使用:
echo    - 仅接受本机同源浏览器请求
echo    - 能力落后于 Tauri 后端
echo  ============================================================
echo.
echo  调试启动方式:
echo    [1] Python 桌面窗口（调试）
echo    [2] 仅 Python 服务 + 系统浏览器（调试）
echo    [3] 打开正式 Inkwell.exe（若已构建）
echo.
choice /c 123 /n /m "请选择 (1/2/3，默认3): "
if errorlevel 3 goto :inkwell
if errorlevel 2 goto :browser
if errorlevel 1 goto :desktop
goto :inkwell

:inkwell
if exist "%~dp0..\mogao-tauri\release\Inkwell.exe" (
  start "" "%~dp0..\mogao-tauri\release\Inkwell.exe"
  goto :eof
)
echo 未找到 Inkwell.exe，请先运行 mogao-tauri\build-release.bat
echo 或选择 1/2 进入 Python 调试。
pause
goto :eof

:desktop
echo.
echo  [DEBUG] Python 桌面壳 — 非正式
echo.
call "%~dp0start-desktop.bat"
goto :eof

:browser
echo.
echo  [DEBUG] Python 本地服务 — 非正式
echo  UI:    http://127.0.0.1:8765
echo  书库:  %~dp0vault\books
echo  按 Ctrl+C 停止
echo.

where py >nul 2>nul && (
  start "" http://127.0.0.1:8765/
  py server.py
  goto :eof
)
where python >nul 2>nul && (
  start "" http://127.0.0.1:8765/
  python server.py
  goto :eof
)
echo 未找到 Python。请安装 Python 3。
pause
