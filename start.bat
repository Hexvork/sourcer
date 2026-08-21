@echo off
chcp 65001 >nul
title 猎头简历搜寻系统
cd /d %~dp0

echo ============================================
echo   猎头简历搜寻系统 - 启动中（Node.js + SQLite）
echo ============================================

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 22+ 并加入 PATH
    pause
    exit /b 1
)

if not exist node_modules (
    echo [1/2] 首次运行，正在安装依赖...
    npm install --no-audit --no-fund
)

echo [2/2] 启动服务，浏览器将自动打开 http://127.0.0.1:3000
start "" http://127.0.0.1:3000
node server.js

pause
