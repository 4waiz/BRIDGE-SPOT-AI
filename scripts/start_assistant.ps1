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
$venvPath = Join-Path $repoRoot "smart_assistant\\backend\\venv"
$venvCfg = Join-Path $venvPath "pyvenv.cfg"
if (Test-Path $venvCfg) {
    $cfgLine = Get-Content $venvCfg | Where-Object { $_ -match '^version' } | Select-Object -First 1
    if ($cfgLine -match '([0-9]+\\.[0-9]+)') {
        $venvVersion = [version]$matches[1]
        if ($venvVersion -ne [version]$pyVersion) {
            Write-Host "Recreating assistant virtual environment to match Python $pyVersion..."
            Remove-Item -Recurse -Force $venvPath
        }
    }
}

if (-not (Test-Path $venvPath)) {
    Write-Host "Creating assistant virtual environment..."
    & $python -m venv $venvPath
}

$venvPython = Join-Path $venvPath "Scripts\\python.exe"
if (-not (Test-Path $venvPython)) {
    throw "Virtualenv python missing at $venvPython"
}

$pip = Join-Path $venvPath "Scripts\\pip.exe"
if (-not (Test-Path $pip)) {
    & $venvPython -m ensurepip --upgrade
}

Write-Host "Installing assistant dependencies..."
# Ensure NumPy stays below 2.x for dependency compatibility.
& $pip install --upgrade --no-cache-dir "numpy<2"
# Force a CPU-compatible torch build to avoid missing DLLs on Windows GPU-less hosts.
& $pip install --upgrade --no-cache-dir torch==2.3.1 --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple
& $pip install -r (Join-Path $repoRoot "smart_assistant\\backend\\deployment\\requirements\\requirements_dev.txt")

$serviceDir = Join-Path $repoRoot "smart_assistant\\backend\\app"
Push-Location $serviceDir
try {
    Write-Host "Starting assistant service..."
    Write-Host "Assistant API: http://localhost:4001"
    & $venvPython main_lif.py
} finally {
    Pop-Location
}
