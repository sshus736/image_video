@echo off
chcp 65001 >nul
echo ========================================
echo   AI分镜工作室 - 后端服务启动
echo ========================================
echo.
echo 注意: 前端开发服务器 (Vite) 内置代理，
echo       通常无需单独启动此服务。
echo.
echo 如果需要独立运行后端，请先设置 .env
echo 文件中的环境变量。
echo ========================================
echo.

cd /d "%~dp0\..\..\server"

echo 启动后端服务...
echo.

node index.js

if errorlevel 1 (
    echo.
    echo [错误] 后端启动失败！
    echo        请检查:
    echo        1. Node.js 是否已安装
    echo        2. .env 文件是否配置正确
    pause
)