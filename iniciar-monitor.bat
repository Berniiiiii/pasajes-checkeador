@echo off
rem Starts the COR-FTE price monitor in the background (hidden window).
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process node -ArgumentList 'monitor.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
echo Monitor iniciado. Ver monitor.log para el historial.
