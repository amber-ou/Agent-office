@echo off
setlocal
rem  Agent Office — the Windows entry point.
rem
rem  Starts the office from THIS checkout's build. Agent Office only observes
rem  Claude Code: it never starts, stops or controls an agent, so closing this
rem  window has no effect on any agent that is running.

cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not on PATH. Install Node 20 or newer, then run this again.
  pause
  exit /b 1
)

if not exist "dist\cli.js" (
  echo This checkout is not built yet. Run these two commands once, then start again:
  echo     npm ci
  echo     npm run build
  pause
  exit /b 1
)

echo Starting Agent Office. Open the address below in your browser.
echo Close this window to stop the office. Running agents are not affected.
echo.
node dist\cli.js %*
rem  Keep the window open on a failed start so the message stays readable.
if errorlevel 1 pause
