# opencode 上下文压缩指导（省钱版）

> 来源：2026-10-11 实测账本与线上配置。目标只有一个：**别让压缩把缓存省下来的钱烧掉**。
> 适用：opencode 1.x + `opencode-acp@latest`（V1 插件 API）。

## 1. 先算账：为什么压缩反而更贵

三家模型缓存命中约＝未命中的 **1/50**（1M 上下文）：

| 模型 | 输入 miss /1M | 输入 hit /1M | 输出 /1M |
|---|---|---|---|
| muse-spark-1.3-contributor | $0.10 | **$0.002** | $0.20 |
| deepseek-flash（谷/峰） | $0.15/$0.30 | **$0.003/$0.006** | $0.60/$1.20 |
| mimo-v2.6-flash | $0.14 | **$0.0028** | $0.28 |

- 稳态 25 万上下文全命中时，muse 输入约 **$0.0005/次**。
- **每次压缩强制下一次全量 miss**：25 万上下文单次 $0.025（muse）~$0.075（ds 峰），外加压缩本身的 output token（最贵）。
- 结论：「3 轮 + 3600 token 就压」的激进版等于每 4 轮主动丢一次缓存，输入账单涨 2~10 倍——**已推翻**，不要用。

## 2. 最终配置（`~/.config/opencode/acp.jsonc`）

```json
{
  "$schema": "https://raw.githubusercontent.com/ranxianglei/opencode-acp/master/dcp.schema.json",
  "compress": {
    "showCompression": true,
    "maxContextLimit": "80%",
    "minContextLimit": "40%",
    "minNudgeContextPercent": 10,
    "nudgeFrequency": 5,
    "iterationNudgeThreshold": 15,
    "nudgeForce": "soft",
    "nudgeGrowthTokens": 50000,
    "minNudgeGrowthRatio": 0.45,
    "minNudgeGrowthFloor": 5000,
    "toolOutputNudgeThreshold": 50000,
    "minCompressRange": 15000
  }
}
```

三层含义（`%` 类跟**当前模型自己的 window**走，ACP 逐请求读取；纯数字是绝对 token）：

1. **>80% 强催**（1M＝80 万，200k＝16 万，每 5 次请求一次）。80% 不晚的数学：800k 全命中才 $0.0016/次，真正要留的只是 completion reserve（3.2 万）+ emergency 98% + GC 100% 兜底。
2. **>40% 且距用户发言超 15 条才轻提醒**。25 万/1M 现状约等于静默——故意的。
3. **>10% 且新增超约 2.2 万**（50000×0.45）才生长提醒。

- `minCompressRange 15000` 字符：小碎压直接被工具拒绝，每次压必须赚回那一次全量 miss。
- **血泪**：`minContextLimit: 400000` 写死会让 200k 模型（＝200%）永远不提醒，已改 `40%`。
- 生效：新会话直接生效；运行中会话下次请求前以 instruction update 生效；改完用 `python3 -c "import json;json.load(open(...))"` 验 JSON。
- 小模型想更激进**别动全局**，加覆盖（是否加还没定）：
  `{"compress": {"modelMaxLimits": {"xiaomi/mimo-v2.6-flash": "70%"}}}`
- deepseek 重活放 off-peak：周末全天谷价，工作日避 01–04、06–10 UTC（峰谷差一倍）。

## 3. 全局指令（`~/.config/opencode/AGENTS.md`）

- 主题大幅切换（搜索→写代码→架构→debug）时，压**已完结的上一主题**，留路径/签名/决策/结论/待办；当前主题与 recent 不动。
- **缓存优先**：大主题完结**且**超约 40% 才压；小切换攒大段一次压完。
- 不确定先看用量：`/acp context`（分类用量＋已省）/`/acp stats`（块数/用量/压缩比），可 `decompress`/`search_context` 找回。
- **任务完结标记（供 watchdog）**：真正全完成才在末尾独立一行写 `TASK_DONE`（或 `✅ 任务完成`）；未完/被打断绝不写。

## 4. 安装与验证（已完成，备查）

- `opencode plugin opencode-acp@latest --global`，`~/.config/opencode/opencode.jsonc` 追加 `"plugin": ["opencode-acp@latest"]`。
- 按官方强制要求关内置压缩：`"compaction": {"auto": false}`（否则与 ACP 打架：消息重展开、压缩态丢失）。
- 验证：`opencode debug config` 含 `plugin_origins: opencode-acp@latest`、`command.acp`、`permission: compress/acp_status: allow`。
- 注意：这是 **V1 插件，只认 opencode 1.x**；2.x 要换 billion-context。`autoUpdate` 默认开，跟着 latest 走。
- 曾误删装：`opencode plugin list` 会把字面 `list` 当插件装（`plugin <module>` 无 list 子命令）——以后别在 `/` 下跑该命令。

## 5. 断线自愈 watchdog v3（`watchdog/opencode-watchdog.sh`，nohup 单进程）

- 节奏每 60s，扫**全量会话**；触发看最近 3 分钟日志行内 UTC 时间戳里任何带 `session.id` 的 `level=ERROR` 行。
- 四不打扰：含 `TASK_DONE`/已归档；用户主动取消；报错后已有新消息（已自愈）；本地不通时跳过（只跟 `1.1.1.1:443`/`8.8.8.8:53` 做 TCP 握手，不碰模型端点）。
- 续跑：刷 CA → `timeout 570 opencode run --dir <会话目录> --session <ID> "……从断点继续……末尾写 TASK_DONE"`；从不关校验。
- 运维：`ps -eo pid,etime,args | grep '[o]pencode-watchdog'` 看护单进程；`tail -f watchdog/watchdog.log` 看日志；`echo ses_xxx >> IGNORED` 停某会话；`cat DONE` 看名单。重启先 `kill <PID>`（**禁用 `pkill -f`，会把自己的 shell 一起杀**），再 `setsid nohup … &`。
- **tmux 已弃**：tmux pane 跑 opencode 报 `libc.so: invalid ELF header`，守护必须跑在本环境。

## 6. 常见坑

- 激进压缩（3 轮＋3600）已推翻，见 §1。
- `400000` 绝对值写法坑 200k 模型，见 §2。
- `/tmp/acp-verify/.opencode/acp.jsonc` 是激进验证配置（30k/20k、3 条、strong），临时场，玩完即删，勿同步线上。
- oh-my-opencode **没装**：它是 agent 增强，修不了证书，别为断线去装。

## 7. 待定

- 小模型 `modelMaxLimits` 是否加；deepseek 峰谷调度是否要定时任务；容器重启后 watchdog 拉起目前靠手工。
