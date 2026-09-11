@echo off
title ACONA STORE Server
cd /d "%~dp0"
echo ======================================
echo  ACONA STORE backend starting...
echo  Store: http://localhost:3000/ACONA.html
echo  Admin: http://localhost:3000/admin.html
echo  To STOP: press Ctrl+C in this window
echo ======================================
node server.js
pause
