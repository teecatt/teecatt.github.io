# 加密工具箱 · crypto/

## 页面定位

`index.html` + `app.js` + `styles.css`：常用编码、哈希、对称/非对称加密、
字符集与时间戳转换。**纯前端承诺：所有运算在本地完成，数据不会上传**
（侧边栏原话：`纯前端本地处理，数据不会上传`）。

## 本地预览

依赖（text-encoding、md5、pako、argon2）全在本地 `vendor/`，无外部请求，
但提交跳转与主题按站点路径解析，仍用 HTTP server 预览：

```bash
cd /sdcard/1011 && python3 -m http.server 8000
# 浏览器开 http://localhost:8000/crypto/
```

## 数据改动路径

本页无 `data/` 数据文件。加新工具 = 改 `app.js`（注册算法）+ `index.html`（导航入口），
需要第三方库时必须下载进本地 `vendor/` 并用相对路径引用，**禁止引入外部 CDN 依赖**
（这是纯前端承诺成立的前提）。

## 构建定位

顶栏 `最近构建：—（#buildInfo）` 由 `../build-info.js` 填入 sha 并链到对应提交的文件变更，
定位线上版本看它。
