@echo off
setlocal
rem DriverLens - starts the local read-only server and opens the UI.
rem Always use the server URL (http://127.0.0.1:8781); opening index.html directly cannot scan.
rem Readiness identity is the helper's own /ping pixel (image/gif, 42 bytes) - a
rem service that merely answers HTTP on 8781 is not adopted, and on timeout the
rem browser is NOT opened.
cd /d "%~dp0."

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run DriverLens. Get it at https://nodejs.org and try again.
  pause
  exit /b 1
)

where pwsh >nul 2>nul
if errorlevel 1 (
  echo Note: PowerShell 7 was not found on PATH. Live scans need it; install it from https://aka.ms/powershell or set DRIVERLENS_POWERSHELL to its executable.
)

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:8781/ping'; if ($r.StatusCode -eq 200 -and $r.Headers['Content-Type'] -eq 'image/gif' -and $r.RawContentLength -eq 42) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 goto running

echo Starting DriverLens server...
start "DriverLens server" /min /d "%~dp0." cmd /c "node server.cjs"

rem Wait for readiness by polling the real /ping pixel (bounded), not a fixed blind sleep.
set /a tries=0
:waitready
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:8781/ping'; if ($r.StatusCode -eq 200 -and $r.Headers['Content-Type'] -eq 'image/gif' -and $r.RawContentLength -eq 42) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 goto openui
set /a tries+=1
if %tries% geq 15 goto notready
timeout /t 1 /nobreak >nul
goto waitready

:running
echo DriverLens server is already running.

:openui
start "" "http://127.0.0.1:8781"
endlocal
exit /b 0

:notready
echo DriverLens server did not become ready at http://127.0.0.1:8781 after 15 checks.
echo Not opening the browser: the address is not serving DriverLens, or another program is using port 8781.
echo Check that Node.js runs, then try again. If another program uses port 8781, stop it first.
pause
exit /b 1
