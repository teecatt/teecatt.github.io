# down2.top

个人工具与资源门户，同时部署到 GitHub Pages 与 Cloudflare Pages，自定义域名 `down2.top`。

## 站点结构

| 路径 | 说明 |
|------|------|
| `/` | 首页导航 |
| `/music_visualization/` | 音频可视化 |
| `/midi_player/` | 在线 MIDI 播放器，多种键型钢琴 · 音游模式 · CDN 竞速 |
| `/midi_player_v2/` | MIDI 播放器 V2（开发中） |
| `/audio_to_midi/` | 音频转 MIDI（本地推理，ONNX + Viterbi；详见该目录 README） |
| `/library/` | 资源库，按类型分类：rules / tools / skills / plugins / guides / context（6 类） |
| `/links/` | 外部在线工具导航 |
| `/tools/` | 个人实用工具：取 catalog 中 `type=tools` 条目，按平台分组（General / Linux / Android / Windows） |
| `/globe/` | 访客地图 |
| `/crypto/` | 加密工具箱（纯前端本地处理） |
| `/notes/` | 死目录：无页面，仅 `vendor/` 预留（见 `notes/README.md`） |
| `/ui-kit/` | 可复用 UI 组件归档：圆形按钮 / 配色面板 / 调试面板（纯 CSS + 演示） |

## 目录结构

```
├── index.html              # 首页
├── CNAME                   # 自定义域名配置
├── data/
│   ├── catalog.json        # 资源库数据（items[]，type 6 类）
│   └── links.json          # 外部链接数据（groups[]）
├── music_visualization/    # 音频可视化页面（index.html + app.js，无 app.css）
├── midi_player/            # MIDI 播放器页面（样式内联于 index.html + app.js）
│   ├── index.html          #   含内联 <style id="appCss">
│   └── midi/               # MIDI 谱子目录
│       ├── list.json       # 谱子列表配置
│       └── *.mid           # MIDI 文件
├── midi_player_v2/         # MIDI 播放器 V2（开发中，勿动）
├── audio_to_midi/          # 音频转 MIDI（勿动；部署靠文件内容哈希自动 bump `?v=`，人不记版本）
├── ui-kit/                 # UI 组件归档（ui-kit.css + index.html 演示 + README）
├── library/                # 资源库页面（index.html + README）
├── links/                  # 外部链接页面（index.html + README）
├── tools/                  # 工具索引页 + 工具源文件（按 catalog type 分目录，见 tools/README）
│   ├── index.html          # 取 catalog type=tools 条目，按 platform 分组展示
│   └── {context,guides,plugins,rules,skills,tools}/<slug>/
├── globe/                  # 访客地图（本地 vendor + CDN 竞速兜底）
├── crypto/                 # 加密工具箱（纯前端，依赖全在本地 vendor/）
├── notes/                  # 死目录：仅 vendor/ 预留，无 index.html
└── .github/workflows/      # 自动部署配置
```

## 转写验收说明

`audio_to_midi` 的多线程 wasm 需要 SharedArrayBuffer，依赖 COOP/COEP 隔离头（见 `_headers`，
仅圈 `/audio_to_midi/*`）。**转写验收一律走 <https://down2.top>（Cloudflare 会下发该头）**，
GitHub Pages（`*.github.io`）无此隔离头，多线程跑不起来。结论引用自
`audio_to_midi/README.md`（该目录已冻结，本文档只引用、不复述实现细节）。

## 添加外部链接 / 资源条目

- 外部链接：编辑 `data/links.json`，在对应 group 的 `items` 里加 `{name, ico, desc, url}`，
  推送即生效（页面有缺 `ico` 时的 `🔗` 兜底）。详见 `links/README.md`、`data/README.md`。
- 资源库：编辑 `data/catalog.json` 的 `items`，`type` 取 6 类之一
  （`library/index.html` 内 `TYPE_ORDER`：rules / tools / skills / plugins / guides / context），
  推送即在资源库页生效；其中 `type=tools` 的条目会同步出现在工具页（缺 `platform` 的进通用分组）。
  `tools/` 源文件路径用仓库相对路径（如 `tools/tools/<slug>/...`），页面会自动转站点根绝对路径。
  详见 `library/README.md`、`tools/README.md`、`data/README.md`。

## 关键 URL

- 站点：<https://down2.top>
- 音频可视化：<https://down2.top/music_visualization/>
- MIDI 播放器：<https://down2.top/midi_player/> · V2：<https://down2.top/midi_player_v2/>
- 音频转 MIDI：<https://down2.top/audio_to_midi/>（验收只用此域，见上）
- 资源库：<https://down2.top/library/>
- 外部链接：<https://down2.top/links/>
- 实用工具：<https://down2.top/tools/>
- 访客地图：<https://down2.top/globe/>
- 加密工具箱：<https://down2.top/crypto/>
- UI Kit：<https://down2.top/ui-kit/>
- 临时云文件（手机上的只读文件中转站，首页「临时云文件」卡片指向它）：<https://f.down2.top>

## 每页 README 索引

| 页面 | README | 一句话 |
|------|--------|--------|
| 资源库 `library/` | `library/README.md` | catalog 驱动的 6 类资源展示 |
| 外部链接 `links/` | `links/README.md` | links.json 加条目即生效 |
| 实用工具 `tools/` | `tools/README.md` | index 数据流 + 各 `tools/<type>/<slug>/README` 入口 |
| 访客地图 `globe/` | `globe/README.md` | 本地 vendor globe.gl |
| 加密工具箱 `crypto/` | `crypto/README.md` | 纯前端承诺 + 本地 vendor |
| notes（死目录） | `notes/README.md` | 无 index，仅 vendor 预留 |
| 数据字段 | `data/README.md` | catalog / links 字段 + 绝对路径规则 |
| 音频可视化 | `music_visualization/README.md` | 随页面维护 |
| MIDI 播放器 / V2 | `midi_player/README.md` · `midi_player_v2/README.md` | 随页面维护（冻结，勿动） |
| 音频转 MIDI | `audio_to_midi/README.md` | 冻结，勿动；本文档只引用其结论 |
| UI 组件 | `ui-kit/README.md` | 随组件维护 |

## 部署

push `master` 后，`.github/workflows/deploy.yml` 会自动：

1. `deploy`：发布到 GitHub Pages（`teecatt.github.io`）
2. `cloudflare`：将站点快照同步到 Cloudflare Pages 项目 `d2p`（生产分支 `master`，对应自定义域 `down2.top`）
3. `cleanup`：清理旧的 push 触发 run / deployment

`cloudflare` job 依赖仓库 Secrets：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`。
另外部署工作流按文件内容哈希自动重写 `?v=`（短哈希 sed 进 `index.html`/`app.js`），
没改代码就不 bust 缓存，人不记版本（结论引自 `audio_to_midi/README.md`）。

## 技术要点

- 纯静态页面，数据驱动
- 暗色主题，移动端自适应
- GitHub Pages + Cloudflare Pages 双端部署
- 站内引用统一用站点根绝对路径（`/tools/...`、`/data/...`），由各页 `abs()` 转换，
  避免子目录下相对解析错误；因此本地预览必须起 HTTP server（见各页 README）
