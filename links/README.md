# 外部链接 · links/

## 页面定位

`index.html` 单页：拉取 `../data/links.json`，按 `groups[]` 分组渲染外部工具卡片
（图标 + 名称 + 描述 + URL，新窗口打开）。slogan：站在巨人的肩膀上，避免重复造轮子。

## 本地预览

必须起 HTTP server（`fetch ../data/links.json` 在 `file://` 下被拦），根目录为站点根：

```bash
cd /sdcard/1011 && python3 -m http.server 8000
# 浏览器开 http://localhost:8000/links/
```

## 数据改动路径

**`data/links.json` 加条目即生效**，不碰本目录代码。在目标 group 的 `items` 里追加：

```json
{ "name": "名称", "ico": "🧭", "desc": "一句话描述", "url": "https://…" }
```

`ico` 缺省时页面兜底显示 `🔗`。完整字段规则见 `../data/README.md`。

## 构建定位

页脚 `… · <span data-build="links">` 由 `shared/build-stamp.js` 填入短 sha，
点它可跳到对应提交，确认线上链接数据是哪版。
