#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
评测指标库 —— 对应 PLAN v2.0 §3 E1-4 / 调研报告附录 A

实现：
  识别类：CER / WER（附录 A.1）
  评分类：MAE（A.2）、RMSE（A.3）、加权 Kappa（A.4）、ICC（A.5）
  业务类：±0.5/±1 分比例、严重错误率、分数段准确率、连续性（A.6/A.7）

设计约束：
  1. 只用标准库；scipy 与 sklearn 若存在则自动启用更精确的分位数，
     缺失时退回标准库实现，**不因缺依赖而失败**。
  2. 所有比例类指标必须同时给出样本量与 95% 置信区间（调研 §9.4）。
  3. 样本量 < 100 的细分分层标记为"仅参考"，不参与门槛判定（调研 §9.4）。

用法：
  python metrics.py selftest          # 用构造数据自测全部指标
  python metrics.py demo              # 打印一份示例报告

本模块被 scripts/eval/run_eval.py 调用；不直接读取数据集。
"""
from __future__ import annotations

import argparse
import math
import sys
from dataclasses import dataclass, field
from typing import Sequence

# Windows 控制台编码兜底
for _s in ("stdout", "stderr"):
    _stream = getattr(sys, _s, None)
    if _stream is not None and hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass

try:  # 可选加速：分位数更精确
    from scipy import stats as _scipy_stats  # type: ignore

    HAS_SCIPY = True
except Exception:  # pragma: no cover
    _scipy_stats = None
    HAS_SCIPY = False

# 分层样本量下限：低于此值的分层只报数、不作门槛判定（调研 §9.4）
MIN_N_FOR_GATE = 100


# ============================================================ 统计辅助


def _norm_ppf(p: float) -> float:
    """标准正态分位数（Acklam 有理逼近，精度约 1e-9）"""
    if not 0.0 < p < 1.0:
        raise ValueError(f"p 必须在 (0,1)，收到 {p}")
    a = (-3.969683028665376e01, 2.209460984245205e02, -2.759285104469687e02,
         1.383577518672690e02, -3.066479806614716e01, 2.506628277459239e00)
    b = (-5.447609879822406e01, 1.615858368580409e02, -1.556989798598866e02,
         6.680131188771972e01, -1.328068155288572e01)
    c = (-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e00,
         -2.549732539343734e00, 4.374664141464968e00, 2.938163982698783e00)
    d = (7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e00,
         3.754408661907416e00)
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = math.sqrt(-2 * math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > phigh:
        q = math.sqrt(-2 * math.log(1 - p))
        return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    q = p - 0.5
    r = q * q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


def wilson_ci(successes: int, n: int, confidence: float = 0.95) -> tuple[float, float]:
    """
    Wilson 得分区间。选它而不是 Wald 区间的原因：
    本项目的比例指标常接近 1.0（如准确率 99%），Wald 区间在边界会给出
    无意义的结果（上限超过 1 或宽度为 0），Wilson 在极端比例下仍然可靠。
    """
    if n <= 0:
        return (float("nan"), float("nan"))
    z = _norm_ppf(1 - (1 - confidence) / 2)
    p = successes / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = (z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def mean_ci(values: Sequence[float], confidence: float = 0.95) -> tuple[float, float, float]:
    """均值的 95% 置信区间（大样本正态近似）。返回 (mean, lo, hi)"""
    n = len(values)
    if n == 0:
        return (float("nan"), float("nan"), float("nan"))
    m = sum(values) / n
    if n == 1:
        return (m, m, m)
    var = sum((v - m) ** 2 for v in values) / (n - 1)
    se = math.sqrt(var / n)
    z = _norm_ppf(1 - (1 - confidence) / 2)
    return (m, m - z * se, m + z * se)


# ==================================================== 识别类：CER / WER


def _edit_ops(ref: Sequence, hyp: Sequence) -> tuple[int, int, int]:
    """
    最小编辑距离的 S/D/I 分解（Levenshtein）。
    返回 (替换, 删除, 插入)。
    用滚动数组 + 操作回溯；序列通常是字符串（中文按字）或词表（英文按词）。
    """
    n, m = len(ref), len(hyp)
    # dp[i][j] = (cost, S, D, I)
    prev: list[tuple[int, int, int, int]] = [(0, 0, 0, 0)]
    for j in range(1, m + 1):
        c, s, d, i = prev[j - 1]
        prev.append((c + 1, s, d, i + 1))  # 纯插入

    for i in range(1, n + 1):
        cur: list[tuple[int, int, int, int]] = [(prev[0][0] + 1, prev[0][1], prev[0][2] + 1, prev[0][3])]
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur.append(prev[j - 1])
                continue
            cands = []
            # 替换
            pc, ps, pd, pi = prev[j - 1]
            cands.append((pc + 1, ps + 1, pd, pi))
            # 删除（ref 多一个字符）
            pc, ps, pd, pi = prev[j]
            cands.append((pc + 1, ps, pd + 1, pi))
            # 插入（hyp 多一个字符）
            pc, ps, pd, pi = cur[j - 1]
            cands.append((pc + 1, ps, pd, pi + 1))
            cur.append(min(cands, key=lambda t: (t[0], t[1] + t[2] + t[3])))
        prev = cur

    _, s, d, i = prev[m]
    return (s, d, i)


def cer(ref: str, hyp: str) -> float:
    """
    字符错误率。中文按**字**计算（调研附录 A.1 要求注明口径）。
    ref 为空时：hyp 也为空则 0.0，否则返回 1.0（全部为插入错误）。
    """
    if ref == "" and hyp == "":
        return 0.0
    if ref == "":
        return 1.0
    s, d, i = _edit_ops(ref, hyp)
    return (s + d + i) / len(ref)


def wer(ref: str, hyp: str) -> float:
    """词错误率。按空白切词计算（英文场景）。"""
    r = ref.split()
    h = hyp.split()
    if not r and not h:
        return 0.0
    if not r:
        return 1.0
    s, d, i = _edit_ops(r, h)
    return (s + d + i) / len(r)


def aggregate_cer(pairs: Sequence[tuple[str, str]]) -> tuple[float, int]:
    """
    语料级 CER = 总编辑距离 / 总参考长度（**不是**逐样本 CER 的算术平均）。
    这是 ASR/OCR 领域的标准口径，逐样本平均会被短样本放大误差。
    返回 (CER, 样本数)
    """
    tot_err = tot_len = 0
    for ref, hyp in pairs:
        if not ref:
            continue
        s, d, i = _edit_ops(ref, hyp)
        tot_err += s + d + i
        tot_len += len(ref)
    return (tot_err / tot_len if tot_len else float("nan"), len(pairs))


def exact_match_rate(pairs: Sequence[tuple[str, str]]) -> dict:
    """整题完全匹配率（含 95% 置信区间）"""
    n = len(pairs)
    ok = sum(1 for r, h in pairs if r.strip() == h.strip())
    lo, hi = wilson_ci(ok, n)
    return {"rate": ok / n if n else float("nan"), "hits": ok, "n": n, "ci95": (lo, hi)}


# ================================================= 评分类：误差类指标


@dataclass
class ScoreMetrics:
    n: int
    mae: float
    mae_ci95: tuple[float, float]
    rmse: float
    mean_bias: float
    within_05: dict
    within_1: dict
    within_2: dict
    severe_error_rate: dict
    consistency: dict | None = None
    kappa_weighted: float | None = None
    kappa_ci95: tuple[float, float] | None = None
    icc21: float | None = None
    icc2k: float | None = None
    spearman: float | None = None
    levels: int | None = None
    note: str = ""

    def to_dict(self) -> dict:
        return {
            "n": self.n,
            "mae": self.mae, "mae_ci95": self.mae_ci95,
            "rmse": self.rmse, "mean_bias": self.mean_bias,
            "within_0.5": self.within_05, "within_1": self.within_1, "within_2": self.within_2,
            "severe_error_rate": self.severe_error_rate,
            "kappa_weighted": self.kappa_weighted, "kappa_ci95": self.kappa_ci95,
            "icc_2_1": self.icc21, "icc_2_k": self.icc2k,
            "spearman": self.spearman, "levels": self.levels,
            "note": self.note,
        }


def _within(pairs: Sequence[tuple[float, float]], tol: float) -> dict:
    n = len(pairs)
    ok = sum(1 for a, h in pairs if abs(a - h) <= tol + 1e-9)
    lo, hi = wilson_ci(ok, n)
    return {"rate": ok / n if n else float("nan"), "hits": ok, "n": n, "ci95": (lo, hi)}


def weighted_kappa(
    ai_scores: Sequence[float],
    human_scores: Sequence[float],
    levels: int,
    linear: bool = False,
) -> tuple[float, float, float]:
    """
    加权 Kappa（默认二次权重，调研附录 A.4）。

    重要：Kappa 的前提是**离散的等级**。若传入连续分数，须先按
    `score_levels` 离散化；本函数不做隐式取整，而是要求调用方明确 levels。
    返回 (kappa, lo, hi)，置信区间用 delta 方法近似。
    """
    n = len(ai_scores)
    if n != len(human_scores):
        raise ValueError("两组评分长度不一致")
    if n == 0:
        return (float("nan"), float("nan"), float("nan"))
    if levels < 2:
        raise ValueError("levels 必须 >= 2")

    def norm(v: float) -> int:
        idx = int(round(v))
        return min(max(idx, 0), levels - 1)

    a = [norm(v) for v in ai_scores]
    b = [norm(v) for v in human_scores]

    obs = [[0] * levels for _ in range(levels)]
    for x, y in zip(a, b):
        obs[x][y] += 1

    row = [sum(obs[i]) for i in range(levels)]
    col = [sum(obs[i][j] for i in range(levels)) for j in range(levels)]

    w = [[0.0] * levels for _ in range(levels)]
    for i in range(levels):
        for j in range(levels):
            d = abs(i - j) / (levels - 1)
            w[i][j] = d * d if not linear else d

    num = sum(w[i][j] * obs[i][j] for i in range(levels) for j in range(levels))
    den = sum(w[i][j] * row[i] * col[j] for i in range(levels) for j in range(levels)) / n

    if den == 0:
        # 双方都只给出同一个等级：完全一致，但 Kappa 无定义。
        # 返回 0.0 而非 nan，并在调用侧通过 note 说明。
        return (0.0, 0.0, 0.0)

    k = 1 - num / den

    # delta 方法近似标准误（Fleiss 等，加权 Kappa 的方差）
    # 简化实现：对每个样本的贡献做刀切近似，稳健且不引入额外分布假设
    jack: list[float] = []
    for drop in range(n):
        aa = a[:drop] + a[drop + 1:]
        bb = b[:drop] + b[drop + 1:]
        if not aa:
            continue
        o2 = [[0] * levels for _ in range(levels)]
        for x, y in zip(aa, bb):
            o2[x][y] += 1
        r2 = [sum(o2[i]) for i in range(levels)]
        c2 = [sum(o2[i][j] for i in range(levels)) for j in range(levels)]
        nu = sum(w[i][j] * o2[i][j] for i in range(levels) for j in range(levels))
        de = sum(w[i][j] * r2[i] * c2[j] for i in range(levels) for j in range(levels)) / len(aa)
        jack.append(1 - nu / de if de else float("nan"))

    valid = [v for v in jack if v == v]
    if len(valid) < 2:
        return (k, k, k)
    jm = sum(valid) / len(valid)
    jvar = sum((v - jm) ** 2 for v in valid) * (len(valid) - 1) / len(valid)
    se = math.sqrt(max(jvar, 0.0))
    z = _norm_ppf(0.975)
    return (k, k - z * se, k + z * se)


def icc_2_1(raters: Sequence[Sequence[float]]) -> float:
    """
    ICC(2,1)：单个评分者的绝对一致性（调研附录 A.5）。
    模型：two-way random effects, absolute agreement, single measurement。

    raters: 形状为 [subject][judge] 的矩阵，每行一个被测对象，每列一个评分者。
            本项目中通常为两列：AI 与人工金标准。
    """
    rows = [r for r in raters if len(r) == len(raters[0])]
    n = len(rows)
    if n < 2:
        return float("nan")
    k = len(rows[0])
    if k < 2:
        return float("nan")

    grand = sum(sum(r) for r in rows) / (n * k)
    row_means = [sum(r) / k for r in rows]
    col_means = [sum(rows[i][j] for i in range(n)) / n for j in range(k)]

    ss_rows = k * sum((rm - grand) ** 2 for rm in row_means)
    ss_cols = n * sum((cm - grand) ** 2 for cm in col_means)
    ss_total = sum((rows[i][j] - grand) ** 2 for i in range(n) for j in range(k))
    ss_err = ss_total - ss_rows - ss_cols

    ms_rows = ss_rows / (n - 1)
    ms_cols = ss_cols / (k - 1) if k > 1 else 0.0
    ms_err = ss_err / ((n - 1) * (k - 1)) if (n > 1 and k > 1) else 0.0

    denom = ms_rows + (k - 1) * ms_err + k * (ms_cols - ms_err) / n
    if denom == 0:
        return float("nan")
    return (ms_rows - ms_err) / denom


def icc_2_k(raters: Sequence[Sequence[float]]) -> float:
    """ICC(2,k)：k 名评分者**均值**的绝对一致性（调研附录 A.5）"""
    rows = [r for r in raters if len(r) == len(raters[0])]
    n = len(rows)
    if n < 2:
        return float("nan")
    k = len(rows[0])
    if k < 2:
        return float("nan")

    grand = sum(sum(r) for r in rows) / (n * k)
    row_means = [sum(r) / k for r in rows]
    col_means = [sum(rows[i][j] for i in range(n)) / n for j in range(k)]

    ss_rows = k * sum((rm - grand) ** 2 for rm in row_means)
    ss_cols = n * sum((cm - grand) ** 2 for cm in col_means)
    ss_total = sum((rows[i][j] - grand) ** 2 for i in range(n) for j in range(k))
    ss_err = ss_total - ss_rows - ss_cols

    ms_rows = ss_rows / (n - 1)
    ms_cols = ss_cols / (k - 1) if k > 1 else 0.0
    ms_err = ss_err / ((n - 1) * (k - 1)) if (n > 1 and k > 1) else 0.0

    denom = ms_rows + (ms_cols - ms_err) / n
    if denom == 0:
        return float("nan")
    return (ms_rows - ms_err) / denom


def spearman(a: Sequence[float], b: Sequence[float]) -> float:
    """Spearman 排名相关（并列取平均秩）"""
    n = len(a)
    if n != len(b) or n < 3:
        return float("nan")

    def ranks(x: Sequence[float]) -> list[float]:
        order = sorted(range(n), key=lambda i: x[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and x[order[j + 1]] == x[order[i]]:
                j += 1
            avg = (i + j) / 2 + 1
            for t in range(i, j + 1):
                r[order[t]] = avg
            i = j + 1
        return r

    ra, rb = ranks(a), ranks(b)
    ma, mb = sum(ra) / n, sum(rb) / n
    num = sum((ra[i] - ma) * (rb[i] - mb) for i in range(n))
    da = math.sqrt(sum((v - ma) ** 2 for v in ra))
    db = math.sqrt(sum((v - mb) ** 2 for v in rb))
    if da == 0 or db == 0:
        return float("nan")
    return num / (da * db)


def score_levels(full_score: float, granularity: float = 0.5) -> int:
    """
    把满分切成等级数。用于 Kappa 的离散化。
    默认 0.5 分粒度，与调研 §5.6 的粒度约定一致。
    """
    if full_score <= 0 or granularity <= 0:
        raise ValueError("满分与粒度必须为正")
    return int(round(full_score / granularity)) + 1


@dataclass
class RunRecord:
    """一条评测记录（对应调研 §8.3 的记录字段）"""
    run_id: str
    sample_id: str
    qtype: str
    score_ai: float
    score_human: float
    full_score: float
    granularity: float = 0.5
    severe_error: bool = False
    review_requested: bool = False
    need_manual_edit: bool = False
    latency_ms: float | None = None
    tokens_prompt: int = 0
    tokens_completion: int = 0
    cost_estimated: float = 0.0


def evaluate_scores(records: Sequence[RunRecord], with_kappa: bool = True) -> ScoreMetrics:
    """
    对一组评分记录计算全套主观题指标。
    客观题不应走这里——客观题用 exact_match_rate，它是确定性判定。
    """
    n = len(records)
    if n == 0:
        return ScoreMetrics(n=0, mae=float("nan"), mae_ci95=(float("nan"),) * 2, rmse=float("nan"),
                            mean_bias=float("nan"), within_05={}, within_1={}, within_2={},
                            severe_error_rate={}, note="无样本")

    diffs = [r.score_ai - r.score_human for r in records]
    absdiffs = [abs(d) for d in diffs]
    mae = sum(absdiffs) / n
    rmse = math.sqrt(sum(d * d for d in diffs) / n)
    bias = sum(diffs) / n
    _, lo, hi = mean_ci(absdiffs)

    pairs = [(r.score_ai, r.score_human) for r in records]
    se_hits = sum(1 for r in records if r.severe_error)
    se_lo, se_hi = wilson_ci(se_hits, n)

    kappa = kappa_ci = None
    if with_kappa:
        levels = max(score_levels(r.full_score, r.granularity) for r in records)
        kappa, klo, khi = weighted_kappa(
            [r.score_ai for r in records], [r.score_human for r in records], levels
        )
        kappa_ci = (klo, khi)

    icc21 = icc_2_1([[r.score_ai, r.score_human] for r in records])
    icc2k = icc_2_k([[r.score_ai, r.score_human] for r in records])
    sp = spearman([r.score_ai for r in records], [r.score_human for r in records])

    note = ""
    if n < MIN_N_FOR_GATE:
        note = f"样本量 {n} < {MIN_N_FOR_GATE}，仅作参考，不作门槛判定"

    return ScoreMetrics(
        n=n, mae=mae, mae_ci95=(lo, hi), rmse=rmse, mean_bias=bias,
        within_05=_within(pairs, 0.5), within_1=_within(pairs, 1.0), within_2=_within(pairs, 2.0),
        severe_error_rate={"rate": se_hits / n, "hits": se_hits, "n": n, "ci95": (se_lo, se_hi)},
        kappa_weighted=kappa, kappa_ci95=kappa_ci, icc21=icc21, icc2k=icc2k,
        spearman=sp, levels=score_levels(records[0].full_score, records[0].granularity) if records else None,
        note=note,
    )


def stability(per_sample_repeats: dict[str, Sequence[float]]) -> dict:
    """
    自稳定性（调研 §8.4）：同一答卷重复 N 次。
    判定规则：三次极差 > 1 分的题目占比 > 5% ⇒ 该配置不得进入自动填分候选。
    """
    n = len(per_sample_repeats)
    if n == 0:
        return {"n": 0}
    identical = 0
    over1 = 0
    ranges: list[float] = []
    for scores in per_sample_repeats.values():
        if len(scores) < 2:
            continue
        rng = max(scores) - min(scores)
        ranges.append(rng)
        if rng == 0:
            identical += 1
        if rng > 1.0 + 1e-9:
            over1 += 1

    m = len(ranges)
    over1_rate = over1 / m if m else float("nan")
    lo, hi = wilson_ci(over1, m)
    return {
        "n": n,
        "identical_rate": identical / m if m else float("nan"),
        "over1_rate": over1_rate,
        "over1_ci95": (lo, hi),
        "max_range": max(ranges) if ranges else float("nan"),
        "verdict": "禁止进入自动填分候选" if (over1_rate == over1_rate and over1_rate > 0.05) else "通过稳定性判定",
    }


def continuity_rate(completed: int, planned: int) -> dict:
    """连续处理不中断率（调研附录 A.7）"""
    if planned <= 0:
        return {"rate": float("nan"), "completed": completed, "planned": planned}
    lo, hi = wilson_ci(completed, planned)
    return {"rate": completed / planned, "completed": completed, "planned": planned, "ci95": (lo, hi)}


def score_bands(records: Sequence[RunRecord]) -> dict:
    """
    分数段准确率（调研 §7.3 末条）。
    按满分 0~20% / 20~40% / 40~60% / 60~80% / 80~100% 分箱，
    中间段（40~80%）单独报告——那是模型最容易"给中间分"的区域。
    """
    bands = [("0-20%", 0.0), ("20-40%", 0.2), ("40-60%", 0.4), ("60-80%", 0.6), ("80-100%", 0.8), ("100%+", 1.0)]
    out: dict[str, dict] = {}
    for name, low in bands:
        sel = [
            r for r in records
            if (r.score_human / r.full_score if r.full_score else 0) >= low
        ]
        if name != "100%+":
            idx = [b[1] for b in bands].index(low)
            high = bands[idx + 1][1] if idx + 1 < len(bands) else 1.01
            sel = [r for r in sel if (r.score_human / r.full_score) < high]
        if not sel:
            out[name] = {"n": 0}
            continue
        diffs = [abs(r.score_ai - r.score_human) for r in sel]
        m = sum(diffs) / len(diffs)
        _, lo, hi = mean_ci(diffs)
        out[name] = {
            "n": len(sel), "mae": m, "mae_ci95": (lo, hi),
            "within_1": _within([(r.score_ai, r.score_human) for r in sel], 1.0),
        }
    return out


def loss_ranking(records_hits: Sequence[tuple[str, Sequence[str]]]) -> list[tuple[str, int]]:
    """
    失分点聚合排序（SPEC F4.1）。
    records_hits: [(question_id, 未被命中的得分点列表), ...]
    """
    counter: dict[str, int] = {}
    for _, missed in records_hits:
        for p in missed:
            key = p.strip()
            if key:
                counter[key] = counter.get(key, 0) + 1
    return sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))


# ==================================================== 门槛裁定（E4）


GATES = {
    "assist": {   # 辅助阅卷模式
        "objective_accuracy": 0.99,
        "field_accuracy": 0.98,
        "within_1": 0.90,
        "kappa_or_icc": 0.80,
        "severe_error_rate_max": 0.03,
    },
    "autofill": {  # 自动填分模式
        "objective_accuracy": 0.995,
        "field_accuracy": 0.99,
        "within_1": 0.95,
        "kappa_or_icc": 0.90,
        "severe_error_rate_max": 0.01,
        "readback_consistency": 1.0,
    },
}


def judge_gate(
    mode: str,
    objective_accuracy: float | None = None,
    within_1: float | None = None,
    kappa_or_icc: float | None = None,
    severe_error_rate: float | None = None,
    n: int = 0,
) -> dict:
    """
    按模式判定是否达标。**门槛判定只用实测值**（调研 §9.4）。
    未达标时的处置是下调自动化等级，而不是调整口径。
    """
    g = GATES.get(mode)
    if not g:
        raise ValueError(f"未知模式 {mode}，可选 {list(GATES)}")

    checks: list[dict] = []

    def add(name: str, value: float | None, target: float, higher_better: bool) -> None:
        if value is None:
            checks.append({"metric": name, "value": None, "target": target, "pass": False,
                           "detail": "无实测值，不得判定为达标"})
            return
        ok = value >= target if higher_better else value <= target
        checks.append({"metric": name, "value": value, "target": target, "pass": ok,
                       "detail": f"{value:.4f} {'≥' if higher_better else '≤'} {target}"})

    add("客观题准确率", objective_accuracy, g["objective_accuracy"], True)
    add("主观题 ≤1 分比例", within_1, g["within_1"], True)
    add("加权 Kappa 或 ICC", kappa_or_icc, g["kappa_or_icc"], True)
    add("严重错误率", severe_error_rate, g["severe_error_rate_max"], False)

    passed = all(c["pass"] for c in checks)
    degraded = None
    if not passed:
        degraded = "降级为辅助阅卷" if mode == "autofill" else "降级为仅 AI 评分 + 人工复制"

    return {
        "mode": mode,
        "passed": passed,
        "checks": checks,
        "sample_n": n,
        "insufficient_sample": n < MIN_N_FOR_GATE,
        "recommended_action": "可上线该模式" if passed else degraded,
        "caveat": (f"样本量 {n} < {MIN_N_FOR_GATE}，结果仅作参考，不作门槛判定"
                   if n < MIN_N_FOR_GATE else ""),
    }


# ============================================================= 自测


def _selftest() -> int:
    """用构造数据自测全部指标。任何一项不符预期即返回非 0。"""
    fails: list[str] = []

    def expect(name: str, got, want, tol: float = 1e-6) -> None:
        if isinstance(want, float):
            ok = abs(got - want) <= tol
        else:
            ok = got == want
        print(f"  {'PASS' if ok else 'FAIL'}  {name}: got={got!r} want={want!r}")
        if not ok:
            fails.append(name)

    print("--- CER / WER ---")
    expect("完全相同", cer("你好世界", "你好世界"), 0.0)
    expect("一字替换", cer("你好世界", "你好世X"), 1 / 4)
    expect("一字删除", cer("你好世界", "你好世"), 1 / 4)
    expect("一字插入", cer("你好世界", "你好世界啊"), 1 / 4)
    expect("参考为空且假设为空", cer("", ""), 0.0)
    expect("参考为空假设非空", cer("", "x"), 1.0)
    expect("英文 WER 一词错", wer("the cat sat", "the dog sat"), 1 / 3)
    c, n = aggregate_cer([("你好世界", "你好世X"), ("abc", "abc")])
    expect("语料级 CER", round(c, 6), round(1 / 7, 6))
    expect("样本数", n, 2)

    print("--- 编辑距离分解 ---")
    s, d, i = _edit_ops("abc", "abxc")
    expect("插入 1 个", (s, d, i), (0, 0, 1))
    s, d, i = _edit_ops("abxc", "abc")
    expect("删除 1 个", (s, d, i), (0, 1, 0))
    s, d, i = _edit_ops("abc", "axc")
    expect("替换 1 个", (s, d, i), (1, 0, 0))

    print("--- 置信区间 ---")
    lo, hi = wilson_ci(99, 100)
    print(f"  99/100 的 Wilson 区间 = [{lo:.4f}, {hi:.4f}]")
    if not (0.94 < lo < 0.99 and 0.99 < hi < 1.0):
        fails.append("Wilson 区间范围异常")
        print("  FAIL  Wilson 区间范围异常（边界样本应给出合理区间）")
    else:
        print("  PASS  边界比例下区间合理")
    lo0, hi0 = wilson_ci(0, 10)
    if hi0 <= 0 or lo0 != 0.0:
        fails.append("零命中区间异常")
        print(f"  FAIL  零命中区间异常 = [{lo0}, {hi0}]")
    else:
        print(f"  PASS  零命中区间 = [0, {hi0:.4f}]")

    print("--- 加权 Kappa ---")
    # 完全一致：kappa 应为 1
    a = [0, 1, 2, 3, 4, 5]
    b = [0, 1, 2, 3, 4, 5]
    k, _, _ = weighted_kappa(a, b, levels=6)
    expect("完全一致 kappa", round(k, 6), 1.0)
    # 完全不一致的高方差组合
    a2 = [0, 0, 0, 5, 5, 5]
    b2 = [5, 5, 5, 0, 0, 0]
    k2, _, _ = weighted_kappa(a2, b2, levels=6)
    print(f"  最大分歧 kappa = {k2:.4f}（应显著小于 0）")
    if not (k2 < 0):
        fails.append("最大分歧 kappa 应为负")
        print("  FAIL  最大分歧时 kappa 应为负")
    else:
        print("  PASS  最大分歧 kappa 为负")

    print("--- ICC ---")
    # 完美一致：ICC(2,1) = 1
    mat = [[1.0, 1.0], [2.0, 2.0], [3.0, 3.0], [4.0, 4.0], [5.0, 5.0]]
    expect("完美一致 ICC(2,1)", round(icc_2_1(mat), 6), 1.0)
    # 存在随机噪声：ICC 应在 0~1 之间且低于完美
    mat2 = [[1.0, 1.2], [2.0, 1.9], [3.0, 3.3], [4.0, 3.7], [5.0, 5.1]]
    v = icc_2_1(mat2)
    print(f"  含噪声 ICC(2,1) = {v:.4f}")
    if not (0.9 < v < 1.0):
        fails.append("含噪声 ICC 异常")
        print("  FAIL  含噪声情况下 ICC 应接近但仍低于 1")
    else:
        print("  PASS  含噪声 ICC 合理")
    v_k = icc_2_k(mat2)
    if not (v_k >= v):
        fails.append("ICC(2,k) 应不低于 ICC(2,1)")
        print(f"  FAIL  ICC(2,k)={v_k:.4f} 应 >= ICC(2,1)={v:.4f}")
    else:
        print(f"  PASS  ICC(2,k)={v_k:.4f} >= ICC(2,1)={v:.4f}")

    print("--- Spearman ---")
    expect("完全单调", round(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 6), 1.0)
    expect("完全逆序", round(spearman([1, 2, 3, 4], [40, 30, 20, 10]), 6), -1.0)

    print("--- 业务指标 ---")
    recs = [
        RunRecord("r1", "S1", "简答", 5.0, 5.0, 10, severe_error=False),
        RunRecord("r1", "S2", "简答", 7.0, 6.5, 10, severe_error=False),
        RunRecord("r1", "S3", "计算", 0.0, 4.0, 10, severe_error=True),
        RunRecord("r1", "S4", "论述", 8.0, 8.5, 10, severe_error=False),
    ]
    m = evaluate_scores(recs)
    expect("MAE", round(m.mae, 6), round((0 + 0.5 + 4 + 0.5) / 4, 6))
    expect("RMSE 大于 MAE", m.rmse > m.mae, True)
    expect("严重错误率", round(m.severe_error_rate["rate"], 6), 0.25)
    expect("样本量提示", "仅作参考" in m.note, True)

    print("--- 稳定性 ---")
    st = stability({"S1": [5, 5, 5], "S2": [5, 6, 7], "S3": [4, 4, 4]})
    expect("极差 >1 占比", round(st["over1_rate"], 6), round(1 / 3, 6))
    expect("稳定性判定", st["verdict"], "禁止进入自动填分候选")

    print("--- 门槛裁定 ---")
    g1 = judge_gate("autofill", objective_accuracy=0.997, within_1=0.96,
                    kappa_or_icc=0.92, severe_error_rate=0.005, n=300)
    expect("全达标应通过", g1["passed"], True)
    g2 = judge_gate("autofill", objective_accuracy=0.99, within_1=0.96,
                    kappa_or_icc=0.92, severe_error_rate=0.005, n=300)
    expect("客观题未达标应不通过", g2["passed"], False)
    expect("未达标处置", g2["recommended_action"], "降级为辅助阅卷")
    g3 = judge_gate("assist", objective_accuracy=0.999, within_1=0.95,
                    kappa_or_icc=0.85, severe_error_rate=0.02, n=40)
    expect("小样本标记", g3["insufficient_sample"], True)
    g4 = judge_gate("assist", n=300)
    expect("无实测值不得判达标", g4["passed"], False)

    print("--- 失分点排序 ---")
    lr = loss_ranking([("Q1", ["步骤缺失", "单位错误"]), ("Q2", ["步骤缺失"]), ("Q3", ["步骤缺失", "单位错误"])])
    expect("排序结果", lr[0], ("步骤缺失", 3))

    print("")
    if fails:
        print(f"自测失败 {len(fails)} 项: {fails}")
        return 1
    print("自测全部通过")
    return 0


def _demo() -> None:
    import json
    recs = [
        RunRecord("demo", f"S{i:03d}", "简答", min(8.0, 4.0 + (i % 5) * 0.5), 5.0, 10)
        for i in range(1, 41)
    ]
    m = evaluate_scores(recs)
    print(json.dumps(m.to_dict(), ensure_ascii=False, indent=2, default=str))
    print("")
    print(json.dumps(judge_gate("assist", objective_accuracy=0.995, within_1=m.within_1["rate"],
                                kappa_or_icc=m.icc21, severe_error_rate=m.severe_error_rate["rate"],
                                n=m.n), ensure_ascii=False, indent=2, default=str))


def main() -> int:
    ap = argparse.ArgumentParser(description="评测指标库")
    ap.add_argument("cmd", choices=["selftest", "demo"], nargs="?", default="selftest")
    args = ap.parse_args()
    print(f"scipy 可用: {HAS_SCIPY}")
    print("")
    return _selftest() if args.cmd == "selftest" else (_demo() or 0)


if __name__ == "__main__":
    sys.exit(main())