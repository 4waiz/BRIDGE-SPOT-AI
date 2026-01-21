@echo off
:: Check if the script is running with administrative privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrative privileges...
    :: Relaunch the script with admin rights
    powershell -Command "Start-Process '%~0' -Verb runAs"
    exit /B
)

:: Change to working directory, needed after restart
cd /d %~dp0

:: If we're here, the script is running as admin, so execute the PowerShell script with arguments
echo Running PowerShell script with admin privileges...

:: Unblock all Files....
powershell -command "dir -Path .\ -Recurse | Unblock-File"

:: Resolve repo root from this script location
for %%I in ("%~dp0..\..\..\..") do set REPO_ROOT=%%~fI

:: Define the PowerShell script path and flag parameter
:: IMPORTANT: Leave no trailing \
set WORK_DIR="%REPO_ROOT%\spot\backend"
set LOG_PATH="%REPO_ROOT%\spot\backend\log"
set COMMAND="%REPO_ROOT%\spot\backend\venv\Scripts\python.exe voice_server.py"
set SERVICE_NAME="Spot Voice"
set DISPLAY_NAME="Spot Voice"
set DESCRIPTION="Spot AI voice backend service."

if not exist %LOG_PATH% (
    mkdir %LOG_PATH%
)

set PS_SCRIPT="%REPO_ROOT%\spot\deployment\service\service.ps1"
set LAUNCHER="%REPO_ROOT%\spot\deployment\service\Spot_service.exe"

:: Construct the command to run the PowerShell script
set CMD="& %PS_SCRIPT% -Script register -WorkDir '%WORK_DIR%' -LogPath '%LOG_PATH%' -Launcher '%LAUNCHER%' -Command '%COMMAND%' -ServiceName '%SERVICE_NAME%' -DisplayName '%DISPLAY_NAME%' -Description '%DESCRIPTION%'"

:: Execute the PowerShell command
powershell -ExecutionPolicy Bypass -Command %CMD%

:: Pause to see the output
pause
