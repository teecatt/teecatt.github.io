#!/usr/bin/env python3
"""opencode 会话历史查看器 + HTML 审计报告生成。

用法: sss <动词> [参数]
  sss                      无参列表 / t|title 全部标题 / setw|setwidth [W] 宽度
  sss v|view N [C]         会话详情 / in N 进入会话 / a|audit N 审计报告
  sss d|del|delete N [y] [force]  删除（默认进回收站）
  sss trash / restore N|all / empty  回收站：查看 / 恢复某序号并进入或恢复全部 / 清空
  sss h|help               帮助（完整双语说明见 sss h）
"""
import sqlite3
import json
import os
import sys
import subprocess
import unicodedata
from datetime import datetime, timezone, timedelta
from pathlib import Path

DB_PATH = os.path.expanduser("~/.local/share/opencode/opencode.db")
DEFAULT_WIDTH = 80
CONFIG_PATH = os.path.join(os.path.expanduser("~/.config"), "sss", "width")
_IS_TTY = sys.stdout.isatty()


def load_width():
    """SSS_WIDTH 环境变量 > 配置文件 > 默认 80，钳制在 20..500。"""
    v = os.environ.get("SSS_WIDTH", "").strip()
    if v.isdigit():
        return max(20, min(500, int(v)))
    try:
        with open(CONFIG_PATH) as f:
            return max(20, min(500, int(f.read().strip())))
    except Exception:
        return DEFAULT_WIDTH


def save_width(w):
    os.makedirs(os.path.dirname(CONFIG_PATH), exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        f.write(str(w) + "\n")


WIDTH = load_width()


def _char_width(ch):
    if unicodedata.east_asian_width(ch) in ("W", "F"):
        return 2
    if unicodedata.category(ch) == "Mn":
        return 0
    return 1


def _disp_width(s):
    return sum(_char_width(c) for c in s)

GREEN = "\033[32m"
YELLOW = "\033[38;5;228m"
GRAY = "\033[38;5;245m"
LINK = "\033[38;5;21m"
RED = "\033[31m"
BOLD = "\033[1m"
RESET = "\033[0m"
UNDERLINE = "\033[4m"
NO_UNDERLINE = "\033[24m"


def fmt_sid(session_id):
    """会话 ID：蓝色 + 下划线；tty 下再包一层 OSC 8 超链接，点开审计报告。"""
    styled = f"{LINK}{UNDERLINE}{session_id}{NO_UNDERLINE}{RESET}"
    if not _IS_TTY:
        return styled
    try:
        uri = Path(os.path.join(os.path.expanduser("~/opencode-audit"),
                                session_id + ".html")).as_uri()
    except Exception:
        return styled
    return f"\033]8;;{uri}\033\\{styled}\033]8;;\033\\"


def usage():
    cmds = [
        ("sss",
         "List 10 newest-created sessions with 5 previews each",
         "列出最新创建的 10 个会话（各带 5 轮预览），序号按创建时间正序、稳定不变"),
        ("sss t|title",
         "List all session titles",
         "列出全部会话标题"),
        ("sss setw|setwidth [W]",
         "Show or set truncation width, persisted",
         "查看 / 设置截断宽度（20..500，持久保存）"),
        ("sss v|view N [C]",
         "Show last C interactions of session N",
         "看 N 号会话最后 C 轮交互（默认 20，C<=200）"),
        ("sss in N",
         "Enter session N",
         "进入 N 号会话"),
        ("sss a|audit N",
         "Generate HTML audit report for session N",
         "生成 N 号会话的 HTML 审计报告"),
        ("sss d|del|delete N [y] [force]",
         "Soft-delete to trash, or hard-delete with force",
         "删 N 号会话（默认进回收站，force 真删库）"),
        ("sss trash",
         "List trashed sessions",
         "查看回收站（被标记隐藏的会话）"),
        ("sss restore N|all",
         "Restore trashed session N and enter it, or restore all without entering",
         "恢复 N 号并进入 / 恢复全部不进入"),
        ("sss empty [y] [force]",
         "Permanently delete all trashed sessions",
         "清空回收站（真删全部标记会话，不可恢复）"),
        ("sss h|help",
         "Show this help",
         "显示帮助"),
    ]
    print()
    print(f"{BOLD}Usage: sss [opt] [args...]{RESET}")
    print()
    w = max(_disp_width(s) for s, _, _ in cmds)
    for syn, en, zh in cmds:
        gap = w - _disp_width(syn) + 2
        leader = " " + "-" * (gap - 2) + " "
        print(f"  {syn}{leader}{en}")
        print(f"  {' ' * w}  {zh}")


def truncate(text, max_len=None):
    """按终端显示列宽截断（中文/全角算 2 列），超限补 ...；默认用全局 WIDTH。"""
    if max_len is None:
        max_len = WIDTH
    if _disp_width(text) <= max_len:
        return text
    out, w = [], 0
    for ch in text:
        cw = _char_width(ch)
        if w + cw > max_len - 3:
            break
        out.append(ch)
        w += cw
    return "".join(out) + "..."


def _fetch_sessions(cursor):
    """全量会话，按创建时间正序（早→晚），序号=位置，天然稳定：
    新会话只追加末尾，新消息不 reorder。"""
    cursor.execute("""
        SELECT s.id, s.title, s.time_created, s.time_updated
        FROM session s
        ORDER BY s.time_created ASC, s.id ASC
    """)
    return cursor.fetchall()


TRASH_PATH = os.path.join(os.path.expanduser("~/.config"), "sss", "trash.jsonl")


def load_trash():
    """回收站：{session_id: {id, title, at}}，文件不存在视为空。"""
    items = {}
    try:
        with open(TRASH_PATH, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if isinstance(d, dict) and d.get("id"):
                    items[d["id"]] = d
    except FileNotFoundError:
        pass
    except Exception:
        pass
    return items


def save_trash(items):
    os.makedirs(os.path.dirname(TRASH_PATH), exist_ok=True)
    with open(TRASH_PATH, "w", encoding="utf-8") as f:
        for d in items.values():
            f.write(json.dumps(d, ensure_ascii=False) + "\n")


def mark_deleted(session_id, title):
    """标记删除。已标记返回 False。"""
    items = load_trash()
    if session_id in items:
        return False
    at = datetime.now(timezone(timedelta(hours=8))).strftime("%Y/%m/%d %H:%M:%S")
    items[session_id] = {"id": session_id, "title": title, "at": at}
    save_trash(items)
    return True


def unmark(session_id):
    items = load_trash()
    if session_id in items:
        del items[session_id]
        save_trash(items)


def get_visible_sessions():
    """可见全量（创建时间正序，已踢回收站）。序号=在此表中的位置。"""
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        sessions = _fetch_sessions(conn.cursor())
    finally:
        conn.close()
    trashed = load_trash()
    return [s for s in sessions if s[0] not in trashed]


def _fetch_qa(cursor, session_id, count):
    """只看最近的消息，凑够 count 轮就停，避免全量扫描大会话。"""
    if count <= 0:
        return []
    scan_limit = max(100, count * 20)
    cursor.execute("SELECT id, data FROM message WHERE session_id = ? "
                   "ORDER BY time_created DESC LIMIT ?", (session_id, scan_limit))
    messages = cursor.fetchall()
    if not messages:
        return []
    mids = [m[0] for m in messages]
    # 一次查出所需 part，只取 text/reasoning（tool 输出可达 MB 级，直接在 SQL 层过滤）
    try:
        q = ("SELECT message_id, data FROM part WHERE message_id IN (%s) "
             "AND json_extract(data,'$.type') IN ('text','reasoning') "
             "ORDER BY time_created" % ",".join("?" * len(mids)))
        cursor.execute(q, mids)
    except Exception:
        q = ("SELECT message_id, data FROM part WHERE message_id IN (%s) "
             "ORDER BY time_created" % ",".join("?" * len(mids)))
        cursor.execute(q, mids)
    parts_by_msg = {}
    for mid, pdata in cursor.fetchall():
        try:
            p = json.loads(pdata)
        except Exception:
            continue
        if p.get("type") not in ("text", "reasoning"):
            continue
        t = p.get("text", "")
        if t:
            parts_by_msg.setdefault(mid, []).append(t)
    qa_pairs = []
    current_pair = {}
    for msg_id, msg_data in messages:
        try:
            data = json.loads(msg_data)
        except Exception:
            continue
        role = data.get("role", "unknown")
        content = "\n".join(parts_by_msg.get(msg_id, []))
        if role == "user":
            current_pair["user"] = content
            if "assistant" in current_pair:
                qa_pairs.append(current_pair)
                if len(qa_pairs) >= count:
                    break
                current_pair = {}
        elif role == "assistant":
            # 同一轮可能有多条 assistant 消息（工具调用是独立消息，只有最后一条带 text）：
            # 倒序扫描，新内容是更旧的，拼到前面，空文本跳过不覆盖已有内容
            prev = current_pair.get("assistant", "")
            current_pair["assistant"] = "\n".join(t for t in (content, prev) if t)
    # 收集时是倒序（最新在前），展示翻回时间正序：Q1 A1 Q2 A2
    return list(reversed(qa_pairs[:count]))


def fmt_bytes(n):
    n = n or 0
    if n >= 1024 * 1024:
        return f"{n / 1024 / 1024:.1f}MB"
    return f"{n / 1024:.0f}KB"


def _fetch_stats(cursor, session_ids):
    """批量统计：每会话 Q 数 / A 数 / message+part 总字节 / 最后消息时间。
    两次聚合查询（全走索引），列表不再需要全表 GROUP BY。"""
    stats = {sid: {"q": 0, "a": 0, "bytes": 0, "last": None} for sid in session_ids}
    if not session_ids:
        return stats
    try:
        q = ("SELECT session_id, "
             "SUM(json_extract(data,'$.role')='user'), "
             "SUM(json_extract(data,'$.role')='assistant'), "
             "SUM(LENGTH(data)), MAX(time_created) FROM message "
             "WHERE session_id IN (%s) GROUP BY session_id" % ",".join("?" * len(session_ids)))
        cursor.execute(q, session_ids)
        for sid, nq, na, nb, last in cursor.fetchall():
            if sid in stats:
                stats[sid].update(q=nq or 0, a=na or 0, bytes=nb or 0, last=last)
        q2 = ("SELECT session_id, SUM(LENGTH(data)) FROM part "
              "WHERE session_id IN (%s) GROUP BY session_id" % ",".join("?" * len(session_ids)))
        cursor.execute(q2, session_ids)
        for sid, nb in cursor.fetchall():
            if sid in stats:
                stats[sid]["bytes"] += nb or 0
    except Exception:
        pass
    return stats


def last_access_of(stat, time_updated, time_created):
    last = (stat or {}).get("last")
    return last or time_updated or time_created


def format_time(ts_ms):
    if not ts_ms:
        return "N/A"
    dt = datetime.fromtimestamp(ts_ms / 1000, tz=timezone(timedelta(hours=8)))
    return dt.strftime("%Y/%m/%d %H:%M:%S")


def one_line(text, max_len=None):
    return truncate(" ".join(text.split()), WIDTH if max_len is None else max_len)


def format_session(index, session_id, title, time_created, qa_pairs, last_msg_time, stat=None,
                   show_empty=True):
    lines = [f"{YELLOW}[{index}] {truncate(title, 40)}{RESET} {fmt_sid(session_id)}",
             f"  {YELLOW}{'Created At:':<12} {format_time(time_created)}{RESET}",
             f"  {YELLOW}{'Last Access:':<12} {format_time(last_msg_time)}{RESET}"]
    if stat is not None:
        lines.append(f"  {GRAY}Stats: {stat['q']}Q / {stat['a']}A - {fmt_bytes(stat['bytes'])}{RESET}")
    if not qa_pairs:
        if show_empty:
            lines.append(f"  {GRAY}(no interactions){RESET}")
        return "\n".join(lines)
    for j, pair in enumerate(qa_pairs):
        if "user" in pair and pair["user"]:
            lines.append(f"{RED}[Q]: {one_line(pair['user'])}{RESET}")
        if "assistant" in pair and pair["assistant"]:
            lines.append(f"{GREEN}[A]: {one_line(pair['assistant'])}{RESET}")
    return "\n".join(lines)


def cmd_list(count, interactions):
    # 单连接 + 单读事务：整个列表是同一快照，不受中途写入影响；
    # 先在内存攒完再一次写出，避免终端逐行闪烁/交错。
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        conn.isolation_level = None
        conn.execute("BEGIN")
        cur = conn.cursor()
        sessions = _fetch_sessions(cur)
        trashed = load_trash()
        sessions = [s for s in sessions if s[0] not in trashed]
        total = len(sessions)
        if total == 0:
            conn.execute("COMMIT")
            if trashed:
                sys.stdout.write(f"(no sessions)（回收站有 {len(trashed)} 个被标记会话，sss trash 查看）\n")
            else:
                sys.stdout.write("(no sessions)\n")
            return
        # 只看末尾 count 个（最新创建），但序号用全局位置，保证稳定
        start = max(0, total - count) if count is not None else 0
        stats = _fetch_stats(cur, [s[0] for s in sessions[start:]])
        # 创建正序：早的在上、新的沉底
        blocks = []
        for i in range(start, total):
            session_id, title, time_created, time_updated = sessions[i]
            last = last_access_of(stats.get(session_id), time_updated, time_created)
            try:
                qa_pairs = _fetch_qa(cur, session_id, interactions) if interactions > 0 else []
            except Exception as e:
                blocks.append(f"{YELLOW}[{i}] {truncate(title, 40)}{RESET} {fmt_sid(session_id)}\n"
                              f"  {GRAY}(preview failed: {e}){RESET}")
                continue
            blocks.append(format_session(i, session_id, title, time_created, qa_pairs, last,
                                           stats.get(session_id), interactions > 0))
        conn.execute("COMMIT")
    finally:
        conn.close()
    sys.stdout.write("\n\n".join(blocks) + "\n")


def _fit_lines(text, width, max_lines=50):
    """详情视图用：保留换行、每行按宽度截断，超出行数 cap 并提示。"""
    lines = text.split("\n")
    out = [truncate(ln, width) for ln in lines[:max_lines]]
    if len(lines) > max_lines:
        out.append(f"...（另有 {len(lines) - max_lines} 行未显示）")
    return out


def cmd_show(index, count=20):
    """看某会话最后 count 轮交互（时间正序，最新的沉底），同快照+攒完一次写出。"""
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        conn.isolation_level = None
        conn.execute("BEGIN")
        cur = conn.cursor()
        sessions = _fetch_sessions(cur)
        trashed = load_trash()
        sessions = [s for s in sessions if s[0] not in trashed]
        if not (0 <= index < len(sessions)):
            conn.execute("COMMIT")
            print(f"{RED}Error: index {index} out of range (0-{len(sessions) - 1}){RESET}")
            sys.exit(1)
        session_id, title, time_created, time_updated = sessions[index]
        pairs = _fetch_qa(cur, session_id, count)
        stat = _fetch_stats(cur, [session_id])[session_id]
        last = last_access_of(stat, time_updated, time_created)
        conn.execute("COMMIT")
    finally:
        conn.close()
    blocks = [f"{YELLOW}[{index}] {truncate(title, 40)}{RESET} {fmt_sid(session_id)}",
              f"  {YELLOW}{'Created At:':<12} {format_time(time_created)}{RESET}",
              f"  {YELLOW}{'Last Access:':<12} {format_time(last)}{RESET}",
              f"  {GRAY}Stats: {stat['q']}Q / {stat['a']}A - {fmt_bytes(stat['bytes'])} - 最近 {len(pairs)} 轮{RESET}"]
    for k, pair in enumerate(pairs, 1):
        blocks.append(f"--- {k}/{len(pairs)} ---")
        q = pair.get("user", "")
        blocks.append(f"{RED}[Q]:{RESET}")
        blocks.extend(f"{RED}{ln}{RESET}" if ln else "" for ln in
                      (_fit_lines(q, WIDTH) if q.strip() else [f"{GRAY}(空){RESET}"]))
        a = pair.get("assistant", "")
        blocks.append(f"{GREEN}[A]:{RESET}")
        blocks.extend(f"{GREEN}{ln}{RESET}" if ln else "" for ln in
                      (_fit_lines(a, WIDTH) if a.strip() else [f"{GRAY}(无文本回复){RESET}"]))
    sys.stdout.write("\n".join(blocks) + "\n")


def resolve_session_id(index):
    sessions = get_visible_sessions()
    if not (0 <= index < len(sessions)):
        print(f"{RED}Error: index {index} out of range (0-{len(sessions)-1}){RESET}")
        sys.exit(1)
    return sessions[index][0]


def cmd_enter(index):
    session_id = resolve_session_id(index)
    os.execvp("opencode", ["opencode", "-s", session_id])


def cmd_audit(index):
    sessions = get_visible_sessions()
    if not (0 <= index < len(sessions)):
        print(f"{RED}Error: index {index} out of range (0-{len(sessions)-1}){RESET}")
        sys.exit(1)
    session_id, title = sessions[index][0], sessions[index][1]
    audit_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "opencode_audit.py")
    html_path = os.path.join(os.path.expanduser("~/opencode-audit"), session_id + ".html")
    proc = subprocess.run(
        ["python3", audit_script, "--session", session_id, "--format", "html"],
        capture_output=True)
    if proc.returncode != 0:
        print(f"{RED}审计报告生成失败（退出码 {proc.returncode}）{RESET}")
        if proc.stderr:
            print(proc.stderr.decode("utf-8", "replace"))
        sys.exit(1)
    print(f"{YELLOW}[{index}] {title}{RESET} {fmt_sid(session_id)}")
    print("的审计报告已经成功导出到")
    print(html_path)
    sys.exit(0)


def _attached_pids(session_id):
    """扫描进程表，找 `opencode -s <id>` 这类 attach 持有者。opencode 本身不记 attach（owner_id 全空），只能靠这个。"""
    pids = []
    try:
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    argv = [a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a]
            except Exception:
                continue
            if not argv:
                continue
            if os.path.basename(argv[0]) == "opencode" and session_id in argv[1:]:
                pids.append(int(pid))
    except Exception:
        pass
    return pids


def _last_activity_ms(session_row):
    session_id, title, time_created, time_updated = session_row
    cands = [t for t in (time_updated, time_created) if t]
    return max(cands) if cands else None


def delete_session(session_id):
    """删除会话（外键 ON DELETE CASCADE 连带清 message/part/todo），返回消息条数。"""
    conn = sqlite3.connect(DB_PATH, timeout=30)
    try:
        conn.execute("PRAGMA foreign_keys=ON")
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM message WHERE session_id = ?", (session_id,))
        n_msgs = cursor.fetchone()[0]
        cursor.execute("DELETE FROM session WHERE id = ?", (session_id,))
        conn.commit()
    finally:
        conn.close()
    return n_msgs


def cmd_delete(index, assume_yes, force=False):
    """默认标记删除（进回收站，列表不再显示）；force 才真删库。"""
    sessions = get_visible_sessions()
    if not (0 <= index < len(sessions)):
        print(f"{RED}Error: index {index} out of range (0-{len(sessions)-1}){RESET}")
        sys.exit(1)
    session_id, title = sessions[index][0], sessions[index][1]
    if not force:
        if mark_deleted(session_id, title):
            print(f"{YELLOW}[{index}] {title}{RESET} {fmt_sid(session_id)}")
            print(f"{GREEN}已移入回收站{RESET}（标记删除，数据仍在库中；sss trash 查看，d {index} force 彻底删除）")
        else:
            print(f"{GRAY}已在回收站中。{RESET}")
        return
    # --- 以下为彻底删除（force 已放行 attach 拦截） ---
    # 提醒：N 秒内有写入，或进程表里还有 attach，下面的确认行里带上
    import time as _time
    last = _last_activity_ms(sessions[index])
    age_s = int(_time.time() - last / 1000) if last else None
    hot = age_s is not None and age_s < 120
    pids = _attached_pids(session_id)
    if not assume_yes:
        try:
            hints = []
            if hot:
                hints.append(f"最后写入 {age_s} 秒前，可能正活跃")
            if pids:
                hints.append(f"正被 attach（PID {', '.join(map(str, pids))}）")
            hint = f"（{'；'.join(hints)}）" if hints else ""
            answer = input(f"{RED}彻底删除会话 [{index}] {title} "
                           f"{fmt_sid(session_id)}{RED} ? [y/N] {hint}{RESET}")
        except EOFError:
            answer = ""
        if answer.strip().lower() not in ("y", "yes"):
            print(f"{GRAY}已取消。{RESET}")
            return
    try:
        n_msgs = delete_session(session_id)
    except sqlite3.OperationalError as e:
        print(f"{RED}删除失败（库被占用或超时）: {e}{RESET}")
        sys.exit(1)
    unmark(session_id)
    removed = _remove_audit_html(session_id)
    print(f"{YELLOW}[{index}] {title}{RESET} {fmt_sid(session_id)}")
    print(f"{GREEN}已删除{RESET}（{n_msgs} 条消息）" + ("，并移除审计报告" if removed else ""))


def ordered_trash():
    """回收站按删除时间正序：最早删除的排 [0]，和主列表 0=最旧一致，序号稳定。"""
    return list(load_trash().values())


def cmd_trash():
    """列出回收站：创建时间 / 最后交互 / 删除时间（红），序号按删除倒序。"""
    entries = ordered_trash()
    if not entries:
        print("(回收站为空)")
        return
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        cur = conn.cursor()
        rows = {s[0]: s for s in _fetch_sessions(cur)}
        sids = [d["id"] for d in entries]
        stats = _fetch_stats(cur, sids)
    finally:
        conn.close()
    chunks = [f"{YELLOW}回收站（{len(entries)} 个，按删除时间正序，仅标记隐藏）{RESET}"]
    for i, d in enumerate(entries):
        sid = d["id"]
        row = rows.get(sid)
        title = d.get("title", "") if row is None else row[1]
        chunk = [f"{YELLOW}[{i}] {truncate(title, 40)}{RESET} {fmt_sid(sid)}"]
        if row is None:
            chunk.append(f"  {GRAY}(已不在库中){RESET}")
        else:
            _, _, tc, tu = row
            last = last_access_of(stats.get(sid), tu, tc)
            chunk.append(f"  {YELLOW}{'Created At:':<12} {format_time(tc)}{RESET}")
            chunk.append(f"  {YELLOW}{'Last Access:':<12} {format_time(last)}{RESET}")
        chunk.append(f"  {RED}{'Deleted At:':<12} {d.get('at', 'N/A')}{RESET}")
        chunks.append("\n".join(chunk))
    sys.stdout.write("\n\n".join(chunks) + "\n")


def _remove_audit_html(session_id):
    html_path = os.path.join(os.path.expanduser("~/opencode-audit"), session_id + ".html")
    try:
        if os.path.exists(html_path):
            os.remove(html_path)
            return True
    except OSError:
        pass
    return False


def cmd_restore(arg):
    """restore N：恢复回收站第 N 个并自动进入；restore all：恢复全部，不进入。
    裸 restore 或其他参数一律报错。"""
    entries = ordered_trash()
    if arg == "all":
        if not entries:
            print("(回收站为空，无需恢复)")
            return
        save_trash({})
        print(f"{GREEN}已恢复 {len(entries)} 个会话{RESET}（重新出现在列表中，不进入）")
        return
    if not arg.isdigit():
        print(f"{RED}错误: 用法: sss restore <N>|all{RESET}")
        usage()
        sys.exit(1)
    index = int(arg)
    if not entries or not (0 <= index < len(entries)):
        print(f"{RED}Error: trash index {index} out of range "
              f"(0-{len(entries) - 1}){RESET}" if entries else "(回收站为空)")
        sys.exit(1)
    sid = entries[index]["id"]
    title = entries[index].get("title", "")
    unmark(sid)
    conn = sqlite3.connect(DB_PATH, timeout=5)
    try:
        exists = conn.execute("SELECT COUNT(*) FROM session WHERE id = ?",
                              (sid,)).fetchone()[0]
    finally:
        conn.close()
    if not exists:
        print(f"{RED}会话已不在库中，仅清除标记，不进入。{RESET}")
        sys.exit(1)
    print(f"{GREEN}已恢复并进入 [{index}] {title}{RESET} {fmt_sid(sid)}")
    sys.stdout.flush()
    os.execvp("opencode", ["opencode", "-s", sid])


def cmd_empty(assume_yes, force=False):
    """清空回收站：真删全部被标记会话，不可恢复。"""
    items = load_trash()
    if not items:
        print("(回收站为空，无需清空)")
        return
    ids = list(items.keys())
    attached = {sid: _attached_pids(sid) for sid in ids}
    attached = {s: p for s, p in attached.items() if p}
    if attached and not force:
        print(f"{RED}拒绝清空：以下会话正被 attach：{RESET}")
        for sid, pids in attached.items():
            print(f"  {fmt_sid(sid)}  {truncate(items[sid].get('title', ''), 40)}  "
                  f"(PID {', '.join(map(str, pids))})")
        print(f"{GRAY}先退出这些会话，或加 force 重试。{RESET}")
        sys.exit(1)
    if not assume_yes:
        try:
            answer = input(f"{RED}彻底删除回收站 {len(ids)} 个会话（数据不可恢复）? [y/N] {RESET}")
        except EOFError:
            answer = ""
        if answer.strip().lower() not in ("y", "yes"):
            print(f"{GRAY}已取消。{RESET}")
            return
    ok, n_msgs, fail = 0, 0, []
    done = []
    for sid in ids:
        try:
            n_msgs += delete_session(sid)
        except sqlite3.OperationalError as e:
            fail.append((sid, str(e)))
            continue
        _remove_audit_html(sid)
        done.append(sid)
        ok += 1
    if done:
        remain = load_trash()
        for sid in done:
            remain.pop(sid, None)
        save_trash(remain)
    print(f"{GREEN}已清空回收站{RESET}（彻底删除 {ok} 个会话，{n_msgs} 条消息）" +
          (f"，失败 {len(fail)} 个" if fail else ""))
    for sid, err in fail:
        print(f"  {RED}{sid}: {err}{RESET}")


def _need_index(args, pos, what):
    if len(args) <= pos or not args[pos].isdigit():
        print(f"{RED}错误: 用法: {what}{RESET}")
        usage()
        sys.exit(1)
    try:
        return int(args[pos])
    except ValueError:
        print(f"{RED}错误: 用法: {what}{RESET}")
        usage()
        sys.exit(1)


def _need_exact_index(args, what):
    """恰好一个数字参数，多余的一律报错（sss in 5 blah 这种不再静默吞掉）。"""
    if len(args) != 2:
        print(f"{RED}错误: 用法: {what}{RESET}")
        usage()
        sys.exit(1)
    return _need_index(args, 1, what)


def _cmd_view(rest):
    if len(rest) == 1 and rest[0].isdigit():
        cmd_show(int(rest[0]), 20)
    elif (len(rest) == 2 and rest[0].isdigit() and rest[1].isdigit()
            and 1 <= int(rest[1]) <= 200):
        cmd_show(int(rest[0]), int(rest[1]))
    else:
        print(f"{RED}错误: 用法: sss v <N> [C<=200]{RESET}")
        usage()
        sys.exit(1)


def main():
    args = sys.argv[1:]
    if not args:
        cmd_list(10, 5)
        return
    # 第一道门：位置化白名单。首参数必须是纯字母动词（opt），
    # 数字只允许出现在它所属 opt 的参数位；其他字符一律拒收。
    cmd, rest = args[0], args[1:]
    if cmd.isdigit():
        print(f"{RED}错误: 看会话请用 sss v {cmd}（首参数只接受动词，用 sss h 查看）{RESET}")
        usage()
        sys.exit(1)
    if not (cmd.isascii() and cmd.isalpha()):
        print(f"{RED}错误: 首参数只接受动词: {cmd}{RESET}")
        usage()
        sys.exit(1)
    for a in rest:
        if not (a.isascii() and a.isalnum()):
            print(f"{RED}错误: sss 只接受字母/数字参数: {a}{RESET}")
            usage()
            sys.exit(1)
    if cmd == "in":
        cmd_enter(_need_exact_index(args, "sss in <N>"))
    elif cmd in ("t", "title"):
        if rest:
            print(f"{RED}错误: 用法: sss t{RESET}")
            usage()
            sys.exit(1)
        cmd_list(None, 0)
    elif cmd in ("setw", "setwidth"):
        if not rest:
            print(f"当前截断宽度: {WIDTH}（配置: {CONFIG_PATH}，环境变量 SSS_WIDTH 可临时覆盖）")
        elif len(rest) == 1 and rest[0].isdigit() and 20 <= int(rest[0]) <= 500:
            save_width(int(rest[0]))
            print(f"截断宽度已设为 {rest[0]}，后续 sss 生效")
        else:
            print(f"{RED}错误: 用法: sss setw [20..500]{RESET}")
            usage()
            sys.exit(1)
    elif cmd in ("a", "audit"):
        cmd_audit(_need_exact_index(args, "sss a <N>"))
    elif cmd in ("d", "del", "delete"):
        index = _need_index(args, 1, "sss d <N> [y] [force]")
        known = ("y", "yes", "force")
        if any(t not in known for t in rest[1:]):
            print(f"{RED}错误: 用法: sss d <N> [y] [force]{RESET}")
            usage()
            sys.exit(1)
        assume_yes = any(a in ("y", "yes") for a in rest[1:])
        force = any(a == "force" for a in rest[1:])
        cmd_delete(index, assume_yes, force)
    elif cmd == "trash":
        if rest:
            print(f"{RED}错误: 用法: sss trash{RESET}")
            usage()
            sys.exit(1)
        cmd_trash()
    elif cmd == "restore":
        if len(rest) != 1:
            print(f"{RED}错误: 用法: sss restore <N>|all{RESET}")
            usage()
            sys.exit(1)
        cmd_restore(rest[0])
    elif cmd == "empty":
        known = ("y", "yes", "force")
        if any(t not in known for t in rest):
            print(f"{RED}错误: 用法: sss empty [y] [force]{RESET}")
            usage()
            sys.exit(1)
        cmd_empty(any(a in ("y", "yes") for a in rest),
                  any(a == "force" for a in rest))
    elif cmd in ("h", "help"):
        if rest:
            print(f"{RED}错误: 用法: sss h{RESET}")
            usage()
            sys.exit(1)
        usage()
        return
    elif cmd in ("v", "view"):
        _cmd_view(rest)
    else:
        print(f"{RED}错误: 无法识别的动词: {cmd}，用 sss h 查看{RESET}")
        usage()
        sys.exit(1)


if __name__ == "__main__":
    main()
