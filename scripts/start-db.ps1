#Requires -Version 5.1
<#
.SYNOPSIS
    Starts the local portable PostgreSQL cluster created by setup-local.ps1.

.DESCRIPTION
    Starts the cluster in .toolchain/pgdata on 127.0.0.1:55432, logging to
    .toolchain/pg.log.

    Idempotent: if the cluster is already accepting connections, this reports
    that and exits 0.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\start-db.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PgPort = 55432

$RepoRoot     = Split-Path -Parent $PSScriptRoot
$ToolchainDir = Join-Path $RepoRoot ".toolchain"
$PgDir        = Join-Path $ToolchainDir "pgsql"
$PgDataDir    = Join-Path $ToolchainDir "pgdata"
$PgLog        = Join-Path $ToolchainDir "pg.log"

$pgCtl     = Join-Path $PgDir "bin\pg_ctl.exe"
$pgIsReady = Join-Path $PgDir "bin\pg_isready.exe"

if (-not (Test-Path $pgCtl)) {
    throw "PostgreSQL binaries not found at $PgDir. Run scripts\setup-local.ps1 first."
}
if (-not (Test-Path (Join-Path $PgDataDir "PG_VERSION"))) {
    throw "No cluster at $PgDataDir. Run scripts\setup-local.ps1 first."
}

& $pgIsReady --host=127.0.0.1 --port=$PgPort --quiet 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) {
    Write-Host "PostgreSQL is already running on 127.0.0.1:$PgPort" -ForegroundColor DarkGray
    exit 0
}

& $pgCtl --pgdata="$PgDataDir" --log="$PgLog" --options="-p $PgPort" start | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "pg_ctl start failed (exit $LASTEXITCODE). See $PgLog"
}

# pg_ctl returns once the postmaster is launched, which is slightly before it
# accepts connections. Poll rather than sleeping a fixed amount.
$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    & $pgIsReady --host=127.0.0.1 --port=$PgPort --quiet 2>&1 | Out-Null
    $ready = ($LASTEXITCODE -eq 0)
} while (-not $ready -and (Get-Date) -lt $deadline)

if (-not $ready) {
    throw "PostgreSQL started but is not accepting connections on port $PgPort. See $PgLog"
}

Write-Host "PostgreSQL running on 127.0.0.1:$PgPort" -ForegroundColor Green
Write-Host "  data: $PgDataDir"
Write-Host "  log:  $PgLog"
