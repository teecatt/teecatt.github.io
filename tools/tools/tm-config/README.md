# TrafficMonitor 配置 (一键还原)

把当前在用的 TrafficMonitor 配置备份到资源库，换机 / 重装系统后一条命令还原：
任务栏样式、显示项、主题配色、插件项、单位与对齐方式全部照旧。

## 一键部署

PowerShell（推荐，复制即用）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "iwr https://down2.top/tools/tools/tm-config/install.ps1 -OutFile $env:TEMP\tm-cfg.ps1; & $env:TEMP\tm-cfg.ps1"
```

或直接双击 [install.bat](https://down2.top/tools/tools/tm-config/install.bat)（内部同样调用 install.ps1）。

## 脚本做了什么

1. 自动定位 TrafficMonitor 安装目录（优先 `%LOCALAPPDATA%\TrafficMonitor\TrafficMonitor`，其次 Program Files / 桌面 / 下载，最后从运行中的进程反查）
2. 结束正在运行的 TrafficMonitor
3. 把现有 `config.ini` / `global_cfg.ini` 备份为 `*.bak-<时间戳>`
4. 下载本站配置并覆盖
5. `-WithPlugin` 时顺带安装电池电流插件 `BatteryCurrentPlugin.dll`
6. 重新启动 TrafficMonitor

## 参数

| 参数 | 说明 |
|------|------|
| `-Dest <目录>` | 手动指定安装目录，例如 `-Dest "D:\Tools\TrafficMonitor"` |
| `-WithPlugin` | 同时下载 `BatteryCurrentPlugin.dll` 到 `plugins\` |
| `-NoRestart` | 部署完成不自动启动 |

## 文件

| 文件 | 说明 |
|------|------|
| [config.ini](https://down2.top/tools/tools/tm-config/config.ini) | 主配置：任务栏样式 / 显示项 / 插件项 / 主题配色 |
| [global_cfg.ini](https://down2.top/tools/tools/tm-config/global_cfg.ini) | `portable_mode=true`，让配置就地在程序目录生效 |
| [install.ps1](https://down2.top/tools/tools/tm-config/install.ps1) | 部署脚本主体 |
| [install.bat](https://down2.top/tools/tools/tm-config/install.bat) | 双击即用的批处理外壳 |

## 注意

- 配置里的硬件相关字段（硬盘型号 `SAMSUNG MZVLB512HAJQ-00000`、网卡 `Realtek 8852BE`、温度源 `Core (Tctl/Tdie)`）在别的机器上不存在时会自动回退到默认项，不影响使用。
- `position_x` / `position_y` 沿用备份时的坐标；若目标机器分辨率不同，主窗口可能落在屏幕外，可右键任务栏图标解锁后拖回。
- 插件项 `batterycurrent` 需要 `plugins\BatteryCurrentPlugin.dll`，缺失时该项不显示，用 `-WithPlugin` 一并装上即可。
