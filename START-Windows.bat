@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund
)
echo Starting FILME on http://localhost:8440
node src\server.js
pause
