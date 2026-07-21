@echo off
REM Start the portable local PostgreSQL cluster from cmd.exe or Explorer.

setlocal
for %%I in ("%~dp0..") do set "ROOT=%%~fI"

if not exist "%ROOT%\.toolchain\pgsql\bin\pg_ctl.exe" (
  echo ERROR: The portable PostgreSQL toolchain is missing.
  echo Run: powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-db.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

endlocal & exit /b %EXIT_CODE%
