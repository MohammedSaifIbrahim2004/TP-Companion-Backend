@echo off
setlocal

set "APPDIR=%~dp0"
set "WINSW=%APPDIR%winsw\TPBackendService.exe"

cd /d "%APPDIR%winsw"

echo Stopping service...
"%WINSW%" stop >nul 2>&1

echo Uninstalling service...
"%WINSW%" uninstall

echo Removing firewall rule...
netsh advfirewall firewall delete rule name="TPBackendService" >nul 2>&1

echo Service removed successfully.
pause
endlocal
