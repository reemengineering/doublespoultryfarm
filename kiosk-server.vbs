' ===========================================================================
' DOUBLES POULTRY FARM - starts the weighing server with no visible window.
' Task Scheduler runs this file when the kiosk account signs in.
' Window style 0 = hidden; the console (and python) stay out of sight.
' ===========================================================================
Option Explicit
Dim fso, shell, here, bat
Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
bat  = here & "\kiosk-server.bat"

If Not fso.FileExists(bat) Then
  MsgBox "Missing file:" & vbCrLf & bat, vbCritical, "DOUBLES POULTRY FARM"
  WScript.Quit 1
End If

shell.CurrentDirectory = here
shell.Run """" & bat & """", 0, False
