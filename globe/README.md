# 访客地图 · globe/

## 页面定位

`index.html` 单页：3D 地球上的访客地图，中英双语面板，可定位、下沉面板。
`globe.gl` 首选本地 `vendor/globe.gl.min.js`，失败时走 CDN 竞速兜底；
纹理在 `textures/`。

## 本地预览

`vendor/` 与 `textures/` 用相对路径，但 `build-info.js` 与提交跳转按站点根解析，
统一用 HTTP server 预览，根目录为站点根：

```bash
cd /sdcard/1011 && python3 -m http.server 8000
# 浏览器开 http://localhost:8000/globe/
```

## 数据改动路径

本页无 `data/` 数据文件。访客数据来自运行时后端统计，前端只做展示；
改样式/文案直接改 `index.html`（改前先和 reviewer 确认，保持暗黑风与移动端 390px 可用）。

## 构建定位

页脚 `teecatt · 构建于 —（#siteBuildInfo）` 由 `../build-info.js` 填入 sha 并链到对应提交，
是定位线上版本的第一入口。
