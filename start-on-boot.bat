@echo off
REM Auto-start DOUBLES POULTRY FARM server at Windows startup.
REM Place a shortcut to this file in shell:startup if desired.
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 is required on PATH.
  exit /b 1
)

REM Install packages on first run if missing.
python -c "import flask, serial" >nul 2>nul
if errorlevel 1 (
  python -m pip install --disable-pip-version-check -q -r requirements.txt
  if errorlevel 1 (
    python -m pip install --disable-pip-version-check -q --user -r requirements.txt
  )
)

REM Start server (leave window open to see logs)
python app.py

