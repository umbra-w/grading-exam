#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
标注数据集校验器 —— 对应 PLAN v2.0 §5.2 / 调研报告 §5.4 §5.6

用途：
  1. 结构校验：列名、枚举值、必填字段
  2. 算术一致性：full_score、score_teacher_a/b、score_arbitrated
  3. 逻辑一致性：仲裁规则（|a-b| > 阈值 才应仲裁）
  4. 标注完成度：报出待标注行，供排期

用法：
  python validate_dataset.py <标注表.csv> [--json]

退出码：
  0 = 无错误（警告不算）
  1 = 存在错误
  2 = 文件无法读取

注意：本脚本只读，不修改任何文件。
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Windows 控制台默认 GBK，中文与符号会 UnicodeEncodeError。
# 强制 stdout/stderr 走 UTF-8；旧版 Python 无 reconfigure 时降级为替换模式。
for _stream_name in ("stdout", "stderr"):
    _stream = getattr(sys, _stream_name, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass

# ----------------------------------------------------------------- 契约

REQUIRED_COLUMNS = [
    "sample_id",
    "source_file",
    "page_no",
    "image_raw",
    "image_derived",
    "quality_layer",
    "subject",
    "qtype",
    "question_no_gt",
    "student_name_gt",
    "student_id_gt",
    "answer_gt",
    "rubric",
    "full_score",
    "score_teacher_a",
    "score_teacher_b",
    "score_arbitrated",
    "arbitration_reason",
    "notes",
]

# 契约内的**可选**列：允许存在，不算「契约外的列」
# status：标注进度。原标注模板把「待标注」写在表头之外（第 20 列），
#         被 DictReader 当 restkey 静默丢弃；migrate_dataset.py 已将其提升为显式列。
OPTIONAL_COLUMNS = [
    "status",
]

# 必填（调研 §5.4「必填=是」），但标注允许留空的字段单列
ALWAYS_REQUIRED = [
    "sample_id",
    "image_raw",
    "quality_layer",
    "subject",
    "qtype",
    "question_no_gt",
]

# 待标注阶段允许为空，完成后必须补齐
# 注：full_score 虽在 §5.4 标记必填，但实测标注模板中待标注行同样为空
# （与 answer_gt/rubric 同批录入），故归入本组而非 ALWAYS_REQUIRED。
ANNOTATION_FIELDS = [
    "answer_gt",
    "rubric",
    "full_score",
    "score_teacher_a",
    "score_teacher_b",
]

QUALITY_LAYERS = {"L1", "L2", "L3", "L4", "L5", "L6", "L7"}
SUBJECTS = {"语文", "数学", "英语", "历史"}
QTYPES = {"选择", "判断", "填空", "简答", "计算", "论述"}

# 客观题：本地归一化精确比对，零 token。主观题：需双评。
OBJECTIVE_TYPES = {"选择", "判断", "填空"}
SUBJECTIVE_TYPES = {"简答", "计算", "论述"}

# 0.5 分粒度题型的仲裁阈值应收紧（调研 §5.6 末条）
HALF_POINT_TYPES = {"填空"}

# status 列取值（见 CONTRACT.md §3）
PENDING_STATUS = {"待标注", "待处理", "pending"}
ANNOTATED_STATUS = {"已标注", "已完成", "done"}


@dataclass
class Issue:
    level: str  # error | warn
    sample_id: str
    field: str
    message: str


@dataclass
class Result:
    path: str
    total_rows: int = 0
    issues: list[Issue] = field(default_factory=list)
    pending_rows: list[str] = field(default_factory=list)
    stat: dict = field(default_factory=dict)

    @property
    def errors(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "error"]

    @property
    def warns(self) -> list[Issue]:
        return [i for i in self.issues if i.level == "warn"]

    def add(self, level: str, sid: str, fld: str, msg: str) -> None:
        self.issues.append(Issue(level, sid, fld, msg))


# ----------------------------------------------------------------- 解析


def _num(raw: str) -> float | None:
    """空 → None；不可解析 → 抛 ValueError"""
    s = (raw or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        raise ValueError(f"不是合法数字: {raw!r}") from None


def arbitration_threshold(qtype: str) -> float:
    """仲裁阈值：0.5 分粒度题型为 0.5，其余为 1（调研 §5.6）"""
    return 0.5 if qtype in HALF_POINT_TYPES else 1.0


def validate(path: Path) -> Result:
    res = Result(path=str(path))

    try:
        raw = path.read_bytes()
    except OSError as exc:
        print(f"[FATAL] 无法读取 {path}: {exc}", file=sys.stderr)
        sys.exit(2)

    # 容忍 UTF-8 BOM（本项目的 CSV 带 BOM）
    text = raw.decode("utf-8-sig")
    reader = csv.DictReader(text.splitlines())
    header = reader.fieldnames or []

    # 1) 列名校验
    missing = [c for c in REQUIRED_COLUMNS if c not in header]
    unknown = [c for c in header if c not in REQUIRED_COLUMNS and c not in OPTIONAL_COLUMNS]
    if missing:
        res.add("error", "<表头>", "columns", f"缺少必需列: {missing}")
    if unknown:
        res.add("warn", "<表头>", "columns", f"存在契约外的列: {unknown}")

    if missing:
        return res  # 列都不全，逐行校验无意义

    seen_ids: dict[str, int] = {}

    for lineno, row in enumerate(reader, start=2):  # 表头占第 1 行
        res.total_rows += 1
        sid = (row.get("sample_id") or f"<第{lineno}行>").strip()

        # 2) 必填
        for fld in ALWAYS_REQUIRED:
            if not (row.get(fld) or "").strip():
                res.add("error", sid, fld, "必填字段为空")

        # 3) 枚举
        ql = (row.get("quality_layer") or "").strip()
        if ql and ql not in QUALITY_LAYERS:
            res.add("error", sid, "quality_layer", f"非法值 {ql!r}，应为 L1~L7")
        subj = (row.get("subject") or "").strip()
        if subj and subj not in SUBJECTS:
            res.add("error", sid, "subject", f"非法值 {subj!r}，应为 {sorted(SUBJECTS)}")
        qtype = (row.get("qtype") or "").strip()
        if qtype and qtype not in QTYPES:
            # 常见写法冲突：「计算题」vs 契约值「计算」
            canon = qtype[:-1] if qtype.endswith("题") else None
            if canon in QTYPES:
                res.add(
                    "error", sid, "qtype",
                    f"非法值 {qtype!r}：契约值为 {canon!r}（调研 §5.4 枚举），"
                    f"请统一为 {canon!r} 或同步修订契约",
                )
            else:
                res.add("error", sid, "qtype", f"非法值 {qtype!r}，应为 {sorted(QTYPES)}")

        # 4) 主键唯一
        if sid in seen_ids:
            res.add("error", sid, "sample_id", f"与第 {seen_ids[sid]} 行重复")
        else:
            seen_ids[sid] = lineno

        # 5) 数字字段
        nums: dict[str, float | None] = {}
        for fld in ("full_score", "score_teacher_a", "score_teacher_b", "score_arbitrated"):
            try:
                nums[fld] = _num(row.get(fld, ""))
            except ValueError as exc:
                res.add("error", sid, fld, str(exc))
                nums[fld] = None

        full = nums["full_score"]
        a, b, arb = nums["score_teacher_a"], nums["score_teacher_b"], nums["score_arbitrated"]

        # 已开始标注的行必须给出满分
        #
        # 判定依据的演进：
        #   旧版用「任一标注字段非空」反推，但 score_teacher_a 列在待标注行里
        #   被当成题目**总分占位**填了（恒等于 full 列，如 6/10/8/15），
        #   于是 4 条待标注行被误判为「已开始标注」。
        #   现以显式 status 列为准；仅当该列为空时才回退到启发式。
        status = (row.get("status") or "").strip()
        explicit_pending = status in PENDING_STATUS
        explicit_annotated = status in ANNOTATED_STATUS

        if explicit_pending:
            has_any_annotation = False
        else:
            has_any_annotation = any(
                (row.get(f) or "").strip()
                for f in ("answer_gt", "rubric", "score_teacher_a", "score_teacher_b")
            )
        if full is None and has_any_annotation:
            res.add("error", sid, "full_score", "已开始标注但缺满分，无法校验分数范围")
        if full is not None and full <= 0:
            res.add("error", sid, "full_score", f"满分必须为正数，实为 {full}")

        # 6) 分数范围
        for fld in ("score_teacher_a", "score_teacher_b", "score_arbitrated"):
            v = nums[fld]
            if v is None or full is None:
                continue
            if v < 0:
                res.add("error", sid, fld, f"分数为负: {v}")
            if v > full:
                res.add("error", sid, fld, f"分数 {v} 超过满分 {full}")

        # 7) 仲裁规则（调研 §5.6）
        if a is not None and b is not None:
            thr = arbitration_threshold(qtype)
            gap = abs(a - b)
            need_arb = gap > thr
            has_arb = arb is not None

            if need_arb and not has_arb:
                res.add(
                    "error", sid, "score_arbitrated",
                    f"|A-B|={gap} > 阈值 {thr}，必须给出仲裁分",
                )
            if not need_arb and has_arb:
                res.add(
                    "warn", sid, "score_arbitrated",
                    f"|A-B|={gap} ≤ 阈值 {thr}，不应仲裁（当前有仲裁分 {arb}）",
                )
            if has_arb and not (row.get("arbitration_reason") or "").strip():
                res.add("error", sid, "arbitration_reason", "有仲裁分但未填仲裁理由")
            if has_arb and arb is not None:
                lo, hi = min(a, b), max(a, b)
                if not (lo - 0.001 <= arb <= hi + 0.001):
                    res.add(
                        "error", sid, "score_arbitrated",
                        f"仲裁分 {arb} 落在 A/B 区间 [{lo}, {hi}] 之外，"
                        f"与「仲裁理由」描述不符，需人工复核",
                    )

        # 8) 标注完成度
        lacks = [f for f in ANNOTATION_FIELDS if not (row.get(f) or "").strip()]
        if explicit_annotated and lacks:
            res.add(
                "error", sid, "status",
                f"status=已标注 但字段不完整，缺 {lacks}——状态与实际不符，需修正",
            )
        # status 缺失时回退到「字段是否齐全」的启发式
        is_pending = explicit_pending or (not explicit_annotated and bool(lacks))
        if is_pending:
            res.pending_rows.append(sid)
            note = (row.get("notes") or "").strip()
            # 有了显式 status 列后，不再要求 notes 里手写「待标注」
            if not explicit_pending and "待标注" not in note:
                res.add(
                    "warn", sid, "notes",
                    f"缺少标注字段 {lacks}，且 status 列为空、notes 未标注「待标注」，"
                    f"无法判断该行是待办还是漏填",
                )

        # 9) 题型与评分方式一致性
        if qtype in SUBJECTIVE_TYPES and full is not None and full > 0:
            if not (row.get("rubric") or "").strip():
                res.add("warn", sid, "rubric", f"{qtype} 属主观题，缺 rubric 将无法评分")

    res.stat = {
        "rows": res.total_rows,
        "errors": len(res.errors),
        "warnings": len(res.warns),
        "pending": len(res.pending_rows),
        "annotated": res.total_rows - len(res.pending_rows),
    }
    return res


# ----------------------------------------------------------------- 输出


def render(res: Result) -> str:
    out: list[str] = []
    out.append("=" * 72)
    out.append(f"标注数据集校验报告  {res.path}")
    out.append("=" * 72)

    s = res.stat
    out.append(
        f"总行数 {s['rows']}   错误 {s['errors']}   警告 {s['warnings']}   "
        f"已标注 {s['annotated']}   待标注 {s['pending']}"
    )
    out.append("")

    if res.errors:
        out.append(f"--- 错误 ({len(res.errors)}) ---")
        for i in res.errors:
            out.append(f"  ✗ [{i.sample_id}] {i.field}: {i.message}")
        out.append("")

    if res.warns:
        out.append(f"--- 警告 ({len(res.warns)}) ---")
        for i in res.warns:
            out.append(f"  ! [{i.sample_id}] {i.field}: {i.message}")
        out.append("")

    if res.pending_rows:
        out.append(f"--- 待标注 ({len(res.pending_rows)}) ---")
        for sid in res.pending_rows:
            out.append(f"  · {sid}")
        out.append("")

    if not res.errors and not res.warns:
        out.append("结构、算术与仲裁规则全部通过。")
        out.append("")

    if s["rows"] and s["pending"] == s["rows"]:
        out.append(
            "提示：全部行仍处待标注状态。按 PLAN v2.0 §3 E2，"
            "双评 + 仲裁完成前不得进入 E3 实测。"
        )
    out.append("=" * 72)
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="标注数据集校验器")
    ap.add_argument("csv_path", help="标注表 CSV 路径")
    ap.add_argument("--json", action="store_true", help="以 JSON 输出")
    args = ap.parse_args()

    path = Path(args.csv_path)
    if not path.exists():
        print(f"[FATAL] 文件不存在: {path}", file=sys.stderr)
        return 2

    res = validate(path)

    if args.json:
        print(json.dumps(
            {
                "path": res.path,
                "stat": res.stat,
                "pending": res.pending_rows,
                "issues": [
                    {"level": i.level, "sample_id": i.sample_id,
                     "field": i.field, "message": i.message}
                    for i in res.issues
                ],
            },
            ensure_ascii=False, indent=2,
        ))
    else:
        print(render(res))

    return 1 if res.errors else 0


if __name__ == "__main__":
    sys.exit(main())