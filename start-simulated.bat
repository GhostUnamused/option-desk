@echo off
title Option Desk (replay of past market days)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again.
  pause
  exit /b 1
)
start "" http://localhost:4321
node server.js --sim
pause
