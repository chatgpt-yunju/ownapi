@echo off
chcp 65001
cls
echo ================================================
echo    批量工业化埋点系统 - 完整配置脚本
echo ================================================
echo.

REM 步骤1: 检查 Python
echo [步骤 1/5] 检查 Python 安装...
python --version >nul 2>&1
if errorlevel 1 (
    echo [X] Python 未安装
    echo 请访问 https://python.org 下载并安装 Python 3.8+
    pause
    exit /b 1
)
echo [OK] Python 已安装

REM 步骤2: 创建配置文件
echo.
echo [步骤 2/5] 创建配置文件...
echo.
echo 请打开浏览器访问: https://webhook.site
echo 复制你的专属 URL，然后粘贴到下面:
echo.
set /p WEBHOOK_URL=请输入您的 webhook URL:

if "%WEBHOOK_URL%"=="" (
    echo [X] URL 不能为空
    pause
    exit /b 1
)

REM 创建配置文件
echo const WEBHOOK_URL = '%WEBHOOK_URL%';> webhook-config.js
echo const PROJECTS = [>> webhook-config.js
echo     ['../../test-projects/project-a/src', 'shop_demo'],>> webhook-config.js
echo     ['../../test-projects/project-b/js', 'admin_demo'],>> webhook-config.js
echo ];>> webhook-config.js
echo module.exports = { WEBHOOK_URL, PROJECTS };>> webhook-config.js

echo [OK] 配置文件已创建: webhook-config.js

REM 步骤3: 查看项目列表
echo.
echo [步骤 3/5] 验证项目配置...
python -c "const c=require('./webhook-config.js');print('项目列表:');c.PROJECTS.forEach(p=^>print('  - '+p[1]+': '+p[0]))"

REM 步骤4: 询问是否继续
echo.
echo [步骤 4/5] 准备插入埋点代码
echo.
echo 即将在以下项目插入埋点代码:
echo   1. project-a/src (shop_demo)
echo   2. project-b/js (admin_demo)
echo.
echo 按任意键继续...
pause >nul

REM 步骤5: 插入埋点
echo.
echo [步骤 5/5] 插入埋点代码...
python batch-inserter.py

echo.
echo ================================================
echo              配置完成 - 下一步
echo ================================================
echo.
echo 1. 部署这些项目到服务器 (或使用 ngrok 本地测试)
echo 2. 等待 5 分钟后访问 webhook.site 查看上报
echo 3. 部署 alert-proxy.js 实现手机通知
echo.
pause
