' Silent launcher for the Investment Dashboard Electron app.
' Double-click this to start the dashboard with no console window.
Set objShell = CreateObject("WScript.Shell")
Set objFSO = CreateObject("Scripting.FileSystemObject")
strProjectDir = objFSO.GetParentFolderName(WScript.ScriptFullName)
objShell.CurrentDirectory = strProjectDir
' 0 = hidden window, False = don't wait
objShell.Run "cmd /c npm start", 0, False
