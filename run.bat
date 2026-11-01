@echo off
REM Start the DOUBLES POULTRY FARM weighing terminal (Windows).
REM Uses system Python - no virtual environment is created.
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python 3 is required but was not found on PATH.
  echo Install it from https://www.python.org/downloads/ and tick
  echo "Add python.exe to PATH" during setup.
  exit /b 1
)

REM Check and install required packages if needed (do this once on first run).
python -c "import flask, serial" >nul 2>nul
if errorlevel 1 (
  echo First run - installing required packages...
  python -m pip install --disable-pip-version-check -q -r requirements.txt
  if errorlevel 1 (
    echo Retrying for the current user only...
    python -m pip install --disable-pip-version-check -q --user -r requirements.txt || exit /b 1
  )
  echo Packages installed.
) else (
  REM Packages already present. To force a reinstall on every startup,
  REM uncomment the next two lines:
  REM echo Ensuring packages are present...
  REM python -m pip install --disable-pip-version-check -q -r requirements.txt
)

echo.
echo Starting server on http://localhost:3001
python app.py