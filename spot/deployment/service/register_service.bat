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

:: Define the PowerShell script path and flag parameter
:: Change the file paths accordingly
:: IMPORTANT: Leave no trailing \
set WORK_DIR="C:\Bridge Spot AI\spot\app"
set LOG_PATH="C:\Bridge Spot AI\spot\log"
set COMMAND="C:\Bridge Spot AI\spot\venv\Scripts\python.exe main.py"
set SERVICE_NAME="Spot"
set DISPLAY_NAME="Spot"
set DESCRIPTION="This service launches software from Bridge Spot AI."

set PS_SCRIPT="C:\Bridge Spot AI\spot\deployment\service\service.ps1"
set LAUNCHER="C:\Bridge Spot AI\spot\deployment\service\Spot_service.exe"

:: Construct the command to run the PowerShell script
set CMD="& %PS_SCRIPT% -Script register -WorkDir '%WORK_DIR%' -LogPath '%LOG_PATH%' -Launcher '%LAUNCHER%' -Command '%COMMAND%' -ServiceName '%SERVICE_NAME%' -DisplayName '%DISPLAY_NAME%' -Description '%DESCRIPTION%'"

:: Execute the PowerShell command
powershell -ExecutionPolicy Bypass -Command %CMD%

:: Pause to see the output
pause

REM Changes made by Awaiz Ahmed
