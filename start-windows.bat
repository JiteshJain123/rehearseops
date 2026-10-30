@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
for /f "tokens=1 delims=.v" %%V in ('node -p "process.versions.node"') do set NODE_MAJOR=%%V
if %NODE_MAJOR% LSS 20 (
  echo Node.js 20 or newer is required. Current version:
  node -v
  pause
  exit /b 1
)
if not exist .env copy .env.example .env >nul
if not exist node_modules\express (
  echo Installing dependencies ^(first run only^)...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
start "RehearseOps Server" /D "%~dp0" cmd /k "npm start"
timeout /t 3 /nobreak >nul
start "" http://localhost:4173
endlocal
