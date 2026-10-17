@echo off
setlocal
set "URL=https://down2.top/tools/tools/tm-config/install.ps1"
set "TMP=%TEMP%\tm-config-install.ps1"

echo [TM-CONFIG] TrafficMonitor config one-click deploy
echo [TM-CONFIG] downloading %URL%

powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%URL%' -OutFile '%TMP%' -UseBasicParsing } catch { exit 1 }"

if not exist "%TMP%" (
  echo [TM-CONFIG] download failed, please check your network
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%TMP%" %*
set "RC=%ERRORLEVEL%"

if not "%RC%"=="0" (
  echo [TM-CONFIG] deploy failed with code %RC%
) else (
  echo [TM-CONFIG] done
)

pause
exit /b %RC%
