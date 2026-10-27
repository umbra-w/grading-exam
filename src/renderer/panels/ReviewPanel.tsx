import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../store';
import type { ReviewItem, ReviewReason, ReviewStats } from '@shared/types';

/**
 * 复核队列面板（P1-8）。
 *
 * ── 这个面板存在的理由 ────────────────────────────────────────────────────
 *
 * AI 阅卷最大的风险不是"偶尔算错"，而是**错得没有痕迹**。
 * 复核队列把"模型自己也不确定的分数"集中到这里，让老师只花时间在
 * 真正可疑的那几份上，而不是从头复查全部。
 *
 * ── 界面上刻意做的三件事 ─────────────────────────────────────────────────
 *
 * 1. **原始分与当前分并排显示**。只显示一个分数，人就无法回答
 *    "老师改之前模型给的是几分"——而那正是判断模型质量的唯一依据。
 * 2. **修正理由与警示就地显示**，不塞进角落的日志栏。
 *    警示（如"总分未能重算"）如果不显眼，用户会以为改成功了。
 * 3. **待复核的条目不能直接删**。删掉就等于一个可疑分数没人看，
 *    且不留记录。必须下结论（确认无误 / 不参与评分）才能移出。
 */

/** 理由对应的小标签样式。用不同颜色是让人一眼扫出"哪类问题最多" */
const REASON_CLASS: Record<ReviewReason, string> = {
  low_confidence: 'badge amber',
  output_warnings: 'badge amber',
  ensemble_disagreement: 'badge amber',
  poor_image: 'badge red',
  objective_suspect: 'badge red',
  extreme_score: 'badge slate',
  model_requested: 'badge blue',
};

const REASON_LABEL: Record<ReviewReason, string> = {
  low_confidence: '置信度低',
  output_warnings: '输出被修正',
  ensemble_disagreement: '多次不一致',
  poor_image: '图片质量差',
  objective_suspect: '客观题可疑',
  extreme_score: '极端分数',
  model_requested: '模型要求复核',
};

const STATUS_LABEL: Record<ReviewItem['status'], string> = {
  pending: '待复核',
  corrected: '已修正',
  confirmed: '已确认无误',
  excluded: '已排除',
};

function fmtTime(ms: number): string {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return '—';
  }
}

export function ReviewPanel(): JSX.Element {
  const pushLog = useStore((s) => s.appendLog);

  const [items, setItems] = useState<ReviewItem[]>([]);
  const [stats, setStats] = useState<ReviewStats | null>(null);
  const [invalidDropped, setInvalidDropped] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 当前展开的条目 id（同时只展开一个：列表要能一眼扫完） */
  const [openId, setOpenId] = useState<string | null>(null);
  /** 每条的输入态：手填分数与修正理由 */
  const [draft, setDraft] = useState<Record<string, { score: string; note: string; by: string }>>({});
  /** 就地显示的警示（按条目 id） */
  const [warn, setWarn] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const r = await window.gradingExam.reviewQueue();
      setItems(r.items);
      setStats(r.stats);
      setInvalidDropped(r.invalidDropped);
      setLoadError(null);
    } catch (e) {
      // 读不到队列时**不能显示成"队列是空的"**——那会让人以为没有待办，
      // 而实际上有分数没人看。这是本项目最忌讳的一类静默失败（§6.1）
      setLoadError((e as Error)?.message ?? String(e));
      setItems([]);
      setStats(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function log(level: 'info' | 'warn' | 'error' | 'ok', message: string): void {
    pushLog({ ts: Date.now(), level, message });
  }

  function draftOf(id: string, fallbackScore: number): { score: string; note: string; by: string } {
    return draft[id] ?? { score: String(fallbackScore), note: '', by: '' };
  }

  function setDraftField(id: string, field: 'score' | 'note' | 'by', v: string, fallback: number): void {
    setDraft((d) => ({ ...d, [id]: { ...draftOf(id, fallback), [field]: v } }));
  }

  /** 手填分数并保存 */
  async function saveScore(item: ReviewItem): Promise<void> {
    const d = draftOf(item.id, item.effective.score);
    const n = Number(d.score);
    if (!Number.isFinite(n)) {
      setWarn((w) => ({ ...w, [item.id]: ['分数不是有效数字，未提交。'] }));
      return;
    }
    setBusy(true);
    try {
      const r = await window.gradingExam.reviewCorrect( {
        id: item.id,
        score: n,
        ...(d.note ? { note: d.note } : {}),
        ...(d.by ? { by: d.by } : {}),
      });
      setWarn((w) => ({ ...w, [item.id]: r.warnings }));
      if (r.warnings.length > 0) {
        for (const m of r.warnings) log('warn', m);
      }
      await refresh();
    } catch (e) {
      setWarn((w) => ({ ...w, [item.id]: [`保存失败：${(e as Error)?.message ?? String(e)}`] }));
    } finally {
      setBusy(false);
    }
  }

  /** 翻转一个评分点：命中 ↔ 未命中 */
  async function togglePoint(item: ReviewItem, point: string, toHit: boolean): Promise<void> {
    const d = draftOf(item.id, item.effective.score);
    setBusy(true);
    try {
      const r = await window.gradingExam.reviewCorrect( {
        id: item.id,
        ...(toHit ? { markHit: [point] } : { markMissed: [point] }),
        ...(d.note ? { note: d.note } : {}),
        ...(d.by ? { by: d.by } : {}),
      });
      setWarn((w) => ({ ...w, [item.id]: r.warnings }));
      // 警示里最要紧的一条是"总分没能重算"——它意味着分数还停在旧值，
      // 必须让人看见，所以同时写一份到日志栏留痕
      for (const m of r.warnings) log('warn', m);
      await refresh();
    } catch (e) {
      setWarn((w) => ({ ...w, [item.id]: [`保存失败：${(e as Error)?.message ?? String(e)}`] }));
    } finally {
      setBusy(false);
    }
  }

  async function mark(item: ReviewItem, status: 'confirmed' | 'excluded'): Promise<void> {
    const d = draftOf(item.id, item.effective.score);
    setBusy(true);
    try {
      await window.gradingExam.reviewVerdict( {
        id: item.id,
        status,
        ...(d.note ? { note: d.note } : {}),
        ...(d.by ? { by: d.by } : {}),
      });
      await refresh();
    } catch (e) {
      setWarn((w) => ({ ...w, [item.id]: [`操作失败：${(e as Error)?.message ?? String(e)}`] }));
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: ReviewItem): Promise<void> {
    setBusy(true);
    try {
      const r = await window.gradingExam.reviewRemove( { id: item.id });
      if (!r.ok) {
        setWarn((w) => ({
          ...w,
          [item.id]: ['待复核的条目不能直接删除，请先「确认无误」或「不参与评分」。'],
        }));
      }
      await refresh();
    } catch (e) {
      setWarn((w) => ({ ...w, [item.id]: [`操作失败：${(e as Error)?.message ?? String(e)}`] }));
    } finally {
      setBusy(false);
    }
  }

  if (loading && items.length === 0) {
    return (
      <div className="card">
        <h2>复核队列</h2>
        <p className="hint">正在读取队列…</p>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <h2>复核队列</h2>
        <p className="hint">
          低置信度、有输出警示、多次运行不一致的评分会进入这里。
          <strong>队列里的分数已经存在，但尚未经过人工确认。</strong>
          {stats === null ? '' : ` 共 ${stats.total} 条，待复核 ${stats.pending} 条。`}
        </p>

        {/* 读不到队列必须显式说，不能显示成"空队列" */}
        {loadError !== null && (
          <div className="notice err">
            读取复核队列失败：{loadError}
            <br />
            <span className="hint">
              这不代表没有待复核的分数。请查看日志栏，或重启软件后再试。
            </span>
          </div>
        )}

        {/* 损坏条数要显式暴露：隐藏它等于让队列悄悄变短 */}
        {invalidDropped > 0 && (
          <div className="notice err">
            队列里有 <strong>{invalidDropped}</strong> 条记录结构损坏，已隐藏。
            这意味着可能有分数没能进入复核，请人工核对最近的评分结果。
          </div>
        )}

        {stats !== null && (
          <div className="row">
            <span className="badge blue">待复核 {stats.pending}</span>
            <span className="badge">已修正 {stats.corrected}</span>
            <span className="badge">已确认 {stats.confirmed}</span>
            <span className="badge">已排除 {stats.excluded}</span>
            <span className="badge slate">
              修正率{' '}
              {/* null 显示成"暂无数据"而不是 0：没测过 ≠ 测过且通过 */}
              {stats.correctionRate === null ? '暂无数据' : `${Math.round(stats.correctionRate * 100)}%`}
            </span>
          </div>
        )}

        {stats !== null && stats.correctionRate !== null && stats.correctionRate > 0.5 && (
          <div className="notice">
            人工复核后改分的比例超过一半。这通常说明模型在当前题型上不可靠，
            建议先调整评分标准或提示词，而不是继续加大人工复核的量。
          </div>
        )}

        <div className="row">
          <button onClick={() => void refresh()} disabled={loading}>
            {loading ? '刷新中…' : '刷新队列'}
          </button>
        </div>
      </div>

      {items.length === 0 && loadError === null && (
        <div className="card">
          <div className="empty-state small">队列为空 —— 没有需要人工复核的评分。</div>
        </div>
      )}

      {items.map((item) => {
        const d = draftOf(item.id, item.effective.score);
        const open = openId === item.id;
        const changed = item.effective.score !== item.original.score;
        const hints = warn[item.id] ?? [];
        return (
          <div className="card" key={item.id}>
            <div className="row">
              <strong>{item.questionNo || '(未命名题目)'}</strong>
              {item.subject ? <span className="badge slate">{item.subject}</span> : null}
              <span className={item.status === 'pending' ? 'badge amber' : 'badge blue'}>
                {STATUS_LABEL[item.status]}
              </span>
              <button className="link-btn" onClick={() => setOpenId(open ? null : item.id)}>
                {open ? '收起' : '处理'}
              </button>
            </div>

            <div className="row">
              {item.reasons.map((r) => (
                <span key={r} className={REASON_CLASS[r]}>
                  {REASON_LABEL[r]}
                </span>
              ))}
            </div>

            <p className="hint">
              {/* 原始分与当前分并排：只给一个分数就无法判断模型改前改后差多少 */}
              模型分 <strong>{item.original.score}</strong> / {item.fullScore}
              {changed ? (
                <>
                  {' · '}
                  当前分 <strong>{item.effective.score}</strong>
                </>
              ) : null}
              {' · '}模型置信度 {item.original.confidence.toFixed(2)}
              {' · '}入队 {fmtTime(item.createdAt)}
            </p>

            {item.original.comment ? (
              <p className="hint">模型评语：{item.original.comment}</p>
            ) : null}

            {hints.length > 0 && (
              <div className="notice err">
                {/* 警示就地显示：塞进角落的日志会被忽略，
                    而"总分没能重算"这类警示忽略掉就是分数不对 */}
                {hints.map((m, i) => (
                  <div key={i}>{m}</div>
                ))}
              </div>
            )}

            {open && (
              <>
                <div className="field">
                  <label>已命中评分点（点一下改为未命中）</label>
                  {item.effective.hitPoints.length === 0 ? (
                    <span className="hint">（无）</span>
                  ) : (
                    <div className="row">
                      {item.effective.hitPoints.map((p) => (
                        <button
                          key={p}
                          className="badge"
                          disabled={busy || item.status === 'excluded'}
                          onClick={() => void togglePoint(item, p, false)}
                          title="改为未命中"
                        >
                          ✓ {p}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="field">
                  <label>未命中评分点（点一下改为命中）</label>
                  {item.effective.missedPoints.length === 0 ? (
                    <span className="hint">（无）</span>
                  ) : (
                    <div className="row">
                      {item.effective.missedPoints.map((p) => (
                        <button
                          key={p}
                          className="badge"
                          disabled={busy || item.status === 'excluded'}
                          onClick={() => void togglePoint(item, p, true)}
                          title="改为命中"
                        >
                          ✗ {p}
                        </button>
                      ))}
                    </div>
                  )}
                  <span className="hint">
                    翻转评分点需要知道各点分值才能自动重算总分；若软件提示无法重算，
                    请直接手填总分。
                  </span>
                </div>

                <div className="row">
                  <div className="field inline">
                    <label>修正后分数</label>
                    <input
                      type="number"
                      step="0.5"
                      min={0}
                      max={item.fullScore}
                      value={d.score}
                      disabled={busy}
                      onChange={(e) => setDraftField(item.id, 'score', e.target.value, item.effective.score)}
                    />
                  </div>
                  <div className="field inline">
                    <label>复核人（选填）</label>
                    <input
                      value={d.by}
                      disabled={busy}
                      placeholder="姓名或工号"
                      onChange={(e) => setDraftField(item.id, 'by', e.target.value, item.effective.score)}
                    />
                  </div>
                </div>

                <div className="field">
                  <label>修正理由（选填，但建议填写）</label>
                  <input
                    value={d.note}
                    disabled={busy}
                    placeholder="例如：单位换算正确，应给分"
                    onChange={(e) => setDraftField(item.id, 'note', e.target.value, item.effective.score)}
                  />
                </div>

                <div className="row">
                  <button disabled={busy} onClick={() => void saveScore(item)}>
                    保存分数
                  </button>
                  <button disabled={busy} onClick={() => void mark(item, 'confirmed')}>
                    确认模型没错
                  </button>
                  <button disabled={busy} onClick={() => void mark(item, 'excluded')}>
                    该题不参与评分
                  </button>
                  <button
                    disabled={busy || item.status === 'pending'}
                    onClick={() => void remove(item)}
                    title={
                      item.status === 'pending'
                        ? '待复核的条目不能直接删除，请先下结论'
                        : '从队列移除'
                    }
                  >
                    从队列移除
                  </button>
                </div>

                {item.history.length > 0 && (
                  <div className="field">
                    <label>处理历史（{item.history.length} 次）</label>
                    {item.history.map((h, i) => (
                      <p className="hint" key={i}>
                        {fmtTime(h.at)} · {h.by || '未署名'} · {h.fromScore} → {h.toScore}
                        {h.markedHit.length > 0 ? ` · 改为命中：${h.markedHit.join('、')}` : ''}
                        {h.markedMissed.length > 0
                          ? ` · 改为未命中：${h.markedMissed.join('、')}`
                          : ''}
                        {h.note ? ` · ${h.note}` : ''}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}