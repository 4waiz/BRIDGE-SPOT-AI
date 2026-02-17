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

    throw "Python 3.11 or 3.12 not found. Please install Python 3.12 (recommended) from https://www.python.org/downloads/windows/ with 'Add Python to PATH' checked."
}

$python = Resolve-Python
$pyVersion = (& $python -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')").Trim()
if ($pyVersion -notin @("3.11", "3.12")) {
    throw "Detected Python $pyVersion; please install/use Python 3.12 (recommended) or 3.11."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$venvPath = Join-Path $repoRoot "spot_legacy\\venv"
$venvCfg = Join-Path $venvPath "pyvenv.cfg"
if (Test-Path $venvCfg) {
    $cfgLine = Get-Content $venvCfg | Where-Object { $_ -match '^version' } | Select-Object -First 1
    if ($cfgLine -match '([0-9]+\\.[0-9]+)') {
        $venvVersion = [version]$matches[1]
        if ($venvVersion -ne [version]$pyVersion) {
            Write-Host "Recreating Guided Tour virtual environment to match Python $pyVersion..."
            Remove-Item -Recurse -Force $venvPath
        }
    }
}

if (-not (Test-Path $venvPath)) {
    Write-Host "Creating Guided Tour virtual environment..."
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

Write-Host "Ensuring Guided Tour packaging tools..."
# bosdyn-client still imports pkg_resources, which requires setuptools < 81.
& $venvPython -m pip install --upgrade pip "setuptools<81"

Write-Host "Installing Guided Tour dependencies..."
& $pip install -r (Join-Path $repoRoot "spot_legacy\\deployment\\requirements.txt")

$serviceDir = Join-Path $repoRoot "spot_legacy\\app"
Push-Location $serviceDir
try {
    Write-Host "Starting Guided Tour app..."
    Write-Host "Guided Tour: http://localhost:8004"
    & $venvPython main.py guided_tour
} finally {
    Pop-Location
}
