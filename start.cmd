@echo off
REM Prepare local services, then open the web app and worker in separate windows.

setlocal
set "ROOT=%~dp0"
set "PATH=%ROOT%.toolchain\node-v24.18.0-win-x64;%APPDATA%\npm;%PATH%"

cd /d "%ROOT%" || exit /b 1

if not exist "%ROOT%.toolchain\node-v24.18.0-win-x64\node.exe" (
  echo ERROR: The portable toolchain is missing.
  echo Run: powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1
  pause
  exit /b 1
)

call "%ROOT%scripts\start-db.cmd"
if errorlevel 1 (
  pause
  exit /b 1
)

echo Applying database migrations and guards...
call pnpm db:migrate
if errorlevel 1 (
  echo ERROR: Database migration failed.
  pause
  exit /b 1
)

echo Starting the web app and worker in separate windows...
start "Web - localhost 3000" /D "%ROOT%" "%ComSpec%" /d /k call "%ROOT%scripts\start-web.cmd"
start "Worker - localhost 3001" /D "%ROOT%" "%ComSpec%" /d /k call "%ROOT%scripts\start-worker.cmd"

echo.
echo Web:    http://localhost:3000
echo Worker: http://localhost:3001/health/live
echo.
echo Keep the two new windows open while using the app.
timeout /t 4 /nobreak >nul

endlocal
