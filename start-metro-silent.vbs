Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Projects\KaysPay"
WshShell.Run "cmd /c C:\Projects\KaysPay\start-metro.bat", 0, False
