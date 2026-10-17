<#
  TrafficMonitor 配置一键部署 (down2.top 资源库)

  用法:
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Dest "D:\Tools\TrafficMonitor"
    powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -WithPlugin

  动作: 定位安装目录 -> 结束进程 -> 备份旧配置 -> 下载并覆盖 -> 重新启动
#>
[CmdletBinding()]
param(
    [string]$Site = 'https://down2.top/tools/tools/tm-config',
    [string]$Dest,
    [switch]$WithPlugin,
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

function Info($m) { Write-Host "[TM-CONFIG] $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "[TM-CONFIG] $m" -ForegroundColor Yellow }

$Files = @('config.ini', 'global_cfg.ini')

# ---------- 1. 定位安装目录 ----------
if (-not $Dest) {
    $cands = @(
        (Join-Path $env:LOCALAPPDATA 'TrafficMonitor\TrafficMonitor'),
        (Join-Path $env:ProgramFiles 'TrafficMonitor'),
        (Join-Path ${env:ProgramFiles(x86)} 'TrafficMonitor'),
        (Join-Path $env:USERPROFILE 'Desktop\TrafficMonitor'),
        (Join-Path $env:USERPROFILE 'Downloads\TrafficMonitor')
    )
    $Dest = $cands | Where-Object { $_ -and (Test-Path (Join-Path $_ 'TrafficMonitor.exe')) } | Select-Object -First 1
    if (-not $Dest) {
        $proc = Get-Process -Name TrafficMonitor -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($proc -and $proc.Path) { $Dest = Split-Path -Parent $proc.Path }
    }
}
if (-not $Dest) {
    throw '未找到 TrafficMonitor 安装目录，请用 -Dest 指定，例如 -Dest "C:\Tools\TrafficMonitor"'
}
if (-not (Test-Path (Join-Path $Dest 'TrafficMonitor.exe'))) {
    Warn "该目录下没有 TrafficMonitor.exe，仍按指定目录继续: $Dest"
}
Info "安装目录: $Dest"

$exe         = Join-Path $Dest 'TrafficMonitor.exe'
$wasRunning  = [bool](Get-Process -Name TrafficMonitor -ErrorAction SilentlyContinue)

# ---------- 2. 结束正在运行的进程 ----------
if ($wasRunning) {
    Info '正在结束 TrafficMonitor ...'
    Stop-Process -Name TrafficMonitor -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 900
}

# ---------- 3. 备份现有配置 ----------
$stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$roamingDir = Join-Path $env:APPDATA 'TrafficMonitor'
$roamingCfg = Join-Path $roamingDir 'config.ini'

foreach ($f in $Files) {
    $src = Join-Path $Dest $f
    if (Test-Path $src) {
        Copy-Item $src "$src.bak-$stamp" -Force
        Info "已备份 $f -> $f.bak-$stamp"
    }
}
if (Test-Path $roamingCfg) {
    Copy-Item $roamingCfg "$roamingCfg.bak-$stamp" -Force
    Info '已备份 %APPDATA%\TrafficMonitor\config.ini'
}

# ---------- 4. 下载并覆盖 ----------
foreach ($f in $Files) {
    $url = "$Site/$f"
    $tmp = Join-Path $env:TEMP "tm-config-$f"
    Info "下载 $url"
    try {
        Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing
    } catch {
        throw "下载失败: $url  原因: $($_.Exception.Message)"
    }
    Copy-Item $tmp (Join-Path $Dest $f) -Force
    Info "已写入 $f"
}
if (Test-Path $roamingCfg) {
    Copy-Item (Join-Path $env:TEMP 'tm-config-config.ini') $roamingCfg -Force
    Info '已同步 config.ini 到 %APPDATA%\TrafficMonitor\'
}

# ---------- 5. 可选: 电池电流插件 ----------
if ($WithPlugin) {
    $pluginDir = Join-Path $Dest 'plugins'
    New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
    $dllUrl = 'https://down2.top/tools/plugins/tm-plugins/battery-current/BatteryCurrentPlugin.dll'
    $dllOut = Join-Path $pluginDir 'BatteryCurrentPlugin.dll'
    Info "下载插件 $dllUrl"
    try {
        Invoke-WebRequest -Uri $dllUrl -OutFile $dllOut -UseBasicParsing
        Info '插件已安装: plugins\BatteryCurrentPlugin.dll'
    } catch {
        Warn "插件下载失败(已忽略): $($_.Exception.Message)"
    }
}

# ---------- 6. 重新启动 ----------
if ($wasRunning -and -not $NoRestart) {
    if (Test-Path $exe) {
        Start-Process -FilePath $exe -WorkingDirectory $Dest
        Info '已重新启动 TrafficMonitor'
    } else {
        Warn '未找到 TrafficMonitor.exe，请手动启动'
    }
}

Info '完成: 配置已就绪'
