@echo off
setlocal
rem DriverLens - starts the local read-only server and opens the UI.
rem Always use the server URL (http://127.0.0.1:8781); opening index.html directly cannot scan.
cd /d "%~dp0."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run DriverLens. Get it at https://nodejs.org and try again.
  pause
  exit /b 1
)

powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8781/' | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Starting DriverLens server...
  start "DriverLens server" /min /d "%~dp0." cmd /c "node server.cjs"
  timeout /t 2 /nobreak >nul
) else (
  echo DriverLens server is already running.
)

start "" "http://127.0.0.1:8781"
endlocal
