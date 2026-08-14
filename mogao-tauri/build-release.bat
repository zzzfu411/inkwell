@echo off
setlocal
cd /d "%~dp0"
title Inkwell Release Build

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-release.ps1" -OpenRelease
set "BUILD_EXIT=%ERRORLEVEL%"
if not "%BUILD_EXIT%"=="0" echo Release build failed with exit code %BUILD_EXIT%.
pause
exit /b %BUILD_EXIT%
