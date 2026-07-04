@echo off
cd /d C:\Projects\KaysPay
:loop
npx expo start --port 8081
timeout /t 5 /nobreak >nul
goto loop
