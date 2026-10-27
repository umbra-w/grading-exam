#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
冻结登记工具 —— 对应 PLAN v2.0 §3 E1-2 / E1-3，调研报告 §5.5

作用：把 rubric、提示词、数据契约的 SHA256 写进 freeze_manifest.json，
      使"冻结"这件事可复算、可审计。

为什么需要它：调研 §5.5 第 3 条要求——冻结后任何修改视为新一轮实验，
历史结果作废、不得合并统计。没有哈希就无法证明"跑这批数据时用的是哪一版"。

用法：
  python freeze.py --contract                     # 冻结数据契约
  python freeze.py --rubric <rubric文件或目录>      # 冻结 rubric
  python freeze.py --prompt <提示词文件或目录>      # 冻结提示词模板
  python freeze.py --show                         # 查看当前清单
  python freeze.py --verify                       # 校验现有文件是否与清单一致

注意：冻结是**单向操作**。--verify 只报告不一致，不会自动更新哈希；
      要重新冻结必须显式传入对应的 --contract/--rubric/--prompt。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

for _s in ("stdout", "stderr"):
    _stream = getattr(sys, _s, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "freeze_manifest.json"

CST = timezone(timedelta(hours=8))


def now_iso() -> str:
    return datetime.now(CST).isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_manifest() -> dict:
    if MANIFEST.exists():
        return json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {
        "schema": 1,
        "created": now_iso(),
        "contract": None,
        "rubric": None,
        "prompt": None,
        "notes": [],
    }


def save_manifest(m: dict) -> None:
    m["updated"] = now_iso()
    MANIFEST.write_text(json.dumps(m, ensure_ascii=False, indent=2), encoding="utf-8")


def collect_hash(section: str, target: Path) -> dict:
    """
    对单个文件或目录计算哈希。
    目录：按相对路径排序后逐个哈希，并用 'path\\0hash' 拼接再哈希，
          这样文件增删改都会改变最终值，且与遍历顺序无关。
    """
    if not target.exists():
        print(f"[FATAL] 路径不存在: {target}", file=sys.stderr)
        sys.exit(2)

    if target.is_file():
        return {
            "kind": "file",
            "path": str(target.relative_to(ROOT)) if ROOT in target.parents or target.parent == ROOT else str(target),
            "sha256": sha256_file(target),
            "bytes": target.stat().st_size,
            "frozen_at": now_iso(),
        }

    entries: list[tuple[str, str, int]] = []
    for p in sorted(target.rglob("*")):
        if not p.is_file():
            continue
        if any(part in {"node_modules", "__pycache__", ".git"} for part in p.parts):
            continue
        entries.append((str(p.relative_to(target)).replace("\\", "/"), sha256_file(p), p.stat().st_size))

    if not entries:
        print(f"[FATAL] 目录内无文件: {target}", file=sys.stderr)
        sys.exit(2)

    combined = sha256_text("\0".join(f"{n}\0{h}" for n, h, _ in entries))
    return {
        "kind": "dir",
        "path": str(target),
        "sha256": combined,
        "files": [{"name": n, "sha256": h, "bytes": b} for n, h, b in entries],
        "file_count": len(entries),
        "frozen_at": now_iso(),
    }


def cmd_freeze_contract() -> None:
    target = ROOT / "CONTRACT.md"
    m = load_manifest()
    m["contract"] = collect_hash("contract", target)
    m["contract"]["version"] = "contract_v1"
    m["contract"]["decisions"] = {
        "C1": "采纳契约枚举 选择/判断/填空/简答/计算/论述",
        "C2": "full_score 条件必填（有标注则必有）",
        "C3": "严格 > 阈值，且按题型粒度分层（填空 0.5，其余 1.0）",
    }
    save_manifest(m)
    print(f"已冻结契约: {target.name}")
    print(f"  sha256 = {m['contract']['sha256']}")
    print(f"  写入 {MANIFEST.name}")


def cmd_freeze(section: str, target: Path) -> None:
    m = load_manifest()
    m[section] = collect_hash(section, target)
    save_manifest(m)
    info = m[section]
    print(f"已冻结 {section}: {info['path']}")
    print(f"  sha256 = {info['sha256']}")
    if info["kind"] == "dir":
        print(f"  文件数 = {info['file_count']}")
    print(f"  写入 {MANIFEST.name}")


def cmd_show() -> None:
    m = load_manifest()
    print("=" * 70)
    print("冻结清单 freeze_manifest.json")
    print("=" * 70)
    for section in ("contract", "rubric", "prompt"):
        info = m.get(section)
        if not info:
            print(f"{section:10} <未冻结>")
            continue
        ver = f" ({info.get('version')})" if info.get("version") else ""
        print(f"{section:10} {info['sha256'][:16]}…{ver}")
        print(f"{'':10} {info['path']}")
    if m.get("notes"):
        print("\n备注:")
        for n in m["notes"]:
            print(f"  - {n}")
    print("=" * 70)

    if not m.get("prompt") or not m.get("rubric"):
        print("")
        print("提示：prompt 与 rubric 尚未冻结。按 PLAN v2.0 §3 E1，")
        print("      二者齐备（M0 里程碑）之前不得进入 E3 实测。")


def cmd_verify() -> int:
    """校验现有文件是否仍与清单一致。只报告，不自动更新。"""
    m = load_manifest()
    problems = 0
    for section in ("contract", "rubric", "prompt"):
        info = m.get(section)
        if not info:
            print(f"{section:10} —  未冻结，跳过")
            continue
        path = Path(info["path"])
        if not path.is_absolute():
            path = ROOT / path
        if not path.exists():
            print(f"{section:10} ✗  路径已不存在: {path}")
            problems += 1
            continue
        cur = collect_hash(section, path)
        if cur["sha256"] == info["sha256"]:
            print(f"{section:10} ✓  一致  {info['sha256'][:16]}…")
        else:
            print(f"{section:10} ✗  已变更！")
            print(f"{'':10}   冻结值 {info['sha256']}")
            print(f"{'':10}   当前值 {cur['sha256']}")
            problems += 1

    print("")
    if problems:
        print(f"发现 {problems} 处不一致。按调研 §5.5，冻结后修改视为新一轮实验，")
        print("此前基于旧版本产生的实测结果作废，不得与新结果合并统计。")
        return 1
    print("全部与清单一致。")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="冻结登记工具")
    ap.add_argument("--contract", action="store_true", help="冻结数据契约 CONTRACT.md")
    ap.add_argument("--rubric", type=str, help="冻结 rubric（文件或目录）")
    ap.add_argument("--prompt", type=str, help="冻结提示词模板（文件或目录）")
    ap.add_argument("--show", action="store_true", help="查看清单")
    ap.add_argument("--verify", action="store_true", help="校验一致性")
    args = ap.parse_args()

    acted = False
    if args.contract:
        cmd_freeze_contract()
        acted = True
    if args.rubric:
        cmd_freeze("rubric", Path(args.rubric))
        acted = True
    if args.prompt:
        cmd_freeze("prompt", Path(args.prompt))
        acted = True

    if args.verify:
        return cmd_verify()
    if args.show or not acted:
        cmd_show()
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(main())