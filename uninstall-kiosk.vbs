' ===========================================================================
'  DOUBLES POULTRY FARM - remove the kiosk restrictions.
'  Double-click this while signed in as the Kiosk user.
'  (A .vbs is used because cmd/regedit are blocked by the restrictions,
'   but wscript and reg.exe are not.)
' ===========================================================================
Option Explicit
Dim sh, fso, startupLnk

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

startupLnk = sh.ExpandEnvironmentStrings("%APPDATA%") _
  & "\Microsoft\Windows\Start Menu\Programs\Startup\DOUBLES POULTRY FARM.lnk"

If fso.FileExists(startupLnk) Then fso.DeleteFile startupLnk

sh.Run "reg delete ""HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\Explorer"" /f", 0, True
sh.Run "reg delete ""HKCU\Software\Microsoft\Windows\CurrentVersion\Policies\System"" /f", 0, True

MsgBox "Kiosk restrictions removed and the Startup entry deleted." & vbCrLf & vbCrLf _
  & "Sign out and sign in again for everything to return to normal.", _
  vbInformation, "DOUBLES POULTRY FARM"
