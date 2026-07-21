#Requires -Version 5.1
<#
.SYNOPSIS
    Bootstraps a complete local PayRecon toolchain on a machine with no Node.js,
    no package manager and no PostgreSQL.

.DESCRIPTION
    Reproduces exactly the environment this repository was built and verified
    with:

      1. Portable Node.js 24.18.0  -> .toolchain/node-v24.18.0-win-x64
      2. pnpm 10.34.5              -> installed with the portable npm
      3. Portable PostgreSQL 17.6  -> .toolchain/pgsql
      4. A cluster                 -> .toolchain/pgdata, listening on 127.0.0.1:55432
      5. Databases                 -> payrecon_dev, payrecon_test, payrecon_e2e
      6. .env                      -> copied from .env.example with real
                                      ENCRYPTION_KEY and AUTH_SECRET values

    IDEMPOTENT. Every step checks for existing state first, so re-running is
    safe: an existing toolchain is reused, an existing cluster is left alone,
    existing databases are not recreated, and an existing .env is NEVER
    overwritten.

    Nothing here is committed: .toolchain/ and .env are both git-ignored.

.PARAMETER SkipDatabase
    Install Node and pnpm only. Useful when PostgreSQL is provided some other
    way (Docker Compose, a managed instance).

.PARAMETER Force
    Re-download and re-extract the portable toolchains even if present. Does NOT
    recreate the cluster and does NOT overwrite .env.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup-local.ps1
#>

[CmdletBinding()]
param(
    [switch]$SkipDatabase,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

# --- Configuration -----------------------------------------------------------

$NodeVersion = "24.18.0"
$PgVersion   = "17.6-1"
$PgPort      = 55432
$PgSuperuser = "postgres"
$PgPassword  = "payrecon_dev_pw"
$Databases   = @("payrecon_dev", "payrecon_test", "payrecon_e2e")

$RepoRoot     = Split-Path -Parent $PSScriptRoot
$ToolchainDir = Join-Path $RepoRoot ".toolchain"
$NodeDir      = Join-Path $ToolchainDir "node-v$NodeVersion-win-x64"
$PgDir        = Join-Path $ToolchainDir "pgsql"
$PgDataDir    = Join-Path $ToolchainDir "pgdata"
$PgLog        = Join-Path $ToolchainDir "pg.log"
$DownloadDir  = Join-Path $ToolchainDir "downloads"

$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$PgUrl   = "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip"

# --- Output helpers ----------------------------------------------------------

function Write-Step  { param([string]$Message) Write-Host "`n==> $Message" -ForegroundColor Cyan }
function Write-Ok    { param([string]$Message) Write-Host "    [ok]   $Message" -ForegroundColor Green }
function Write-Skip  { param([string]$Message) Write-Host "    [skip] $Message" -ForegroundColor DarkGray }
function Write-Warn2 { param([string]$Message) Write-Host "    [warn] $Message" -ForegroundColor Yellow }

function Get-Archive {
    param([string]$Url, [string]$Destination)

    if ((Test-Path $Destination) -and -not $Force) {
        Write-Skip "already downloaded: $(Split-Path -Leaf $Destination)"
        return
    }

    Write-Host "    downloading $Url"
    # TLS 1.2 is not the default on Windows PowerShell 5.1.
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $previous = $ProgressPreference
    $ProgressPreference = "SilentlyContinue"   # a progress bar makes this ~10x slower
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    } finally {
        $ProgressPreference = $previous
    }
    Write-Ok "downloaded $([math]::Round((Get-Item $Destination).Length / 1MB, 1)) MB"
}

# --- 0. Directories ----------------------------------------------------------

Write-Step "Preparing $ToolchainDir"
foreach ($dir in @($ToolchainDir, $DownloadDir)) {
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}
Write-Ok "toolchain directory ready"

# --- 1. Node.js --------------------------------------------------------------

Write-Step "Node.js $NodeVersion"

$nodeExe = Join-Path $NodeDir "node.exe"
if ((Test-Path $nodeExe) -and -not $Force) {
    Write-Skip "already installed at $NodeDir"
} else {
    $nodeZip = Join-Path $DownloadDir "node-v$NodeVersion-win-x64.zip"
    Get-Archive -Url $NodeUrl -Destination $nodeZip

    Write-Host "    extracting..."
    if ((Test-Path $NodeDir) -and $Force) {
        Remove-Item -Recurse -Force $NodeDir
    }
    Expand-Archive -Path $nodeZip -DestinationPath $ToolchainDir -Force
    Write-Ok "extracted to $NodeDir"
}

if (-not (Test-Path $nodeExe)) {
    throw "Node.js installation failed: $nodeExe not found."
}

# Put the portable toolchain first on PATH for the rest of this script.
$npmGlobal = Join-Path $env:APPDATA "npm"
$env:PATH  = "$NodeDir;$npmGlobal;$env:PATH"

$nodeReported = & $nodeExe --version
Write-Ok "node $nodeReported"

# --- 2. pnpm -----------------------------------------------------------------

Write-Step "pnpm"

$pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
if ($pnpmCmd -and -not $Force) {
    $pnpmReported = & pnpm --version
    Write-Skip "already installed (pnpm $pnpmReported)"
} else {
    Write-Host "    installing pnpm globally with npm..."
    $npmCli = Join-Path $NodeDir "npm.cmd"
    & $npmCli install --global "pnpm@10.34.5" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "npm install --global pnpm failed (exit $LASTEXITCODE)." }
    Write-Ok "pnpm installed"
}

# --- 3. PostgreSQL binaries --------------------------------------------------

if ($SkipDatabase) {
    Write-Step "PostgreSQL"
    Write-Skip "-SkipDatabase was passed"
} else {
    Write-Step "PostgreSQL $PgVersion (portable binaries)"

    $initdbExe = Join-Path $PgDir "bin\initdb.exe"
    if ((Test-Path $initdbExe) -and -not $Force) {
        Write-Skip "already installed at $PgDir"
    } else {
        $pgZip = Join-Path $DownloadDir "postgresql-$PgVersion-windows-x64-binaries.zip"
        Get-Archive -Url $PgUrl -Destination $pgZip

        Write-Host "    extracting (this takes a minute)..."
        if ((Test-Path $PgDir) -and $Force) {
            Remove-Item -Recurse -Force $PgDir
        }
        # The archive contains a top-level `pgsql/` directory.
        Expand-Archive -Path $pgZip -DestinationPath $ToolchainDir -Force
        Write-Ok "extracted to $PgDir"
    }

    if (-not (Test-Path $initdbExe)) {
        throw "PostgreSQL installation failed: $initdbExe not found."
    }

    # --- 4. Cluster ----------------------------------------------------------

    Write-Step "PostgreSQL cluster at $PgDataDir"

    if (Test-Path (Join-Path $PgDataDir "PG_VERSION")) {
        Write-Skip "cluster already initialised"
    } else {
        Write-Host "    running initdb..."

        # initdb reads the superuser password from a file so it never appears in
        # a process listing or in this script's console output.
        $pwFile = Join-Path $env:TEMP "payrecon-initdb-pw.txt"
        try {
            Set-Content -Path $pwFile -Value $PgPassword -NoNewline -Encoding ascii

            & $initdbExe `
                --pgdata="$PgDataDir" `
                --username="$PgSuperuser" `
                --pwfile="$pwFile" `
                --auth-host=scram-sha-256 `
                --auth-local=scram-sha-256 `
                --encoding=UTF8 `
                --locale=C | Out-Null

            if ($LASTEXITCODE -ne 0) { throw "initdb failed (exit $LASTEXITCODE)." }
        } finally {
            if (Test-Path $pwFile) { Remove-Item -Force $pwFile }
        }

        # Bind to loopback only. This cluster is for development and must never
        # be reachable from the network.
        $confPath = Join-Path $PgDataDir "postgresql.conf"
        Add-Content -Path $confPath -Value @"

# --- Added by scripts/setup-local.ps1 ---
listen_addresses = '127.0.0.1'
port = $PgPort
"@
        Write-Ok "cluster initialised on 127.0.0.1:$PgPort"
    }

    # --- 5. Start and create databases ---------------------------------------

    Write-Step "Starting PostgreSQL"

    $pgCtl   = Join-Path $PgDir "bin\pg_ctl.exe"
    $pgIsReady = Join-Path $PgDir "bin\pg_isready.exe"

    & $pgIsReady --host=127.0.0.1 --port=$PgPort --quiet 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Skip "already running on port $PgPort"
    } else {
        & $pgCtl --pgdata="$PgDataDir" --log="$PgLog" --options="-p $PgPort" start | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "pg_ctl start failed (exit $LASTEXITCODE). See $PgLog" }
        Start-Sleep -Seconds 2
        Write-Ok "started (log: $PgLog)"
    }

    Write-Step "Databases"

    $psql      = Join-Path $PgDir "bin\psql.exe"
    $createdb  = Join-Path $PgDir "bin\createdb.exe"
    $env:PGPASSWORD = $PgPassword
    try {
        foreach ($dbName in $Databases) {
            $exists = & $psql --host=127.0.0.1 --port=$PgPort --username=$PgSuperuser `
                              --dbname=postgres --tuples-only --no-align --quiet `
                              --command="select 1 from pg_database where datname = '$dbName'"
            if ($exists -and $exists.Trim() -eq "1") {
                Write-Skip "$dbName already exists"
            } else {
                & $createdb --host=127.0.0.1 --port=$PgPort --username=$PgSuperuser --owner=$PgSuperuser $dbName
                if ($LASTEXITCODE -ne 0) { throw "createdb $dbName failed (exit $LASTEXITCODE)." }
                Write-Ok "created $dbName"
            }
        }
    } finally {
        Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    }
}

# --- 6. Environment file -----------------------------------------------------

Write-Step "Environment file"

$envPath     = Join-Path $RepoRoot ".env"
$envExample  = Join-Path $RepoRoot ".env.example"

if (Test-Path $envPath) {
    # NEVER overwrite: it may hold real credentials the developer added.
    Write-Skip ".env already exists (left untouched)"
} else {
    if (-not (Test-Path $envExample)) { throw ".env.example not found at $envExample" }

    # 32 bytes for AES-256; 48 bytes for the auth secret. Both from a CSPRNG,
    # which is what `openssl rand -base64 N` would give on a Unix machine.
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $keyBytes = New-Object byte[] 32
        $rng.GetBytes($keyBytes)
        $encryptionKey = [Convert]::ToBase64String($keyBytes)

        $secretBytes = New-Object byte[] 48
        $rng.GetBytes($secretBytes)
        $authSecret = [Convert]::ToBase64String($secretBytes)
    } finally {
        $rng.Dispose()
    }

    $content = Get-Content -Path $envExample -Raw
    $content = $content -replace '(?m)^AUTH_SECRET=.*$',    "AUTH_SECRET=$authSecret"
    $content = $content -replace '(?m)^ENCRYPTION_KEY=.*$', "ENCRYPTION_KEY=$encryptionKey"

    Set-Content -Path $envPath -Value $content -Encoding utf8 -NoNewline
    Write-Ok ".env created with freshly generated ENCRYPTION_KEY and AUTH_SECRET"
    Write-Warn2 "these are DEVELOPMENT secrets. Never reuse them in production."
}

# --- Done --------------------------------------------------------------------

Write-Host ""
Write-Host "Setup complete." -ForegroundColor Green
Write-Host ""
Write-Host "Node is not on the system PATH. Prefix every command with:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    `$env:PATH=`"$NodeDir;`$env:APPDATA\npm;`$env:PATH`""
Write-Host "    Set-Location `"$RepoRoot`""
Write-Host ""
Write-Host "Then:"
Write-Host "    pnpm install --frozen-lockfile"
Write-Host "    pnpm db:migrate"
Write-Host "    pnpm dev            # web    -> http://localhost:3000"
Write-Host "    pnpm dev:worker     # worker -> http://localhost:3001/health/live"
Write-Host ""
Write-Host "Database helpers: scripts\start-db.ps1 / scripts\stop-db.ps1"
Write-Host ""
