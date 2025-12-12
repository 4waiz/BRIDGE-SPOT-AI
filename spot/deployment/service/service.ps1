# parse cli parameters
param (
  [string]$Script,
  [string]$ServiceName,
  [string]$LogPath,
  [string]$WorkDir,
  [string]$Command,
  [string]$DisplayName,
  [string]$Description,
  [string]$Launcher
)

# set variables
$serviceExists = Get-Service -Name ${ServiceName} -ErrorAction SilentlyContinue

# define functions
function Register-Service() {
    # Define executable path
    $executablePath = "${Launcher} --command " + '"' + "${Command}" + '"' + " --logPath ${LogPath} " +
    "--serviceName ${ServiceName} --workDir ${WorkDir}"

    # Check if the service exists
    if (${serviceExists}) {
        Write-Host "Service ${ServiceName} already exists."
        exit 1
    }

    # Define service parameters
    $serviceParams = @{
        Name = ${ServiceName}
        DisplayName = ${DisplayName}
        Description = ${Description}
        BinaryPathName = ${executablePath}
        StartupType = "Automatic"
    }

    # Install new service
    New-Service @serviceParams > $null
    if ($?) {
        Write-Host "Service ${ServiceName} installed successfully."
    } else {
        Write-Host "Failed to install service ${ServiceName}." -ForegroundColor Red
    }
}

function Unregister-Service() {
    # Check if the service exists
    if (-not ${serviceExists}) {
        Write-Host "Service ${ServiceName} does not exist."
        exit 1
    }

    # Stop the service if it's running
    if (${serviceExists}.Status -eq 'Running') {
        try {
            Stop-Service -Name ${ServiceName} -Force -ErrorAction Stop
            Write-Host "Service ${ServiceName} stopped successfully."
        } catch {
            Write-Host "Failed to stop service ${ServiceName}." -ForegroundColor Red
        }
    }

    # Remove the service
    try {
        sc.exe delete ${ServiceName} > $null
        Write-Host "Service ${ServiceName} uninstalled successfully."
    } catch {
        Write-Host "Failed to uninstall service ${ServiceName}." -ForegroundColor Red
    }
}

function Start-ServiceByName() {
    # Check if the service exists
    if (-not ${serviceExists}) {
        Write-Host "Service ${ServiceName} does not exist."
        exit 1
    }

    # Check if the service is already running
    if (${serviceExists}.Status -eq 'Running') {
        Write-Host "Service ${ServiceName} is already running."
        exit 0
    }

    # Start the service
    try {
        Start-Service -Name ${ServiceName} -ErrorAction Stop
        Write-Host "Service ${ServiceName} started successfully."
    } catch {
        Write-Host "Failed to start service ${ServiceName}." -ForegroundColor Red
    }
}

function Stop-ServiceByName() {
    # Check if the service exists
    if (-not ${serviceExists}) {
        Write-Host "Service ${ServiceName} does not exist."
        exit 1
    }

    # Check if the service is already stopped
    if (${serviceExists}.Status -ne 'Running') {
        Write-Host "Service ${ServiceName} is not running."
        exit 0
    }

    # Stop the service
    try {
        Stop-Service -Name ${ServiceName} -Force -ErrorAction Stop
        Write-Host "Service ${ServiceName} stopped successfully."
    } catch {
        Write-Host "Failed to stop service ${ServiceName}." -ForegroundColor Red
    }
}



# call functions
switch -exact ($script.ToLower()) {
    "register" {
        if (${ServiceName} -eq "") {
            Write-Host "Error: `"-ServiceName`" is missing." -ForegroundColor Red
            exit 1
        }
        if (${LogPath} -eq "") {
            Write-Host "Error: `"-LogPath`" is missing." -ForegroundColor Red
            exit 1
        }
        if (${WorkDir} -eq "") {
            Write-Host "Error: `"-WorkDir`" is missing." -ForegroundColor Red
            exit 1
        }
        if (${Command} -eq "") {
            Write-Host "Error: `"-Command`" is missing." -ForegroundColor Red
            exit 1
        }
        if (${DisplayName} -eq "") {
            Write-Host "Error: `"-DisplayName`" is missing." -ForegroundColor Red
            exit 1
        }
        if (${Description} -eq "") {
            Write-Host "Error: `"-Description`" is missing." -ForegroundColor Red
            exit 1
        }
        if (${Launcher} -eq "") {
            Write-Host "Error: `"-Launcher`" is missing." -ForegroundColor Red
            exit 1
        }

        Register-Service
    }
    "unregister" {
        if (${ServiceName} -eq "") {
            Write-Host "Error: `"-ServiceName`" is missing." -ForegroundColor Red
            exit 1
        }

        Unregister-Service
    }
    "start" {
        if (${ServiceName} -eq "") {
            Write-Host "Error: `"-ServiceName`" is missing." -ForegroundColor Red
            exit 1
        }

        Start-ServiceByName -Name ${ServiceName}
    }
    "restart" {
        if (${ServiceName} -eq "") {
            Write-Host "Error: `"-ServiceName`" is missing." -ForegroundColor Red
            exit 1
        }

        Restart-Service -Name ${ServiceName} -Force
    }
    "stop" {
        if (${ServiceName} -eq "") {
            Write-Host "Error: `"-ServiceName`" is missing." -ForegroundColor Red
            exit 1
        }

        Stop-ServiceByName -Name ${ServiceName} -Force
    }
    default {
        Write-Host "Error: `"-Script`" needs to be register, unregister, start, restart or stop." -ForegroundColor Red
    }
  }

