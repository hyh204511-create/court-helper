@echo off
REM ============================================================
REM court-helper one-click start: server(3000) + OCR helper(8765)
REM Double-click to run. Already-running services are skipped.
REM Logs: %TEMP%\court-helper\server.log / ocr.log
REM ============================================================
setlocal
cd /d "%~dp0..\server"
if not exist "dist\main.js" (
  echo [ERROR] dist\main.js not found - run "npm run server:build" first.
  pause
  exit /b 1
)

set LOGDIR=%TEMP%\court-helper
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

echo [1/3] Checking port 3000 (server) ...
netstat -ano | findstr /r /c:":3000 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo       Server already running on 3000 - skip.
) else (
  echo       Starting server ...
  start "court-helper-server" /min cmd /c "cd /d ""%~dp0..\server"" && set DATABASE_URL=&& node --env-file=.env dist\main.js >> "%LOGDIR%\server.log" 2>&1"
)

echo [2/3] Checking port 8765 (OCR helper) ...
netstat -ano | findstr /r /c:":8765 .*LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo       OCR helper already running on 8765 - skip.
) else (
  echo       Starting OCR helper ...
  start "court-helper-ocr" /min cmd /c "cd /d ""%~dp0.."" && python scripts\login-helper-server.py >> "%LOGDIR%\ocr.log" 2>&1"
)

echo [3/3] Waiting for services ...
timeout /t 4 /nobreak >nul 2>&1

set OK=1
curl -s --max-time 3 http://127.0.0.1:3000/health >nul 2>&1 || set OK=0
if %OK%==0 (
  echo [WARN] Server health check failed - see %LOGDIR%\server.log
) else (
  echo       Server 3000 OK
)
curl -s --max-time 3 http://127.0.0.1:8765/health >nul 2>&1
if %errorlevel%==0 (
  echo       OCR 8765 OK
) else (
  echo [WARN] OCR health check failed - see %LOGDIR%\ocr.log
)
echo.
echo Done. Open http://127.0.0.1:3000/admin/browser-control for business operations.
timeout /t 5 /nobreak >nul 2>&1
exit /b 0
