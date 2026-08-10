@echo off
rem ============================================================
rem  start-chrome-debug.bat - start Chrome with CDP debug port
rem  Hermes browser tools attach via http://127.0.0.1:9222
rem  Usage: double-click this script; safe to run repeatedly.
rem ============================================================
setlocal EnableDelayedExpansion

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
set "PORT=9222"
set "DEFAULT_UDD=C:\Users\28368\AppData\Local\Google\Chrome\User Data"
set "DEBUG_UDD=C:\Users\28368\AppData\Local\Google\Chrome\DebugProfile"

if not exist "%CHROME%" (
  echo [ERROR] Chrome not found: %CHROME%
  echo Edit CHROME path at top of this script, or use Edge instead.
  pause
  exit /b 1
)

rem ---- 1. Port already listening? ----
netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
if %errorlevel%==0 (
  echo [READY] Debug Chrome already running on port %PORT%. Hermes can attach now.
  start "" "%CHROME%" --no-first-run
  goto :eof
)

rem ---- 2. Normal Chrome running? (single-instance lock would kill the debug port) ----
tasklist /FI "IMAGENAME eq chrome.exe" 2>nul | findstr /I "chrome.exe" >nul
if %errorlevel%==0 (
  echo [INFO] Normal-mode Chrome is running.
  echo   A: close normal Chrome, rerun this script - reuses your login state (recommended)
  echo   B: start with a separate debug profile - no interference, but re-login needed
  choice /C AB /N /T 5 /D B /M "Choose A/B (default B in 5s): "
  if errorlevel 2 goto :debug_profile
  goto :default_profile
)

:default_profile
echo [START] Using default user data dir with debug port %PORT% ...
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%DEFAULT_UDD%" --no-first-run
goto :verify

:debug_profile
echo [START] Using separate debug profile (DebugProfile) with debug port %PORT% ...
if not exist "%DEBUG_UDD%" mkdir "%DEBUG_UDD%"
start "" "%CHROME%" --remote-debugging-port=%PORT% --user-data-dir="%DEBUG_UDD%" --no-first-run
goto :verify

:verify
echo Waiting for port %PORT% ...
for /L %%i in (1,1,15) do (
  netstat -ano | findstr ":%PORT% " | findstr LISTENING >nul
  if !errorlevel!==0 (
    echo [DONE] Debug Chrome is up. Hermes can attach via http://127.0.0.1:%PORT%
    goto :eof
  )
  timeout /t 1 /nobreak >nul
)
echo [WARN] Port %PORT% not detected within 15s. Check Chrome startup.
pause
endlocal
