@echo off
REM Start the web app (http://localhost:3000) from cmd.exe or Explorer.

setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "PATH=%ROOT%\.toolchain\node-v24.18.0-win-x64;%APPDATA%\npm;%PATH%"

cd /d "%ROOT%" || exit /b 1

if not exist "%ROOT%\.toolchain\node-v24.18.0-win-x64\node.exe" (
  echo ERROR: The portable Node.js toolchain is missing.
  echo Run: powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1
  exit /b 1
)

if not exist "%ROOT%\.env" (
  echo ERROR: .env is missing.
  echo Run: powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1
  exit /b 1
)

call "%~dp0start-db.cmd"
if errorlevel 1 exit /b 1

echo.
echo Starting the web app on http://localhost:3000
echo Press Ctrl+C to stop.
echo.
call pnpm dev
set "EXIT_CODE=%ERRORLEVEL%"

endlocal & exit /b %EXIT_CODE%
