@echo off
chcp 65001 >nul
echo ========================================
echo   AI分镜工作室 - 图片版本 启动脚本
echo ========================================
echo.

cd /d "%~dp0\..\.."

echo [1/3] 检查 node_modules...
if not exist "node_modules" (
    echo        未找到依赖，正在安装...
    call npm install
    if errorlevel 1 (
        echo.
        echo [错误] 依赖安装失败！
        pause
        exit /b 1
    )
    echo        安装完成！
)

echo.
echo [2/3] 清理旧端口进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5175') do (
    taskkill /PID %%a /F >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :3001') do (
    taskkill /PID %%a /F >nul 2>&1
)

echo.
echo [3/3] 启动后端服务...
echo.
start "AI分镜后端" /D "%~dp0\..\..\server" cmd /k node index.js

echo [4/4] 启动开发服务器...
echo.
echo 启动后请访问: http://localhost:5175
echo ========================================
echo.

npm run dev

if errorlevel 1 (
    echo.
    echo [错误] 服务器启动失败！
    pause
)