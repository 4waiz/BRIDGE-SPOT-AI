$ErrorActionPreference = "Stop"

function Resolve-Python {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs\\Python\\Python312\\python.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\\Python\\Python311\\python.exe"),
        "C:\\Program Files\\Python312\\python.exe",
        "C:\\Program Files\\Python311\\python.exe"
    )

    foreach ($path in $candidates) {
        if (Test-Path $path) { return $path }
    }

    throw "Python 3.11 or 3.12 not found. Please install Python 3.12 (recommended) from https://www.python.org/downloads/windows/ with “Add Python to PATH” checked."
}

$python = Resolve-Python
$pyVersion = (& $python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
if ($pyVersion -notin @("3.11", "3.12")) {
    throw "Detected Python $pyVersion; please install/use Python 3.12 (recommended) or 3.11."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$venvPath = Join-Path $repoRoot "spot\\venv"
$venvCfg = Join-Path $venvPath "pyvenv.cfg"
if (Test-Path $venvCfg) {
    $cfgLine = Get-Content $venvCfg | Where-Object { $_ -match '^version' } | Select-Object -First 1
    if ($cfgLine -match '([0-9]+\\.[0-9]+)') {
        $venvVersion = [version]$matches[1]
        if ($venvVersion -ne [version]$pyVersion) {
            Write-Host "Recreating Spot virtual environment to match Python $pyVersion..."
            Remove-Item -Recurse -Force $venvPath
        }
    }
}

if (-not (Test-Path $venvPath)) {
    Write-Host "Creating Spot virtual environment..."
    & $python -m venv $venvPath
}

$venvPython = Join-Path $venvPath "Scripts\\python.exe"
if (-not (Test-Path $venvPython)) {
    throw "Virtualenv python missing at $venvPython"
}

# Invoke pip through the venv python: pip.exe itself is blocked by Windows
# Application Control policy on some hosts.
& $venvPython -m pip --version *> $null
if ($LASTEXITCODE -ne 0) {
    & $venvPython -m ensurepip --upgrade
}

# The dependency install is a no-op on every run after the first, but pip still
# prints a "Requirement already satisfied" line per package. Send it to a log and
# only surface anything when it genuinely fails.
$pipLog = Join-Path $venvPath "pip-install.log"
& $venvPython -m pip install --quiet --disable-pip-version-check -r (Join-Path $repoRoot "spot\\deployment\\requirements\\requirements.txt") *> $pipLog
if ($LASTEXITCODE -ne 0) {
    Write-Host "Spot dependency install failed:"
    Get-Content $pipLog -Tail 30
    throw "Dependency install failed. Full output: $pipLog"
}

# TensorFlow, gRPC and absl all announce themselves on import. None of it is
# actionable here, so quieten them and leave the service URL as the only output.
$env:TF_CPP_MIN_LOG_LEVEL = "3"
$env:TF_ENABLE_ONEDNN_OPTS = "0"
$env:GRPC_VERBOSITY = "ERROR"
$env:GLOG_minloglevel = "2"

# A stale server on the port makes uvicorn fail with a bare winerror 10048,
# which reads like a code fault rather than "something is already running".
$busy = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    $pid4000 = $busy[0].OwningProcess
    $owner = (Get-Process -Id $pid4000 -ErrorAction SilentlyContinue).ProcessName
    throw "Port 4000 is already in use by PID $pid4000 ($owner). Stop it first: Stop-Process -Id $pid4000 -Force"
}

$serviceDir = Join-Path $repoRoot "spot\\app"
Push-Location $serviceDir
try {
    Write-Host "Spot API: http://localhost:4000"
    & $venvPython main.py
} finally {
    Pop-Location
}
