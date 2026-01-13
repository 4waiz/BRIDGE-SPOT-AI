@echo off
echo ============================================
echo Spot AI Voice Server Setup
echo ============================================
echo.

echo Installing Python dependencies...
pip install -r requirements.txt

echo.
echo ============================================
echo Installation complete!
echo ============================================
echo.
echo To start the voice server, run:
echo   python voice_server.py
echo.
echo The server will run on http://localhost:5000
echo.
pause
