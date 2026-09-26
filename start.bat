@echo off
setlocal
cd /d "%~dp0"

rem Open the browser as soon as the local server is listening on port 8787
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 120;$i++){try{(New-Object Net.Sockets.TcpClient).Connect('127.0.0.1',8787);Start-Process 'http://localhost:8787';exit}catch{Start-Sleep -Milliseconds 250}}"

echo.
echo   Starting Doge IDE local server...
echo   Your browser will open automatically at: http://localhost:8787
echo   Press Ctrl+C in this window to stop the server.
echo.
if exist node.exe (
    node proxy.mjs
) else (
    where node >nul 2>nul
    if %errorlevel%==0 (
        node proxy.mjs
    ) else (
        echo   Node.js not found, trying Python...
        python proxy.py
    )
)
endlocal