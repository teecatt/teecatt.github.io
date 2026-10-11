# 数据字段说明 · data/

`library/`、`links/`、`tools/` 三个页面都是纯数据驱动：改这里的 JSON 并推送即生效，
不碰任何页面代码。校验：`python3 -c "import json; json.load(open('data/catalog.json')); json.load(open('data/links.json'))"`。

## catalog.json（资源库 + 工具页）

顶层 `{ "items": [...] }`，`library/index.html` 按 `type` 分组（`TYPE_ORDER`，未知 type 落"其他"分区），
`tools/index.html` 取其中 `type=tools` 的条目按 `platform` 分组（缺省进通用）。条目字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 唯一标识，小写短横线 |
| `name` | 是 | 展示名称 |
| `desc` | 是 | 一句话描述 |
| `type` | 是 | 6 类之一：`rules` / `tools` / `skills` / `plugins` / `guides` / `context` |
| `status` | 是 | `ready`（✅ 已就绪）/ `wip`（🚧 WIP） |
| `platform` | tools 条目建议填 | `General` / `Linux` / `Android` / `Windows`（tools 页分组用） |
| `install` / `deploy` | 否 | 一键安装/部署命令（渲染为可复制代码块） |
| `commands` | 否 | 常用命令数组 |
| `docs` | 否 | 工具文档路径，如 `tools/tools/<slug>/README.md` |
| `files` | 否 | 部署文件路径数组，如 `tools/tools/<slug>/install.sh` |

## links.json（外部链接页）

顶层 `{ "groups": [{ "name": 分组名, "items": [...] }] }`，条目字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 展示名称 |
| `url` | 是 | 目标地址（新窗口打开，`rel="noopener"`） |
| `desc` | 否 | 一句话描述 |
| `ico` | 否 | emoji 图标，缺省页面兜底 `🔗` |

## 绝对路径规则

`library` / `tools` 页内的 `docs` / `files` 请写**仓库相对路径**
（如 `tools/rules/keep-my-commit-clean/README.md`，不要以 `/` 开头），
页面内的 `abs()` 会统一转成站点根绝对路径（`/tools/...`）。
写成 `./` 或 `../` 开头会在子目录下解析错误；本地用 `file://` 打开同样 404，
必须 `python3 -m http.server` 从站点根预览。
