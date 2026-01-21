@echo off
:: Check if the script is running with administrative privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrative privileges...
    :: Relaunch the script with admin rights
    powershell -Command "Start-Process '%~0' -Verb runAs"
    exit /B
)

:: If we're here, the script is running as admin, so execute the PowerShell script with arguments
echo Running PowerShell script with admin privileges...

:: Resolve repo root from this script location
for %%I in ("%~dp0..\..\..\..") do set REPO_ROOT=%%~fI

:: Define the PowerShell script path and flag parameter
set PS_SCRIPT="%REPO_ROOT%\spot\deployment\service\service.ps1"
set SERVICE_NAME="Spot Voice"

:: Construct the command to run the PowerShell script
set CMD="& %PS_SCRIPT% -Script unregister -ServiceName '%SERVICE_NAME%'"

:: Execute the PowerShell command
powershell -ExecutionPolicy Bypass -Command %CMD%

:: Pause to see the output
pause
