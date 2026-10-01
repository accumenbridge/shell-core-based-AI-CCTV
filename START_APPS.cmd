@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
 echo Node.js 22.16 or newer is required. Install Node.js, then run this file again.
 pause
 exit /b 1
)
node -e "const [major,minor]=process.versions.node.split('.').map(Number);if(major<22||(major===22&&minor<16)){console.error('Node.js 22.16 or newer is required.');process.exit(1)}"
if errorlevel 1 (pause & exit /b 1)
node tools/link-workspaces.mjs
if errorlevel 1 (pause & exit /b 1)
echo.
echo Keep this window open. The launcher will print your local login credentials.
echo Use Run real apps in OPEN_PLATFORM.html to open the application pages.
echo.
node tools/demo.mjs
pause
