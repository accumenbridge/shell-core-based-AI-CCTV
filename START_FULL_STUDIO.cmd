@echo off
setlocal
pushd "%~dp0"
if errorlevel 1 exit /b 90

call npm run build
set "BUILD_STATUS=%ERRORLEVEL%"
if not "%BUILD_STATUS%"=="0" goto build_failed

call node apps/control-plane/dist/main.js
set "START_STATUS=%ERRORLEVEL%"
popd
exit /b %START_STATUS%

:build_failed
popd
exit /b %BUILD_STATUS%
