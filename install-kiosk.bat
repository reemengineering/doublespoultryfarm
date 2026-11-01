@echo off
REM ===========================================================================
REM  DOUBLES POULTRY FARM - Kiosk account setup
REM
REM  Run this WHILE SIGNED IN AS THE KIOSK USER (double-click is fine;
REM  no administrator rights needed - it only touches this account).
REM
REM  What it does:
REM    1) Adds kiosk-start.vbs to this account's Startup folder
REM       (starts the server hidden + Edge full-screen kiosk + watchdog)
REM    2) Applies the same restrictions Assigned Access gives:
REM       - Windows key / Win+R disabled
REM       - Task Manager, cmd, PowerShell, regedit, Control Panel blocked
REM       - right-click menus disabled
REM ===========================================================================
setlocal
cd /d "%~dp0"

echo.
echo  DOUBLES POULTRY FARM - Kiosk account setup
echo  (signed in as: %USERNAME%)
echo.

if not exist "%~dp0kiosk-start.vbs" (
  echo  [FAIL] kiosk-start.vbs not found in %~dp0
  echo  Keep this script inside the project folder.
  echo.
  pause
  exit /b 1
)

REM --- 1) Startup entry -------------------------------------------------------
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%STARTUP%\DOUBLES POULTRY FARM.lnk'); $s.TargetPath='%~dp0kiosk-start.vbs'; $s.WorkingDirectory='%~dp0'; $s.Save()"
if exist "%STARTUP%\DOUBLES POULTRY FARM.lnk" (
  echo  [OK] Startup entry created
) else (
  echo  [FAIL] could not create the Startup entry
  echo.
  pause
  exit /b 1
)

REM --- 2) Per-account restrictions (HKCU - works without admin) ---------------
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" /v NoWinKeys /t REG_DWORD /d 1 /f >nul && echo  [OK] Windows key shortcuts disabled
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" /v NoRun /t REG_DWORD /d 1 /f >nul && echo  [OK] Win+R (Run) disabled
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" /v NoViewContextMenu /t REG_DWORD /d 1 /f >nul && echo  [OK] right-click menus disabled
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableTaskMgr /t REG_DWORD /d 1 /f >nul && echo  [OK] Task Manager blocked
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableCMD /t REG_DWORD /d 1 /f >nul && echo  [OK] Command Prompt blocked
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System" /v DisableRegistryTools /t REG_DWORD /d 1 /f >nul && echo  [OK] Registry editor blocked
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer" /v DisallowRun /t REG_DWORD /d 1 /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\DisallowRun" /v 1 /t REG_SZ /d cmd.exe /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\DisallowRun" /v 2 /t REG_SZ /d powershell.exe /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\DisallowRun" /v 3 /t REG_SZ /d regedit.exe /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\DisallowRun" /v 4 /t REG_SZ /d taskmgr.exe /f >nul
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer\DisallowRun" /v 5 /t REG_SZ /d control.exe /f >nul
echo  [OK] blocked-apps list applied

echo.
echo  DONE. Now test it:
echo    1. Sign out ^(Ctrl+Alt+Del -^> Sign out^) and sign in again.
echo    2. Server starts hidden, Edge opens full-screen on the terminal.
echo    3. To exit: Ctrl+Alt+Del -^> Sign out.
echo.
echo  Optional auto-sign-in: Win+R -^> netplwiz ^(needs admin account^)
echo.
pause
