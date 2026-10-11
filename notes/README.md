# notes/（死目录说明）

## 页面定位

**本目录当前无页面、无 `index.html`，是死目录。** 下面只有 `vendor/`，
放着 `argon2-bundled.min.js` + `argon2.wasm`（给未来加密笔记页预留的 argon2 依赖）。
`_routes.json` 已将其排除在路由之外，首页也没有指向这里的入口。

## 本地预览

无页面可预览。有朝一日加了 `index.html`，再按其它页面的四段式补本 README，
并用站点根起 HTTP server 验证：

```bash
cd /sdcard/1011 && python3 -m http.server 8000
```

## 数据改动路径

现在不需要改任何东西。`vendor/` 两个文件是预留依赖，**不要删、不要升级**，
等笔记页立项时再由负责人启用。

## 构建定位

无页面、无页脚、无 `data-build`。本 README 的存在就是为了让后来人知道：
这个目录是故意留的，不是垃圾。
