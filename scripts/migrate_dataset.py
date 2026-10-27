#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
按 CONTRACT.md §5 修订标注 CSV —— 一次性迁移脚本，可复算。

为什么用脚本而不是手改：
  1. CSV 内含引号与逗号，手改容易破坏格式；
  2. 修订依据是冻结的 CONTRACT.md，脚本能把"改了什么"写进日志，便于审计；
  3. 若日后有第二批标注文件，同一脚本可直接复用。

修订内容（严格对应 CONTRACT.md §5）：
  - qtype 去"题"字：计算题→计算、简答题→简答、论述题→论述
  - 补上被遗漏的 status 列（见下）
  - MATH-CALC-0001：|A−B|=0.5 不大于阈值 1.0 ⇒ 本不应触发仲裁
      · score_arbitrated 清空
      · arbitration_reason 清空（但**内容不丢弃**，转记入 notes）

设计原则：**不为了让校验器变绿而删除真实数据**。仲裁争议是真实信息，
只是放错了字段——移到 notes 保留。

## 关于 status 列（原文件的真实缺陷）

原文件表头 19 列，但第 2~5 行的数据实为 20 个字段，末尾多出 `待标注`。
这不是笔误：字典读取时它是 restkey，**被静默丢弃**。含义明确是标注状态，
且第 1 行（已标注）恰好没有该字段——即"已标注则不写状态"。

处置：把 status 提升为显式列并写进表头，值域 `待标注` / `已标注` / 空。
好处是标注进度可直接统计，不必靠"答案是否为空"反推。
**注意**：CONTRACT.md §3 需同步增加此可选字段的定义。

用法：
  python scripts/migrate_dataset.py --dry-run    # 预览
  python scripts/migrate_dataset.py --apply      # 实际写入（先备份）
"""
from __future__ import annotations

import argparse
import csv
import io
import shutil
import sys
from pathlib import Path

for _s in ("stdout", "stderr"):
    _stream = getattr(sys, _s, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass

# CONTRACT.md §2.1 冻结枚举
QTYPE_MAP = {
    "选择题": "选择", "判断题": "判断", "填空题": "填空",
    "简答题": "简答", "计算题": "计算", "论述题": "论述",
}

# 因阈值语义更正而需清空仲裁字段的样本（CONTRACT.md §4.1 / §5）
CLEAR_ARBITRATION = {"MATH-CALC-0001"}

NOTES_APPEND = "；单位分争议需教师复核（|A−B|=0.5 未触发仲裁，原仲裁理由见下）"
NOTES_MARKER = "单位分争议需教师复核"

STATUS_COL = "status"
STATUS_VALUES = {"待标注", "已标注", ""}


def load_rows(path: Path) -> tuple[list[str], list[dict], list[int]]:
    """
    读取 CSV，并把超出表头的多余字段收集起来。
    返回 (表头, 行字典, 有多余字段的行号)。
    """
    text = path.read_bytes().decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text))
    raw_rows = list(reader)
    if not raw_rows:
        raise ValueError("CSV 为空")

    header = raw_rows[0]
    data: list[dict] = []
    stray_rows: list[int] = []

    for idx, r in enumerate(raw_rows[1:], start=2):
        if len(r) > len(header):
            stray_rows.append(idx)
        d = {header[i]: (r[i] if i < len(r) else "") for i in range(len(header))}
        # 超出部分按位置收进 extras，由调用方决定怎么用
        d["__extras__"] = r[len(header):]
        data.append(d)

    return header, data, stray_rows


def transform(rows: list[dict], header: list[str]) -> tuple[list[dict], list[str], bool]:
    log: list[str] = []
    needs_status_col = False

    for r in rows:
        sid = r.get("sample_id", "")

        # --- 0) 处理超出的 status 列 ---
        extras = r.pop("__extras__", []) or []
        if extras:
            # 原文件这一列只在待标注行出现，值恒为"待标注"
            value = (extras[0] or "").strip()
            if STATUS_COL in r and r.get(STATUS_COL):
                log.append(f"{sid}: status 已存在（{r[STATUS_COL]}），忽略多余字段 {value!r}")
            elif value:
                if value not in STATUS_VALUES:
                    log.append(f"{sid}: status 值异常 {value!r}（不在 {sorted(STATUS_VALUES)} 内），仍照录")
                    needs_status_col = True
                r[STATUS_COL] = value
                needs_status_col = True
                log.append(f"{sid}: 补录 status={value!r}（原为表头外的多余字段）")
            for i, extra in enumerate(extras[1:], start=1):
                if (extra or "").strip():
                    log.append(f"{sid}: ⚠ 第 {len(header) + 1 + i} 个多余字段 {extra!r} 无对应表头，已保留在 status_extra 供人工核对")
                    r[f"status_extra_{i}"] = extra

        # --- 1) qtype 归一化 ---
        old_q = (r.get("qtype") or "").strip()
        if old_q in QTYPE_MAP:
            r["qtype"] = QTYPE_MAP[old_q]
            log.append(f"{sid}: qtype {old_q} → {r['qtype']}")
        elif old_q:
            log.append(f"{sid}: qtype {old_q} 已是契约值，未改动")

        # --- 2) 清空不合法的仲裁字段，内容转记 notes ---
        if sid in CLEAR_ARBITRATION:
            arb = (r.get("score_arbitrated") or "").strip()
            reason = (r.get("arbitration_reason") or "").strip()
            if arb or reason:
                notes = (r.get("notes") or "").strip()
                if NOTES_MARKER not in notes:
                    extra = NOTES_APPEND
                    if reason:
                        extra += f"（原文：{reason}）"
                    notes = f"{notes}{extra}" if notes else extra.lstrip("；")
                    r["notes"] = notes
                    log.append(f"{sid}: 仲裁理由转记 notes")
                r["score_arbitrated"] = ""
                r["arbitration_reason"] = ""
                log.append(f"{sid}: score_arbitrated ({arb or '空'}) 与 arbitration_reason 已清空")

    return rows, log, needs_status_col


def main() -> int:
    ap = argparse.ArgumentParser(description="按 CONTRACT.md §5 修订标注 CSV")
    ap.add_argument("csv", nargs="?", default=None, help="目标 CSV 路径")
    ap.add_argument("--apply", action="store_true", help="实际写入（默认仅预览）")
    ap.add_argument("--dry-run", action="store_true", help="仅预览")
    args = ap.parse_args()

    if args.csv:
        path = Path(args.csv)
    else:
        path = Path(__file__).resolve().parent.parent.parent / "Grading_exam_research" / "标注模板_测试集.csv"

    if not path.exists():
        print(f"[FATAL] 找不到文件: {path}", file=sys.stderr)
        return 2

    header, rows, stray = load_rows(path)
    had_bom = path.read_bytes()[:3] == b"\xef\xbb\xbf"

    print(f"文件: {path}")
    print(f"BOM: {had_bom} | 数据行: {len(rows)} | 表头列数: {len(header)}")
    if stray:
        print(f"[INFO] 第 {stray} 行的字段数超过表头——这不是笔误，是缺了一列表头，"
              f"现将该列提升为显式 `status`。")
    print()

    rows, log, needs_status_col = transform(rows, header)

    print("--- 修订明细 ---")
    for line in log:
        print(f"  {line}")
    print(f"  （共 {len(log)} 项）")
    print()

    if needs_status_col and STATUS_COL not in header:
        header = header + [STATUS_COL]
        print(f"表头新增列: {STATUS_COL}（列数 {len(header)}）")
        print()

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=header, lineterminator="\n",
                            quoting=csv.QUOTE_MINIMAL, extrasaction="ignore")
    writer.writeheader()
    for r in rows:
        writer.writerow(r)
    out = buf.getvalue()

    # 回读自检：确认写出后可被正确解析，且行数/列数一致，无静默丢字段
    check = list(csv.DictReader(io.StringIO(out)))
    assert len(check) == len(rows), f"回读行数不符: {len(check)} != {len(rows)}"
    for c in check:
        assert None not in c, f"回读仍有多余字段（未加表头）: {c.get(None)}"
    print(f"回读自检: {len(check)} 行 × {len(check[0])} 列，无多余字段 ✓")
    print()

    print("--- 修订后（关键列）---")
    for r in rows:
        print(f"  {r['sample_id']:<18} qtype={r['qtype']:<3} "
              f"full={r['full_score'] or '(空)':<4} "
              f"arb={r['score_arbitrated'] or '(空)':<4} "
              f"status={r.get(STATUS_COL) or '(空)':<5} "
              f"notes={(r['notes'] or '')[:30]}")
    print()

    if args.apply and not args.dry_run:
        backup = path.with_suffix(path.suffix + ".bak")
        if not backup.exists():
            shutil.copy2(path, backup)
            print(f"已备份原文件 → {backup.name}")
        else:
            print(f"备份已存在，保留不覆盖 → {backup.name}")
        path.write_text(out, encoding="utf-8", newline="")
        print(f"已写入 {path}")
        print()
        print("下一步：python scripts/validate_dataset.py")
        print("提醒：CONTRACT.md §3 需补充 status 可选字段定义，否则校验器不认识它。")
    else:
        print("（预览模式，未写入。加 --apply 实际生效）")

    return 0


if __name__ == "__main__":
    sys.exit(main())