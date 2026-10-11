# 资源库 · library/

## 页面定位

`index.html` 单页：拉取 `../data/catalog.json`，按 `type` 分组展示资源卡片
（一键安装 / 常用命令 / 部署文件 / 文档入口 + 复制按钮）。
分组顺序与标签由页内 `TYPE_ORDER` / `TYPE_LABEL` 定死，共 6 类：

`rules` 📋 规范文档 · `tools` 🛠️ 实用工具 · `skills` 🎯 技能包 ·
`plugins` 🧩 插件 · `guides` 📖 方案指南 · `context` 🧠 上下文压缩与自愈

## 本地预览

站内文件/文档链接统一转站点根绝对路径（`abs()` 加 `/` 前缀），`file://` 打开会 404，
必须起 HTTP server，根目录为站点根：

```bash
cd /sdcard/1011 && python3 -m http.server 8000
# 浏览器开 http://localhost:8000/library/
```

## 数据改动路径

只改 `data/catalog.json` 的 `items[]`，推送即生效，不碰本目录代码。
字段见 `../data/README.md`。`type` 必须是上述 6 类之一，否则只会落在无标签分组；
`docs` / `files` 写仓库相对路径（如 `tools/tools/<slug>/README.md`），页面自动转绝对路径。

## 构建定位

页脚 `teecatt · … · <span data-build="library">` 由 `shared/build-stamp.js` 填入短 sha，
点它可跳到对应提交，定位当前线上跑的是哪版数据/代码。
