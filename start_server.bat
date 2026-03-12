@echo off
title YT Downloader Server

echo ====================================
echo   YT Downloader - Local Server
echo ====================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python not found. Install from https://python.org
    pause
    exit /b 1
)

:: Install Python dependencies if needed
echo Checking Python dependencies...
pip show flask >nul 2>&1
if errorlevel 1 (
    echo Installing dependencies...
    pip install -r "%~dp0server\requirements.txt"
)
pip show yt-dlp >nul 2>&1
if errorlevel 1 (
    pip install yt-dlp
)

:: Add bundled bin/ folder to PATH so ffmpeg is found
set "PATH=%~dp0bin;%PATH%"

:: Check for ffmpeg (bundled or system)
ffmpeg -version >nul 2>&1
if errorlevel 1 (
    echo.
    echo [WARNING] ffmpeg not found in bin\ or system PATH.
    echo Place ffmpeg.exe in the bin\ folder next to this script.
    echo The server will still work but quality may be limited.
    echo.
) else (
    echo [OK] ffmpeg found.
)

:: Generate icons if missing
if not exist "%~dp0extension\icons\icon48.png" (
    echo Generating extension icons...
    python "%~dp0server\generate_icons.py"
)

:: Start server
echo.
echo Starting server on http://localhost:7979
echo Files will be saved to: %USERPROFILE%\Downloads\YT-Downloader\
echo.
echo Press Ctrl+C to stop the server.
echo.
python "%~dp0server\server.py"

pause
