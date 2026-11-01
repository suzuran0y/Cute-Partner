@echo off
setlocal
set "taskNode=node.exe"
where node.exe >nul 2>nul
if errorlevel 1 set "taskNode=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
"%taskNode%" "%~dp0tools\start.cjs"
if errorlevel 1 pause
