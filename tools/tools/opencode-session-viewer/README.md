# opencode-session-viewer

快速查看、进入 opencode 历史会话的命令行工具，可将任意会话导出为交互式 HTML 审计报告，并支持回收站式软删除。

## 安装

```bash
curl -fsSL https://down2.top/tools/tools/opencode-session-viewer/install.sh | bash
source ~/.bashrc
```

## 使用

```
Usage: sss [opt] [args...]
  sss                           - List 10 newest-created sessions with previews
  sss t|title                   - List all session titles
  sss setw|setwidth [W]         - Show or set truncation width, persisted
  sss v|view N [C]              - Show last C interactions of session N
  sss in N                      - Enter session N
  sss a|audit N                 - Generate HTML audit report for session N
  sss d|del|delete N [y] [force]- Soft-delete to trash, or hard-delete with force
  sss trash                     - List trashed sessions
  sss restore N|all             - Restore trashed session N and enter it, or restore all
  sss empty [y] [force]         - Permanently delete all trashed sessions
  sss h|help                    - Show this help
```

```bash
sss             # 列出最新创建的 10 个会话（各带 5 轮预览）
sss t           # 列出全部会话标题
sss v 0         # 看 0 号会话最后 20 轮交互
sss v 0 5       # 看 0 号会话最后 5 轮交互
sss in 0        # 进入 0 号会话
sss a 0         # 为 0 号会话生成 HTML 审计报告
sss d 0         # 0 号会话移入回收站（标记删除）
sss d 0 force   # 0 号会话彻底删除（不可恢复）
sss trash       # 查看回收站
sss restore 0   # 恢复回收站 0 号并进入
sss restore all # 恢复全部，不进入
sss empty       # 清空回收站（不可恢复）
sss setw 120    # 截断宽度设为 120 列（持久保存）
```

序号规则：按会话**创建时间正序**编号，`[0]` 最旧；新会话只追加末尾，
新消息不 reorder；序号只在你亲手标记/硬删除时变化。

## HTML 审计报告

`sss a <N>` 会把对应会话从 `opencode.db` 解析并导出为一份
Material 风格（mkdocs-material 视觉语言）的交互式 HTML 审计报告，采用渐进式披露：

- 默认只显示回合摘要；思考过程、工具调用、命令输出等细节逐层展开
- 思考过程默认展开；每个命令的输出默认折叠在对应命令之下
- 结构化输出（如 curl 返回的 JSON）自动渲染为可逐层展开的字段树
- 生成文件位于 `~/opencode-audit/<session_id>.html`，并自动生成 `index.html` 索引

### 脚本

| 文件 | 说明 |
|------|------|
| `sss.py` | 会话列表 / 详情 / 进入 / 删除（含回收站）/ 宽度配置 |
| `opencode_audit.py` | 解析 `opencode.db` 并生成 HTML 审计报告 |

## 回收站

- `sss d N` 默认只做**标记删除**：列表不再显示，数据仍在库中，可恢复
- `sss d N force` / `sss empty` 才真正从数据库删除（级联清 message/part/todo，不可恢复）
- 正在被 `opencode -s` attach 的会话拒绝标记删除之外的真删（`force` 放行但仍需确认）

## 颜色说明

| 元素 | 颜色 |
|------|------|
| 序号+标题 / Created / Last Access | 亮黄色 |
| Session ID | 超链接蓝 + 下划线（tty 下可点击打开审计报告） |
| Deleted At | 红色 |
| 用户问题 [Q] | 红色 |
| Agent 回复 [A] | 绿色 |
| 统计行 / 提示 | 暗灰色 |

## 依赖

- Python 3
- opencode
