@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================================
rem  部署脚本模板（请把真实凭据填到这里，或用环境变量注入）
rem  注意：本文件含密钥，已加入 .gitignore，不会上传到 GitHub
rem  推荐改用 wrangler secret 管理密码，不要把密钥写死在文件里
rem ============================================================

rem ---- wrangler 路径（按需修改）----
set NODE="C:\path\to\node.exe"
set WRANGLER="C:\path\to\node_modules\wrangler\bin\wrangler.js"

rem ---- 1) 自动生成新版本号（写进 index.html 与 app.js），改版后浏览器自动取新文件 ----
%NODE% bump.js
if errorlevel 1 goto fail

rem ---- 2) 部署（Cloudflare API 令牌，细粒度权限：Account/Worker Scripts、Account/Workers KV Storage）----
set CLOUDFLARE_API_TOKEN=cfut_你的API令牌
set CLOUDFLARE_ACCOUNT_ID=你的账户ID
set CI=1

%NODE% %WRANGLER% deploy
if errorlevel 1 goto fail

rem ---- 3) 清 CDN 缓存（可选，需 Cache Purge 权限；用全局 API 密钥 X-Auth-Key 方式，不是 Bearer）----
set CF_EMAIL=you@example.com
set CF_GLOBALKEY=cfk_你的全局API密钥
set CF_ZONE=你的ZoneID

echo.
echo [purge] clearing Cloudflare cache...
curl -s --noproxy "*" -X POST "https://api.cloudflare.com/client/v4/zones/%CF_ZONE%/purge_cache" ^
  -H "X-Auth-Email: %CF_EMAIL%" ^
  -H "X-Auth-Key: %CF_GLOBALKEY%" ^
  -H "Content-Type: application/json" ^
  -d "{\"purge_everything\":true}"
echo.
echo [done] deploy complete
goto end

:fail
echo.
echo [failed] deploy error

:end
echo.
pause
