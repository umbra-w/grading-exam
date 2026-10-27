#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
评测运行器 —— 对应 PLAN v2.0 §3 E3/E4。

输入：
  --human-a/--human-b  双评分数（人工金标准）
  --ai                 AI 评分结果
  --dataset            标注 CSV（用于取满分、题型、质量层做分层）

输出：
  控制台报告 + 可选 JSON（供 freeze.py 归档）

**最重要的设计决定：分层的样本量下限。**
按调研 §9.4，样本量不足的分层只报数、不作结论。所以每个分层都会标注
是否达到 MIN_N_FOR_GATE；未达标时即使数字漂亮也不得用于门槛判定——
否则"抽了 8 道题全对"就会被当成"准确率 100%"。

用法：
  python run_eval.py --ai results_ai.csv --human-a results_a.csv --human-b results_b.csv
  python run_eval.py --selftest      # 用构造数据自测整条流水线
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

for _s in ("stdout", "stderr"):
    _stream = getattr(sys, _s, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass

sys.path.insert(0, str(Path(__file__).resolve().parent))

from metrics import (  # noqa: E402
    MIN_N_FOR_GATE,
    RunRecord,
    aggregate_cer,
    evaluate_scores,
    exact_match_rate,
    judge_gate,
    score_bands,
    stability,
    weighted_kappa,
    icc_2_1,
)

OBJECTIVE_TYPES = {"选择", "判断", "填空"}
HALF_POINT_TYPES = {"填空"}


def arbitration_threshold(qtype: str) -> float:
    """仲裁阈值（CONTRACT.md §4.1）：0.5 分粒度题型为 0.5，其余为 1.0，严格大于"""
    return 0.5 if qtype in HALF_POINT_TYPES else 1.0


# ----------------------------------------------------------------- 数据读取


def read_wide(path: Path) -> dict[str, dict[str, str]]:
    """
    读一份「sample_id → 字段」的宽表。
    容忍 BOM 与空行；sample_id 为空的行跳过并告警。
    """
    text = path.read_bytes().decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))
    out: dict[str, dict[str, str]] = {}
    skipped: list[int] = []
    for i, r in enumerate(rows, start=2):
        sid = (r.get("sample_id") or "").strip()
        if not sid:
            skipped.append(i)
            continue
        out[sid] = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
    if skipped:
        print(f"[WARN] {path.name} 第 {skipped} 行缺 sample_id，已跳过", file=sys.stderr)
    return out


def pick_col(row: dict[str, str], candidates: list[str]) -> str:
    for c in candidates:
        if c in row and row[c] != "":
            return row[c]
    return ""


def to_float(s: str) -> float | None:
    if s is None or s == "":
        return None
    try:
        return float(s)
    except ValueError:
        return None


# ----------------------------------------------------------------- 主流程


@dataclass
class EvalReport:
    n_total: int = 0
    n_scored: int = 0
    n_objective: int = 0
    n_subjective: int = 0
    missing: list[str] = field(default_factory=list)
    human_baseline: dict = field(default_factory=dict)
    overall: dict = field(default_factory=dict)
    objective: dict = field(default_factory=dict)
    bands: dict = field(default_factory=dict)
    by_qtype: dict = field(default_factory=dict)
    by_layer: dict = field(default_factory=dict)
    gate: dict = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


def run(
    ai: dict[str, dict[str, str]],
    human_a: dict[str, dict[str, str]],
    human_b: dict[str, dict[str, str]],
    dataset: dict[str, dict[str, str]] | None,
    mode: str,
) -> EvalReport:
    rep = EvalReport()

    # 只评测三方都有数据的样本。缺任何一方的样本单独列出——
    # 默默丢弃会让"评测了 300 题"这种数字产生误导。
    ids = sorted(set(ai) & set(human_a))
    all_ids = sorted(set(ai) | set(human_a) | set(human_b))
    rep.n_total = len(all_ids)
    rep.missing = [i for i in all_ids if i not in set(ai) & set(human_a)]

    records: list[RunRecord] = []
    obj_pairs: list[tuple[str, str]] = []
    per_qtype: dict[str, list[RunRecord]] = {}
    per_layer: dict[str, list[RunRecord]] = {}
    human_pairs: list[tuple[float, float]] = []

    for sid in ids:
        a_row = ai[sid]
        ha_row = human_a[sid]
        ds_row = (dataset or {}).get(sid, {})

        qtype = pick_col(ds_row, ["qtype"]) or pick_col(a_row, ["qtype"]) or "简答"
        full = to_float(pick_col(ds_row, ["full_score"])) or to_float(pick_col(a_row, ["full_score"])) or 0.0
        layer = pick_col(ds_row, ["quality_layer"]) or "L?"
        gran = 0.5 if qtype in HALF_POINT_TYPES else 0.5

        if qtype in OBJECTIVE_TYPES:
            # 客观题走确定性判定，不进 MAE 统计——
            # 把客观题和主观题混成一个"准确率"会掩盖两边的真实表现。
            rep.n_objective += 1
            std = pick_col(ds_row, ["objective_answer"]) or pick_col(a_row, ["reference_answer"])
            stu = pick_col(a_row, ["answer_text", "student_answer"])
            if std:
                obj_pairs.append((std, stu))
            continue

        ai_score = to_float(pick_col(a_row, ["score", "score_ai"]))
        ha_score = to_float(pick_col(ha_row, ["score", "score_teacher_a"]))
        hb_score = to_float(pick_col(human_b.get(sid, {}), ["score", "score_teacher_b"]))

        if ai_score is None or ha_score is None:
            rep.missing.append(sid)
            continue

        rec = RunRecord(
            run_id=pick_col(a_row, ["run_id"]) or "unknown",
            sample_id=sid,
            qtype=qtype,
            score_ai=ai_score,
            score_human=ha_score,
            full_score=full if full > 0 else 10.0,
            granularity=gran,
            severe_error=pick_col(a_row, ["severe_error"]).lower() in {"1", "true", "yes", "是"},
        )
        records.append(rec)
        per_qtype.setdefault(qtype, []).append(rec)
        per_layer.setdefault(layer, []).append(rec)

        if hb_score is not None:
            human_pairs.append((ha_score, hb_score))

    rep.n_scored = len(records)
    rep.n_subjective = len(records)

    if obj_pairs:
        rep.objective = {
            "n": len(obj_pairs),
            "exact_match": exact_match_rate(obj_pairs),
            "cer": aggregate_cer(obj_pairs)[0],
            "note": "客观题为零网络零 token 的确定性判定；独立报告，不与主观题合并。",
        }

    # 人工一致性基线：这是所有 AI 指标的**参照系**。
    # 若人工之间的一致性只有 0.6，要求 AI 达到 0.9 是不合理的。
    if human_pairs:
        lv = max(2, int(round(max(hr[0] for hr in human_pairs) / 0.5)) + 1)
        k, klo, khi = weighted_kappa([p[0] for p in human_pairs], [p[1] for p in human_pairs], lv)
        diffs = [abs(x - y) for x, y in human_pairs]
        rep.human_baseline = {
            "n": len(human_pairs),
            "kappa_weighted": k,
            "kappa_ci95": [klo, khi],
            "icc_2_1": icc_2_1([[x, y] for x, y in human_pairs]),
            "mean_abs_diff": sum(diffs) / len(diffs),
            "within_1_rate": sum(1 for d in diffs if d <= 1.0) / len(diffs),
            "note": "人工一致性是 AI 指标的参照系；低于 0.70 应先修订 rubric 再测 AI。",
        }
        if k < 0.70:
            rep.warnings.append(
                f"人工-人工加权 Kappa = {k:.3f} < 0.70。按调研 §9.4，应先修订 rubric，"
                f"此状态下测 AI 无意义。"
            )

    if not records:
        rep.warnings.append("没有可评测的主观题样本。")
        return rep

    m = evaluate_scores(records)
    rep.overall = m.to_dict()
    rep.bands = score_bands(records)

    if m.n < MIN_N_FOR_GATE:
        rep.warnings.append(f"主观题样本量 {m.n} < {MIN_N_FOR_GATE}，以下结论仅作参考。")

    # 分层统计（按题型）
    for qt, recs in sorted(per_qtype.items()):
        sub = evaluate_scores(recs, with_kappa=len(recs) >= 10)
        rep.by_qtype[qt] = {
            "n": sub.n,
            "mae": sub.mae,
            "within_1": sub.within_1,
            "kappa_weighted": sub.kappa_weighted,
            "icc_2_1": sub.icc21,
            "gate_eligible": sub.n >= MIN_N_FOR_GATE,
            "note": "" if sub.n >= MIN_N_FOR_GATE else f"样本量 {sub.n} < {MIN_N_FOR_GATE}，仅参考",
        }

    # 分层统计（按质量层 L1~L7）——这是"哪些图片条件会翻车"的关键视图
    for ly, recs in sorted(per_layer.items()):
        sub = evaluate_scores(recs, with_kappa=False)
        rep.by_layer[ly] = {
            "n": sub.n,
            "mae": sub.mae,
            "within_1": sub.within_1,
            "severe_error_rate": sub.severe_error_rate,
            "gate_eligible": sub.n >= MIN_N_FOR_GATE,
        }

    # 门槛裁定：只用整体实测值，且样本量必须达标
    kappa_or_icc = m.icc21 if m.icc21 == m.icc21 else m.kappa_weighted
    rep.gate = judge_gate(
        mode,
        objective_accuracy=(rep.objective.get("exact_match", {}) or {}).get("rate"),
        within_1=m.within_1["rate"],
        kappa_or_icc=kappa_or_icc,
        severe_error_rate=m.severe_error_rate["rate"],
        n=m.n,
    )

    return rep


# ----------------------------------------------------------------- 自测


def _selftest() -> int:
    """用构造数据跑通整条流水线，验证各环节不抛异常且数字合理。"""
    import random

    random.seed(42)
    ai: dict[str, dict[str, str]] = {}
    ha: dict[str, dict[str, str]] = {}
    hb: dict[str, dict[str, str]] = {}
    ds: dict[str, dict[str, str]] = {}

    for i in range(1, 121):
        sid = f"MATH-CALC-{i:04d}"
        full = 10.0
        truth = round(random.uniform(4, 10) * 2) / 2
        noise = random.choice([0, 0, 0, 0.5, -0.5, 1, -1])
        ai_score = min(full, max(0, truth + noise))
        ha_score = truth
        hb_score = min(full, max(0, truth + random.choice([0, 0, 0, 0.5, -0.5])))
        ai[sid] = {"sample_id": sid, "score": str(ai_score), "full_score": str(full), "qtype": "计算", "run_id": "r1"}
        ha[sid] = {"sample_id": sid, "score": str(ha_score)}
        hb[sid] = {"sample_id": sid, "score": str(hb_score)}
        ds[sid] = {"sample_id": sid, "qtype": "计算", "full_score": str(full), "quality_layer": "L2"}

    # 加 20 道客观题，验证客观题走独立口径
    for i in range(1, 21):
        sid = f"MATH-MC-{i:04d}"
        ai[sid] = {"sample_id": sid, "answer_text": "A", "qtype": "选择"}
        ha[sid] = {"sample_id": sid}
        ds[sid] = {"sample_id": sid, "qtype": "选择", "objective_answer": "A", "full_score": "2", "quality_layer": "L1"}

    rep = run(ai, ha, hb, ds, mode="assist")

    fails: list[str] = []

    def check(name: str, cond: bool, detail: str = "") -> None:
        print(f"  {'PASS' if cond else 'FAIL'}  {name}{(' — ' + detail) if detail else ''}")
        if not cond:
            fails.append(name)

    print("--- 评测流水线自测 ---")
    check("主观题样本数正确", rep.n_subjective == 120, f"got {rep.n_subjective}")
    check("客观题样本数正确", rep.n_objective == 20, f"got {rep.n_objective}")
    check("客观题准确率被独立报告", rep.objective.get("exact_match", {}).get("rate") == 1.0)
    check("客观题 CER 为 0", rep.objective.get("cer") == 0.0)
    check("人工基线已计算", "kappa_weighted" in rep.human_baseline)
    check("人工一致性较高（构造数据）", (rep.human_baseline.get("kappa_weighted") or 0) > 0.6,
          f"kappa={rep.human_baseline.get('kappa_weighted'):.3f}")
    check("整体 MAE 合理（构造噪声较小）", rep.overall["mae"] < 1.0, f"mae={rep.overall['mae']:.3f}")
    # 质量层分层只统计**主观题**：客观题走确定性比对路径并在循环中提前 continue，
    # 不进 MAE 统计。构造数据里只有 L2 是主观题层，L1 全是客观题，故只断言 L2。
    check("主观题的质量层分层存在（L2）", "L2" in rep.by_layer, f"got {sorted(rep.by_layer)}")
    check("客观题不混入主观题分层", "L1" not in rep.by_layer,
          "L1 全为客观题，不应出现在主观题分层中")
    check("分层标注了门槛资格", "gate_eligible" in rep.by_qtype.get("计算", {}))
    check("门槛裁定已产出", "passed" in rep.gate)
    check("门槛裁定带样本量与限制说明", "insufficient_sample" in rep.gate and "caveat" in rep.gate)

    print("")
    print("--- 关键数字 ---")
    print(f"  人工基线 κ = {rep.human_baseline.get('kappa_weighted', float('nan')):.4f}")
    print(f"  AI   MAE  = {rep.overall['mae']:.4f}  ±1 分比例 = {rep.overall['within_1']['rate']:.4f}")
    print(f"  AI   ICC  = {rep.overall['icc_2_1']:.4f}  κ = {rep.overall['kappa_weighted']:.4f}")
    print(f"  客观题精确匹配 = {rep.objective['exact_match']['rate']:.4f}")
    print(f"  门槛裁定 = {'通过' if rep.gate['passed'] else '未通过'}（{rep.gate['recommended_action']}）")
    for w in rep.warnings:
        print(f"  ⚠ {w}")

    print("")
    if fails:
        print(f"自测失败 {len(fails)} 项: {fails}")
        return 1
    print("评测流水线自测通过")
    return 0


# ----------------------------------------------------------------- 输出


def render(rep: EvalReport) -> str:
    out: list[str] = []
    out.append("=" * 72)
    out.append("评测报告（E3/E4）")
    out.append("=" * 72)
    out.append(
        f"样本总数 {rep.n_total}   可评主观题 {rep.n_scored}   客观题 {rep.n_objective}"
        + (f"   缺失 {len(rep.missing)}" if rep.missing else "")
    )
    out.append("")

    if rep.missing:
        out.append(f"--- 数据缺失 ({len(rep.missing)}) ---")
        out.append(f"  {', '.join(rep.missing[:20])}{' …' if len(rep.missing) > 20 else ''}")
        out.append("  说明：缺失样本一律不出现在统计中，且已在此列出，避免样本量被误读。")
        out.append("")

    if rep.human_baseline:
        hb = rep.human_baseline
        out.append("--- 人工一致性基线（AI 指标的参照系）---")
        out.append(f"  双评样本 n = {hb['n']}")
        out.append(f"  加权 Kappa = {hb['kappa_weighted']:.4f}  95%CI [{hb['kappa_ci95'][0]:.4f}, {hb['kappa_ci95'][1]:.4f}]")
        out.append(f"  ICC(2,1)   = {hb['icc_2_1']:.4f}")
        out.append(f"  平均绝对差 = {hb['mean_abs_diff']:.4f}    ≤1 分比例 = {hb['within_1_rate']:.4f}")
        out.append(f"  {hb['note']}")
        out.append("")

    if rep.objective:
        o = rep.objective
        em = o["exact_match"]
        out.append("--- 客观题（确定性判定，零网络零 token）---")
        out.append(f"  n = {o['n']}   精确匹配率 = {em['rate']:.4f}  95%CI [{em['ci95'][0]:.4f}, {em['ci95'][1]:.4f}]")
        out.append(f"  语料级 CER = {o['cer']:.4f}")
        out.append(f"  {o['note']}")
        out.append("")

    if rep.n_scored:
        o = rep.overall
        out.append("--- 主观题整体 ---")
        out.append(f"  n = {o['n']}   注：{o['note'] or '样本量充足'}")
        out.append(f"  MAE  = {o['mae']:.4f}  95%CI [{o['mae_ci95'][0]:.4f}, {o['mae_ci95'][1]:.4f}]")
        out.append(f"  RMSE = {o['rmse']:.4f}   平均偏差 = {o['mean_bias']:+.4f}")
        out.append(f"  ±0.5 分比例 = {o['within_0.5']['rate']:.4f}   ±1 分比例 = {o['within_1']['rate']:.4f}   ±2 分比例 = {o['within_2']['rate']:.4f}")
        se = o["severe_error_rate"]
        out.append(f"  严重错误率 = {se['rate']:.4f}  95%CI [{se['ci95'][0]:.4f}, {se['ci95'][1]:.4f}]")
        out.append(f"  加权 Kappa = {o['kappa_weighted']:.4f}   ICC(2,1) = {o['icc_2_1']:.4f}   ICC(2,k) = {o['icc_2_k']:.4f}")
        out.append(f"  Spearman = {o['spearman']:.4f}")
        out.append("")

        out.append('--- 分数段（40~80% 是最容易「给中间分」的区域）---')
        for band, v in rep.bands.items():
            if v.get("n"):
                out.append(f"  {band:<8} n={v['n']:<4} MAE={v['mae']:.3f}  ≤1分={v['within_1']['rate']:.3f}")
            else:
                out.append(f"  {band:<8} n=0")
        out.append("")

    if rep.by_qtype:
        out.append("--- 分层：按题型 ---")
        for qt, v in rep.by_qtype.items():
            flag = "" if v["gate_eligible"] else "  ⚠ 样本不足，仅参考"
            k = f"{v['kappa_weighted']:.3f}" if v["kappa_weighted"] is not None else "n/a"
            out.append(f"  {qt:<4} n={v['n']:<4} MAE={v['mae']:.3f}  ≤1分={v['within_1']['rate']:.3f}  κ={k}{flag}")
        out.append("")

    if rep.by_layer:
        out.append("--- 分层：按图片质量层（找出哪些图片条件会翻车）---")
        out.append("  注：本表只含主观题；客观题走确定性比对，不参与 MAE 统计。")
        for ly, v in rep.by_layer.items():
            flag = "" if v.get("gate_eligible") else "  ⚠ 样本不足"
            out.append(f"  {ly:<4} n={v['n']:<4} MAE={v['mae']:.3f}  ≤1分={v['within_1']['rate']:.3f}  严重错误={v['severe_error_rate']['rate']:.3f}{flag}")
        out.append("")

    g = rep.gate
    out.append("--- 门槛裁定（E4）---")
    out.append(f"  模式：{g['mode']}")
    for c in g["checks"]:
        mark = "✓" if c["pass"] else "✗"
        out.append(f"  {mark} {c['metric']:<16} 目标 {c['target']}  实测 {c['detail']}")
    out.append(f"  → {'达标：' + g['recommended_action'] if g['passed'] else '未达标：' + str(g['recommended_action'])}")
    if g.get("caveat"):
        out.append(f"  ⚠ {g['caveat']}")
    out.append("")

    if rep.warnings:
        out.append("--- 警告 ---")
        for w in rep.warnings:
            out.append(f"  ⚠ {w}")
        out.append("")

    out.append("=" * 72)
    return "\n".join(out)


def main() -> int:
    ap = argparse.ArgumentParser(description="评测运行器（E3/E4）")
    ap.add_argument("--ai", type=Path, help="AI 评分结果 CSV")
    ap.add_argument("--human-a", type=Path, help="人工 A 评分 CSV")
    ap.add_argument("--human-b", type=Path, help="人工 B 评分 CSV")
    ap.add_argument("--dataset", type=Path, help="标注数据集 CSV（用于取满分/题型/质量层）")
    ap.add_argument("--mode", default="assist", choices=["assist", "autofill"], help="门槛模式")
    ap.add_argument("--out", type=Path, help="输出 JSON 路径")
    ap.add_argument("--selftest", action="store_true", help="用构造数据自测流水线")
    args = ap.parse_args()

    if args.selftest or not args.ai:
        if not args.selftest:
            print("未提供 --ai，改用自测模式。\n")
        return _selftest()

    if not args.human_a:
        print("[FATAL] 必须提供 --human-a（人工金标准）", file=sys.stderr)
        return 2

    ai = read_wide(args.ai)
    ha = read_wide(args.human_a)
    hb = read_wide(args.human_b) if args.human_b else {}
    ds = read_wide(args.dataset) if args.dataset else None

    print(f"AI {len(ai)} 行 | 人工A {len(ha)} 行 | 人工B {len(hb)} 行"
          + (f" | 数据集 {len(ds)} 行" if ds else ""))
    print("")

    rep = run(ai, ha, hb, ds, args.mode)
    print(render(rep))

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(
            json.dumps(rep.__dict__, ensure_ascii=False, indent=2, default=str),
            encoding="utf-8",
        )
        print(f"已写出 {args.out}")

    return 0 if rep.gate.get("passed") else 1


if __name__ == "__main__":
    sys.exit(main())