' ===========================================================================
'  DOUBLES POULTRY FARM - kiosk startup entry.
'  Lives in this project folder; a shortcut to it is placed in the Kiosk
'  account's Startup folder by install-kiosk.bat.
'
'  1) Starts the weighing server with no visible window (kiosk-server.vbs)
'  2) Starts the keyboard filter (kiosk-keys.py: blocks Alt+Tab, Windows
'     key and other shortcuts - Ctrl+Alt+A and Ctrl+Alt+Del still work)
'  3) Opens Microsoft Edge in full-screen kiosk mode on the terminal
'  4) Watchdog: reopens Edge and the keyboard filter if either stops
' ===========================================================================
Option Explicit

Dim sh, fso, here, serverVbs, keysPy, edge, wmi

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

' ---- 1) start the server (hidden) ------------------------------------------
serverVbs = here & "\kiosk-server.vbs"
If fso.FileExists(serverVbs) Then
  sh.Run """" & serverVbs & """", 0, False
  WScript.Sleep 3000
Else
  MsgBox "Missing file:" & vbCrLf & serverVbs, vbCritical, "DOUBLES POULTRY FARM"
  WScript.Quit 1
End If

' ---- 1b) start the keyboard filter (hides Alt+Tab, Windows key, etc.) ------
keysPy = here & "\kiosk-keys.py"
If fso.FileExists(keysPy) Then
  sh.Run "python """ & keysPy & """", 0, False
End If

' ---- 2) find Edge ----------------------------------------------------------
If fso.FileExists("C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe") Then
  edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
ElseIf fso.FileExists("C:\Program Files\Microsoft\Edge\Application\msedge.exe") Then
  edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
Else
  MsgBox "Microsoft Edge was not found on this PC.", vbCritical, "DOUBLES POULTRY FARM"
  WScript.Quit 1
End If

StartEdge

' ---- 3) watchdog: reopen Edge if it gets closed ----------------------------
Do
  WScript.Sleep 15000
  If Not EdgeRunning() Then StartEdge
Loop

Function EdgeRunning()
  Dim list
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set list = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name = 'msedge.exe'")
  If Err.Number <> 0 Then
    Err.Clear
    EdgeRunning = True   ' cannot query - assume running, do not loop-spam
  Else
    EdgeRunning = (list.Count > 0)
  End If
End Function

Sub StartEdge()
  sh.Run """" & edge & """ --kiosk http://localhost:3001/staff/" _
    & " --edge-kiosk-type=fullscreen --disable-background-mode" _
    & " --no-first-run --disable-session-crashed-bubble --hide-crash-restore-bubble", 1, False
End Sub
