@echo off
chcp 65001 >nul
echo ========================================
echo   AI分镜工作室 - 预览生产版本
echo ========================================
echo.

cd /d "%~dp0\..\.."

if not exist "dist" (
    echo [错误] 未找到构建输出！
    echo        请先运行 scripts\\windows\\build.bat
    pause
    exit /b 1
)

echo [1/2] 清理旧端口进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :4173') do (
    taskkill /PID %%a /F >nul 2>&1
)

echo.
echo [2/2] 启动预览服务器...
echo.
echo 启动后请访问: http://localhost:4173
echo ========================================
echo.

npm run preview

if errorlevel 1 (
    echo.
    echo [错误] 预览失败！
    pause
)