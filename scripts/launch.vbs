' DeskPet launcher -- double-click friendly: no console window, and it rebuilds
' only when sources are newer than dist.
'
' ASCII only on purpose: wscript reads .vbs using the system ANSI codepage, so
' non-ASCII text in this file would be mangled.
'
' Usage:  wscript scripts\launch.vbs [check]
'   check  -> print resolved paths and whether a rebuild is needed, then exit
Option Explicit

Dim fso, sh, root, exePath, distFile, logDir, buildLog, mode, needBuild

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' scripts\launch.vbs -> project root
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
exePath = root & "\node_modules\electron\dist\electron.exe"
distFile = root & "\dist\main\index.js"
logDir = root & "\.runtime"
buildLog = logDir & "\build.log"

mode = ""
If WScript.Arguments.Count > 0 Then mode = LCase(WScript.Arguments(0))

If Not fso.FileExists(exePath) Then
  MsgBox "Electron runtime not found:" & vbCrLf & exePath & vbCrLf & vbCrLf & _
         "Please double-click scripts\setup.cmd once.", 48, "DeskPet"
  WScript.Quit 1
End If

needBuild = False
If Not fso.FileExists(distFile) Then
  needBuild = True
ElseIf NewestSource(root & "\src") > fso.GetFile(distFile).DateLastModified Then
  needBuild = True
End If

' Optional extra flags, one per line, '#' starts a comment. This is the escape hatch for
' machines whose session cannot create Chromium's sandbox (headless / containerised), where
' the pet needs --no-sandbox. Keep it out of the code path used by normal desktops.
Dim flags, flagsFile, ts, line
flags = ""
flagsFile = root & "\.runtime\launch-flags.txt"
If fso.FileExists(flagsFile) Then
  Set ts = fso.OpenTextFile(flagsFile, 1)
  Do While Not ts.AtEndOfStream
    line = Trim(ts.ReadLine)
    If Len(line) > 0 And Left(line, 1) <> "#" Then flags = flags & " " & line
  Loop
  ts.Close
End If

If mode = "check" Then
  WScript.Echo "root       = " & root
  WScript.Echo "electron   = " & exePath
  WScript.Echo "dist       = " & distFile & "  exists=" & fso.FileExists(distFile)
  WScript.Echo "newestSrc  = " & NewestSource(root & "\src")
  WScript.Echo "needBuild  = " & needBuild
  WScript.Echo "extraFlags = [" & Trim(flags) & "]"
  WScript.Echo "flagsFile  = " & flagsFile & "  exists=" & fso.FileExists(flagsFile)
  WScript.Echo "electronProcs = " & CountElectron()
  WScript.Echo "isAlive    = " & IsAlive(DateAdd("s", -5, Now))
  WScript.Quit 0
End If

If needBuild Then
  If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
  sh.CurrentDirectory = root
  Dim rc
  rc = sh.Run("cmd.exe /c """ & root & "\scripts\build.cmd"" > """ & buildLog & """ 2>&1", 0, True)
  If rc <> 0 Then
    MsgBox "Build failed (exit " & rc & ")." & vbCrLf & vbCrLf & "See: " & buildLog, 48, "DeskPet"
    WScript.Quit 2
  End If
End If

' Electron is a GUI binary, so nothing flashes on screen. 0 = hidden, False = do not wait.
sh.CurrentDirectory = root
sh.Run """" & exePath & """ """ & root & """ --data-dir=.runtime/userdata" & flags, 0, False

' Confirm it is actually alive: "double-clicked and nothing happened" is the worst failure mode.
' Some sessions (restricted / containerised terminals) forbid the Chromium sandbox, and then
' electron exits immediately.
Dim waited, alive, startedAt
startedAt = Now
waited = 0
alive = False
Do While waited < 8000
  WScript.Sleep 500
  waited = waited + 500
  If IsAlive(startedAt) Then
    alive = True
    Exit Do
  End If
Loop

If Not alive Then
  If Len(Trim(flags)) = 0 Then
    ' Fall back once, and record the decision so later launches skip the probe.
    If Not fso.FolderExists(logDir) Then fso.CreateFolder(logDir)
    Dim f2
    Set f2 = fso.CreateTextFile(flagsFile, True)
    f2.WriteLine "# Added automatically by launch.vbs: this session blocked the Chromium sandbox."
    f2.WriteLine "# Delete this file once the machine can create the sandbox normally."
    f2.WriteLine "--no-sandbox"
    f2.Close
    sh.Run """" & exePath & """ """ & root & """ --data-dir=.runtime/userdata --no-sandbox", 0, False
    WScript.Sleep 6000
    If IsAlive(startedAt) Then
      MsgBox "DeskPet started with --no-sandbox." & vbCrLf & vbCrLf & _
             "Reason: this session does not allow Chromium to create its sandbox," & vbCrLf & _
             "so the first attempt exited immediately." & vbCrLf & vbCrLf & _
             "Recorded in: " & flagsFile, 64, "DeskPet"
      WScript.Quit 0
    End If
  End If
  MsgBox "DeskPet failed to start." & vbCrLf & vbCrLf & _
         "Log: " & root & "\.runtime\userdata\logs\deskpet.log" & vbCrLf & _
         "Build log: " & buildLog, 48, "DeskPet"
  WScript.Quit 2
End If

WScript.Quit 0

' Is the app actually running? Two independent signals, because WMI can be blind in
' restricted sessions (measured: it reported 0 while four electron.exe were alive).
'   1. WMI process count
'   2. the app log was touched since we launched -- the app always writes a startup line
Function IsAlive(since)
  Dim logFile
  IsAlive = (CountElectron() > 0)
  If IsAlive Then Exit Function
  logFile = root & "\.runtime\userdata\logs\deskpet.log"
  If fso.FileExists(logFile) Then
    If fso.GetFile(logFile).DateLastModified >= DateAdd("s", -3, since) Then IsAlive = True
  End If
End Function

' Count running electron.exe processes (0 = not running / already exited)
Function CountElectron()
  Dim wmi, items
  CountElectron = 0
  On Error Resume Next
  Set wmi = GetObject("winmgmts:\\.\root\cimv2")
  Set items = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name='electron.exe'")
  CountElectron = items.Count
  On Error GoTo 0
End Function

' Newest modification time under a folder (recursive); DateSerial avoids locale issues.
Function NewestSource(folderPath)
  Dim newest, f, sub_
  newest = DateSerial(1980, 1, 1)
  If Not fso.FolderExists(folderPath) Then
    NewestSource = newest
    Exit Function
  End If
  For Each f In fso.GetFolder(folderPath).Files
    If f.DateLastModified > newest Then newest = f.DateLastModified
  Next
  For Each sub_ In fso.GetFolder(folderPath).SubFolders
    Dim t
    t = NewestSource(sub_.Path)
    If t > newest Then newest = t
  Next
  NewestSource = newest
End Function
