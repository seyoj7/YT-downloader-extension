@echo off
title YT Downloader - Install Dependencies

echo Installing Python dependencies...
pip install -r "%~dp0server\requirements.txt"

echo.
echo Generating extension icons...
python "%~dp0server\generate_icons.py"

echo.
echo Done! Run start_server.bat to start the download server.
pause