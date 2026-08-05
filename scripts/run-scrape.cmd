@echo off
REM Wrapper used by Windows Task Scheduler. Appends to data\scrape.log.
setlocal
cd /d "%~dp0.."

if not exist "data" mkdir "data"

echo. >> "data\scrape.log"
echo ===== %DATE% %TIME% ===== >> "data\scrape.log"
node --experimental-sqlite --no-warnings "src\scrape.js" >> "data\scrape.log" 2>&1
set CODE=%ERRORLEVEL%
echo (exit code %CODE%) >> "data\scrape.log"
exit /b %CODE%
