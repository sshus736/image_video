@echo off
chcp 65001 >nul
echo ========================================
echo   AI分镜工作室 - 构建生产版本
echo ========================================
echo.

cd /d "%~dp0\..\.."

echo [1/2] 检查 node_modules...
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
echo [2/2] 开始构建...
echo.

npm run build

if errorlevel 1 (
    echo.
    echo [错误] 构建失败！
    pause
    exit /b 1
)

echo.
echo ========================================
echo   构建完成！
echo   输出目录: dist/
echo ========================================
echo.
pause