@echo off
setlocal
title Isle of Echoes
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo   Isle of Echoes  -  local sound isle
echo.

if not exist "server.js" (
  echo   server.js was not found next to start.bat.
  echo   Please keep the whole project folder together.
  echo.
  pause
  exit /b 1
)

rem If the site is already up, just open it instead of starting a second copy.
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 'http://127.0.0.1:3000/api/health'; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1"
if not errorlevel 1 (
  echo   Isle of Echoes is already running.
  echo   Opening http://127.0.0.1:3000
  start "" "http://127.0.0.1:3000"
  exit /b 0
)

if not exist "node_modules\express" (
  echo   Dependencies are missing.
  echo   Open a terminal here and run: npm install
  echo.
  pause
  exit /b 1
)

set "NODE_EXE="
node -v >nul 2>nul
if not errorlevel 1 set "NODE_EXE=node"
if defined NODE_EXE goto :run

set "DSH_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if exist "%DSH_NODE%" set "NODE_EXE=%DSH_NODE%"
if defined NODE_EXE goto :run

echo   Node.js was not found.
echo   Install Node.js LTS from https://nodejs.org/
echo   Then double-click start.bat again.
echo.
pause
exit /b 1

:run
echo   Starting with:
echo   %NODE_EXE%
echo.
echo   Open: http://127.0.0.1:3000
echo   Keep this window open. Press Ctrl+C to stop.
echo.

"%NODE_EXE%" server.js
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo   The server stopped unexpectedly. Exit code: %EXIT_CODE%
  echo   Read the messages above, then press any key to close.
  echo.
  pause
)

endlocal & exit /b %EXIT_CODE%