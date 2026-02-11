@echo off
setlocal

set "APPDIR=%~dp0"
set "WINSW=%APPDIR%winsw\TPBackendService.exe"
set "LOG=%APPDIR%service-install.log"

echo ================================== >> "%LOG%" 2>&1
echo install-service.bat started at %DATE% %TIME% >> "%LOG%" 2>&1
echo ================================== >> "%LOG%" 2>&1

REM Move to WinSW directory
cd /d "%APPDIR%winsw"

echo Stopping existing service (if any)...
"%WINSW%" stop >nul 2>&1

echo Uninstalling existing service (if any)...
"%WINSW%" uninstall >nul 2>&1

echo Installing WinSW service...
"%WINSW%" install
if errorlevel 1 (
    echo Service installation failed.
    pause
    exit /b 1
)

echo Starting service...
"%WINSW%" start
if errorlevel 1 (
    echo Service start failed.
    pause
    exit /b 1
)

echo Service installed and started successfully.
pause
endlocal
