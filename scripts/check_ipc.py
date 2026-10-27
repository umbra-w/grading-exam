#!/usr/bin/env python3
"""
IPC 契约对账 —— 契约声明的通道与主进程实际注册的 handler 必须严格一一对应。

为什么要有这个脚本（而不是每次手打内联 Python）：
  1. 内联写法要在 PowerShell 里转义引号，实测每次都写错，浪费好几轮；
  2. 这类检查的价值在于**每次都跑**。一个需要费力才能跑起来的检查，
     最终就会被跳过——而被跳过的检查等于不存在。

AGENTS.md §4.1：契约里不允许存在没有实现的通道，也不允许存在未进契约的实现。
历史上 `io:exportExcel` / `io:exportMarkdown` / `io:parseFile` 就曾在契约里
声明但从未实现，渲染层一调就运行时炸。

用法：
    python scripts/check_ipc.py            # 只看命令通道
    python scripts/check_ipc.py --events   # 同时检查事件通道与 preload 订阅
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
MAIN = ROOT / "src" / "main" / "main.ts"
MAIN_DIR = ROOT / "src" / "main"
TYPES = ROOT / "src" / "shared" / "types.ts"
PRELOAD = ROOT / "src" / "preload" / "index.ts"


def handled_channels() -> dict[str, str]:
    """扫 src/main 下所有 ipcMain.handle，返回 通道名 -> 所在文件（相对路径）。"""
    found: dict[str, str] = {}
    pattern = re.compile(r"""ipcMain\.handle\(\s*['"]([^'"]+)['"]""", re.S)
    for path in sorted(MAIN_DIR.rglob("*.ts")):
        text = path.read_text(encoding="utf-8", errors="replace")
        for m in pattern.finditer(text):
            found[m.group(1)] = str(path.relative_to(ROOT)).replace("\\", "/")

    # 形如 for (const channel of ['auto:start', ...] as const) 的批量注册
    bulk = re.compile(r"for \(const channel of \[([^\]]+)\] as const\)", re.S)
    for path in sorted(MAIN_DIR.rglob("*.ts")):
        text = path.read_text(encoding="utf-8", errors="replace")
        for m in bulk.finditer(text):
            for raw in m.group(1).split(","):
                name = raw.strip().strip("'\"")
                if name:
                    found.setdefault(name, str(path.relative_to(ROOT)).replace("\\", "/"))
    return found


def declared_channels() -> set[str]:
    """从 types.ts 的 IPC 接口里取所有 `'通道名':` 形式的声明。"""
    text = TYPES.read_text(encoding="utf-8", errors="replace")
    return set(re.findall(r"""^\s*['"]([a-z][a-zA-Z]*:[A-Za-z]+)['"]\s*:""", text, re.M))


def preload_events() -> set[str]:
    """preload 里 ipcRenderer.on('evt:...') 的订阅集合。"""
    text = PRELOAD.read_text(encoding="utf-8", errors="replace")
    return set(re.findall(r"""ipcRenderer\.on\(\s*['"](evt:[^'"]+)['"]""", text))


# 已声明但**尚未发送**的事件白名单：事件名 -> 它依赖的阶段。
#
# 为什么需要白名单而不是直接删掉这两个声明：
#   `evt:progress`（连续阅卷进度）与 `evt:awaitConfirm`（稳健模式等待人工确认）
#   是 Phase 5 连续阅卷状态机的对外接口，设计意图明确、契约已定。
#   删掉会让设计意图散失；直接留着又会让下一个"声明了却从不发送"的
#   幻影事件混进来——那正是本轮修掉的一类缺陷（evt:browserClosed）。
#
# 所以用白名单把"有意为之的未实现"与"忘了接的实现"区分开：
#   在白名单里 → 提示（不算问题），并说明依赖哪个阶段
#   不在白名单 → 判失败，必须接上或显式加入本表
PLANNED_UNSENT: dict[str, str] = {
    "evt:progress": "Phase 5 连续阅卷状态机尚未实现",
    "evt:awaitConfirm": "Phase 5 稳健模式的等待确认流程尚未实现",
}


def main() -> int:
    ap = argparse.ArgumentParser(description="IPC 契约对账")
    ap.add_argument("--events", action="store_true", help="同时检查事件通道与 preload 订阅")
    args = ap.parse_args()

    implemented = handled_channels()
    implemented_names = set(implemented)
    declared = declared_channels()

    commands = {c for c in declared if not c.startswith("evt:")}
    events = {c for c in declared if c.startswith("evt:")}

    problems: list[str] = []

    print("=" * 64)
    print(f"命令通道   契约 {len(commands)} / 实现 {len(implemented_names & commands)}")
    not_implemented = sorted(commands - implemented_names)
    not_declared = sorted(implemented_names - commands)
    if not_implemented:
        print("  ✗ 契约里有但没实现：")
        for c in not_implemented:
            print(f"      {c}")
        problems.append(f"{len(not_implemented)} 个通道在契约里但没实现")
    else:
        print("  ✓ 全部已实现")
    if not_declared:
        print("  ✗ 实现了但没进契约：")
        for c in not_declared:
            print(f"      {c}  ← {implemented[c]}")
        problems.append(f"{len(not_declared)} 个通道实现了但没进契约")
    else:
        print("  ✓ 实现在契约内（无越界通道）")

    if args.events:
        subscribed = preload_events()
        print()
        print(f"事件通道   契约 {len(events)} / preload 订阅 {len(events & subscribed)}")
        unsub = sorted(events - subscribed)
        if unsub:
            print("  ✗ 契约里有但 preload 没订阅：")
            for e in unsub:
                print(f"      {e}")
            problems.append(f"{len(unsub)} 个事件无人订阅")
        else:
            print("  ✓ 全部已订阅")

        # 事件必须真的被 send 出去。声明了、订阅了、但主进程从不发送，
        # 是最隐蔽的一种"契约里有但不生效"——本轮就修过一个（evt:browserClosed）。
        sent: set[str] = set()
        send_pat = re.compile(r"""webContents\.send\(\s*['"](evt:[^'"]+)['"]""")
        for path in sorted(MAIN_DIR.rglob("*.ts")):
            sent |= set(send_pat.findall(path.read_text(encoding="utf-8", errors="replace")))
        never_sent = sorted(events - sent)
        print()
        print(f"事件发送   主进程实际 send 了 {len(sent & events)} 个")
        if never_sent:
            planned = [e for e in never_sent if e in PLANNED_UNSENT]
            forgotten = [e for e in never_sent if e not in PLANNED_UNSENT]
            for e in planned:
                print(f"  · {e}  —— 已知未发送：{PLANNED_UNSENT[e]}")
            if forgotten:
                print("  ✗ 声明了但主进程从不发送（且不在已知未发送清单里）：")
                for e in forgotten:
                    print(f"      {e}")
                problems.append(
                    f"{len(forgotten)} 个事件声明了却从不发送：{', '.join(forgotten)}。"
                    f"要么接上发送方，要么加进 check_ipc.py 的 PLANNED_UNSENT 并写明依赖"
                )
            if planned and not forgotten:
                print(f"  ✓ 其余 {len(events) - len(planned)} 个事件都已接上发送方")
        else:
            print("  ✓ 声明的事件都真的会被发送")

    print("=" * 64)
    if problems:
        print(f"发现 {len(problems)} 个问题：")
        for p in problems:
            print(f"  · {p}")
        return 1
    print("契约与实现完全对齐。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())