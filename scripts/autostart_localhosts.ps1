$ErrorActionPreference = "Stop"

$repoRoot = Split-Path $PSScriptRoot -Parent
$logDir = Join-Path $env:LOCALAPPDATA "BridgeSpotAI\logs"
if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}
$logFile = Join-Path $logDir "autostart.log"

function Write-Log {
    param([string]$Message)
    $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path $logFile -Value "$stamp $Message"
}

function Test-PortOpen {
    param([int]$Port)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        $connected = $async.AsyncWaitHandle.WaitOne(750)
        if (-not $connected) {
            $client.Close()
            return $false
        }
        $client.EndConnect($async)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

$services = @(
    @{ Name = "Spot API"; Port = 4000; Script = Join-Path $repoRoot "scripts\start_spot.ps1" },
    @{ Name = "Assistant API"; Port = 4001; Script = Join-Path $repoRoot "scripts\start_assistant.ps1" },
    @{ Name = "Frontend"; Port = 3001; Script = Join-Path $repoRoot "scripts\start_frontend.ps1" },
    @{ Name = "Guided Tour"; Port = 8004; Script = Join-Path $repoRoot "scripts\start_guided_tour.ps1" },
    @{ Name = "Spot Voice"; Port = 5000; Script = Join-Path $repoRoot "scripts\start_voice.ps1" }
)

foreach ($svc in $services) {
    $name = $svc.Name
    $port = [int]$svc.Port
    $script = $svc.Script

    if (Test-PortOpen -Port $port) {
        Write-Log "$name already responding on port $port; skipping start."
        continue
    }

    if (-not (Test-Path $script)) {
        Write-Log "Missing script for $name at $script; skipping."
        continue
    }

    Write-Log "Starting $name via $script (port $port not responding)..."
    Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $script -WorkingDirectory $repoRoot -WindowStyle Hidden | Out-Null
}

$ports = $services | ForEach-Object { [int]$_.Port }
$deadline = (Get-Date).AddMinutes(2)
while ($true) {
    $up = $ports | Where-Object { Test-PortOpen -Port $_ }
    if ($up.Count -eq $ports.Count) {
        Write-Log "All services responding: $($up -join ', ')."
        break
    }

    if ((Get-Date) -gt $deadline) {
        Write-Log "Timeout waiting for services. Up ports: $($up -join ', ')."
        break
    }

    Start-Sleep -Seconds 5
}

# Enable this block if you want Edge to launch automatically after services are up.
# $openEdge = $false
# if ($openEdge) {
#     Start-Process "msedge.exe" "http://localhost:4000 http://localhost:3001"
#     Write-Log "Launched Edge with local sites."
# }
