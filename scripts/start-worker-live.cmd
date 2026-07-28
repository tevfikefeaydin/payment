@echo off
REM Start the worker against the LIVE (Neon) database, from cmd.exe or Explorer.
REM Reads variables from .env.live at the repository root.

setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
set "PATH=%ROOT%\.toolchain\node-v24.18.0-win-x64;%APPDATA%\npm;%PATH%"

cd /d "%ROOT%" || exit /b 1

if not exist "%ROOT%\.env.live" (
  echo ERROR: .env.live is missing at the repository root.
  exit /b 1
)

for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%ROOT%\.env.live") do set "%%a=%%b"

echo.
echo Starting the LIVE worker (database: Neon). Health on http://localhost:%WORKER_HEALTH_PORT%/health/ready
echo Press Ctrl+C to stop.
echo.
call pnpm dev:worker
set "EXIT_CODE=%ERRORLEVEL%"

endlocal & exit /b %EXIT_CODE%
