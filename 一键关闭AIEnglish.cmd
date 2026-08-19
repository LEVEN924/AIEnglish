@echo off
chcp 65001 >nul
set "PROJECT_DIR=%~dp0"
where pwsh.exe >nul 2>&1
if errorlevel 1 (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_DIR%scripts\stop-app.ps1"
) else (
  pwsh.exe -NoLogo -NoProfile -File "%PROJECT_DIR%scripts\stop-app.ps1"
)
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
