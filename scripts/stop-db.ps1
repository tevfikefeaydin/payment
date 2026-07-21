#Requires -Version 5.1
<#
.SYNOPSIS
    Stops the local portable PostgreSQL cluster created by setup-local.ps1.

.DESCRIPTION
    Shuts the cluster down with pg_ctl's `fast` mode: existing transactions are
    rolled back and connections are closed, but the shutdown checkpoint still
    runs, so the cluster stays consistent and restarts cleanly.

    Idempotent: if the cluster is not running, this reports that and exits 0.

.PARAMETER Immediate
    Use `immediate` mode instead. Skips the shutdown checkpoint, so the next
    start performs crash recovery. Only for a cluster that refuses to stop.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\stop-db.ps1
#>

[CmdletBinding()]
param(
    [switch]$Immediate
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$PgPort = 55432

$RepoRoot     = Split-Path -Parent $PSScriptRoot
$ToolchainDir = Join-Path $RepoRoot ".toolchain"
$PgDir        = Join-Path $ToolchainDir "pgsql"
$PgDataDir    = Join-Path $ToolchainDir "pgdata"

$pgCtl     = Join-Path $PgDir "bin\pg_ctl.exe"
$pgIsReady = Join-Path $PgDir "bin\pg_isready.exe"

if (-not (Test-Path $pgCtl)) {
    throw "PostgreSQL binaries not found at $PgDir. Run scripts\setup-local.ps1 first."
}

& $pgIsReady --host=127.0.0.1 --port=$PgPort --quiet 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Host "PostgreSQL is not running on 127.0.0.1:$PgPort" -ForegroundColor DarkGray
    exit 0
}

$mode = if ($Immediate) { "immediate" } else { "fast" }

& $pgCtl --pgdata="$PgDataDir" --mode=$mode stop | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "pg_ctl stop failed (exit $LASTEXITCODE)."
}

Write-Host "PostgreSQL stopped ($mode)." -ForegroundColor Green
