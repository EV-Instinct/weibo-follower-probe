Set ws = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
curDir = fso.GetParentFolderName(WScript.ScriptFullName)
ws.Run Chr(34) & curDir & "\启动新版微博粉丝助手.exe" & Chr(34), 0, False
