# 实用工具 · tools/

## 页面定位

`index.html` 单页：拉取 `../data/catalog.json`，取 `type=tools` 的 `items` 条目按 `platform`
分组展示（`PLATFORM_ORDER`：General / Linux / Android / Windows；缺 `platform` 的并入通用），
每卡含一键安装/部署命令（复制按钮）、部署文件下载 chip、文档入口。文件与文档链接统一转站点根绝对路径。
外部同步若提供顶层 `data.tools[]` 则优先用它。

## 本地预览

必须起 HTTP server（`fetch` + 根绝对路径在 `file://` 下失效），根目录为站点根：

```bash
cd /sdcard/1011 && python3 -m http.server 8000
# 浏览器开 http://localhost:8000/tools/
```

## 数据改动路径

- 改条目：改 `data/catalog.json` 里 `type=tools` 的 `items`（`platform` 缺省进通用分组），推送即生效。
- 改工具本身：进 `tools/<type>/<slug>/`（type 与 library 的 6 类同名），看该子目录 README：

| 子目录 | 内容举例 |
|--------|----------|
| `tools/tools/` | opencode-session-viewer、pidfd-watchdog |
| `tools/rules/` | keep-my-commit-clean |
| `tools/skills/` | gui-vision-agent |
| `tools/plugins/` | tm-plugins |
| `tools/guides/` | autostart |
| `tools/context/` | opencode-acp |

子目录 README 是各工具的唯一入口文档（安装/命令/文件清单以其为准）。

## 构建定位

本页页脚暂无 `data-build` 占位，定位线上版本看 `../build-info.js` 注入的信息；
给本页加 `data-build` 需改 `index.html`（改前先和 reviewer 确认）。
