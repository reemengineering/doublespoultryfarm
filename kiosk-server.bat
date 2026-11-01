@echo off
REM ===========================================================================
REM  DOUBLES POULTRY FARM - kiosk server launcher.
REM  Started by Task Scheduler when the kiosk account signs in (see
REM  setup-kiosk.bat). Runs with no visible window and restarts the
REM  server automatically if it ever stops.
REM ===========================================================================
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 is required but was not found on PATH. 1>&2
  exit /b 1
)

REM First run only - install packages when they are missing.
python -c "import flask, serial" >nul 2>nul
if errorlevel 1 (
  echo Installing required packages... 1>&2
  python -m pip install --disable-pip-version-check -q -r requirements.txt
  if errorlevel 1 (
    python -m pip install --disable-pip-version-check -q --user -r requirements.txt
    if errorlevel 1 (
      echo Package installation failed. 1>&2
      exit /b 1
    )
  )
)

:loop
python app.py
echo [%date% %time%] Server stopped - restarting in 5 seconds... 1>&2
REM ping-delay instead of "timeout": works in hidden/non-interactive windows
REM where timeout refuses to run, and prevents a hot restart loop.
ping -n 6 127.0.0.1 >nul
goto loop
