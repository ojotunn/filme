@echo off
echo Stopping anything listening on port 8440...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8440 ^| findstr LISTENING') do taskkill /PID %%p /F
echo Done.
pause
