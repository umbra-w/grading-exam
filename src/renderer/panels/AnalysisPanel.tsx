import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import { useStore } from '../store';
import {
  MIN_SAMPLE_FOR_CONCLUSION,
  adviceSummary,
  buildTeachingAdvice,
  describeStatsProblems,
  typeLabel,
} from '../analysis';

/*
 * 学情分析（SPEC F4.1 / F4.2）。
 *
 * ── 这个面板为什么只是"解读"而不是自己算 ─────────────────────────
 *
 * 分布直方图、失分点聚合、分层统计都由 `main/io/paper.ts` 算好并随
 * `PaperReport` 一起过来（「整卷阅卷」汇总后发布到 store）。
 * 这里不再算一遍 —— 聚合口径（及格线、分箱、分层）必须只有一处实现，
 * 否则两个面板会在某个边界上给出不一致的数字，而那种不一致**不会报错**。
 *
 * ── 底线：不给没有依据的建议 ─────────────────────────────────────
 *
 * 建议由 `analysis.ts` 生成，每条都强制带 `evidence`（含具体数字）。
 * 数据不可信或样本不足时，**明确说出来并停止解读**，而不是照样推荐
 * "多练习某题型" —— 那种建议会把老师的注意力引向一个不存在的问题。
 */

const SEVERITY_TEXT: Record<string, string> = {
  high: '需先处理',
  medium: '建议关注',
  low: '供参考',
};

export function AnalysisPanel(): JSX.Element {
  const report = useStore((s) => s.lastReport);
  const setPage = useStore((s) => s.setPage);
  const [exporting, setExporting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const stats = report?.stats ?? null;

  const advice = useMemo(() => (stats ? buildTeachingAdvice(stats) : []), [stats]);

  async function exportReport(): Promise<void> {
    if (!report) return;
    setExporting(true);
    try {
      const r = await window.gradingExam.exportMarkdown({
        report,
        outPath: `${report.paperTitle || '学情报告'}.md`,
      });
      setMessage(r.ok ? `已导出：${r.path ?? ''}` : `导出失败：${r.error ?? '未知原因'}`);
    } catch (e) {
      setMessage(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(false);
    }
  }

  // ── 还没有数据：指路，而不是显示一张空表
  if (!report || !stats) {
    return (
      <div className="card">
        <h2>学情分析</h2>
        <div className="empty-state">
          <div>还没有可分析的整卷数据</div>
          <div className="dim">
            整卷阅卷负责产出数据，学情分析负责解读它。请先在「整卷阅卷」里
            定义题目、录入成绩并汇总，这里就会出现失分点排序、教学建议与报告导出。
          </div>
          <button type="button" onClick={() => setPage('paper')}>
            去整卷阅卷
          </button>
        </div>
      </div>
    );
  }

  const problems = describeStatsProblems(stats);

  return (
    <div className="card">
      <h2>学情分析</h2>

      <div className="notice">
        本页是对「整卷阅卷」汇总结果的解读，指标口径与该页一致（及格线按
        <strong>归一化得分率</strong> 60%）。客观题与主观题的判定方式不同，
        这里<strong>不</strong>把它们合并成一个总体准确率。
      </div>

      <div className="row">
        <span className="badge">{report.paperTitle}</span>
        <span className="dim">{adviceSummary(stats)}</span>
        <span className="spacer" />
        <button type="button" onClick={() => setPage('paper')}>
          回到整卷阅卷
        </button>
        <button type="button" onClick={() => void exportReport()} disabled={exporting}>
          导出学情报告（Markdown）
        </button>
      </div>
      {message && <div className="dim">{message}</div>}

      {/* 数据问题必须先摆出来 —— 否则下面的建议会被当成基于可信数字的结论 */}
      {problems.length > 0 && (
        <div className="warn-line">
          <strong>⚠️ 本次数据存在问题：</strong>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ------------------------------------------------ 教学建议 */}
      <div className="result">
        <div className="result-head">
          <strong>教学建议</strong>
          <span className="dim">每条都附带数据依据</span>
        </div>
        {advice.map((a) => (
          <div key={a.code} className="row">
            <span className="badge">{SEVERITY_TEXT[a.severity] ?? a.severity}</span>
            <div>
              <strong>{a.title}</strong>
              <div>{a.detail}</div>
              {/* 依据单独一行：让老师能自己复核这条结论是怎么来的 */}
              <div className="dim mono">依据：{a.evidence}</div>
            </div>
          </div>
        ))}
      </div>

      {/* ------------------------------------------------ 失分点 TOP 榜 */}
      <div className="result">
        <div className="result-head">
          <strong>失分点排行</strong>
          <span className="dim">
            按出现次数；同一次作答里的重复失分点只计一次
          </span>
        </div>
        {stats.lossRanking.length === 0 ? (
          <div className="dim">
            本次没有失分点记录。整卷手工录入的成绩没有逐点判定，因此不会产生
            失分点 —— 需要通过 AI 批改（单题面板）或将来接上的答卷图片识别才会有的数据。
          </div>
        ) : (
          stats.lossRanking.slice(0, 20).map((l) => (
            <div className="row" key={l.point}>
              <span>{l.point}</span>
              <span className="spacer" />
              <span className="num">{l.count} 次</span>
              <span className="dim">
                {stats.count > 0 ? `${((l.count / stats.count) * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
          ))
        )}
      </div>

      {/* ------------------------------------------------ 分层统计 */}
      <div className="result">
        <div className="result-head">
          <strong>分层统计</strong>
          <span className="dim">只含本次实际出现过的题型</span>
        </div>
        <table className="mono">
          <thead>
            <tr>
              <th>题型</th>
              <th>题次数</th>
              <th>平均得分率</th>
              <th>需复核率</th>
            </tr>
          </thead>
          <tbody>
            {stats.byType.map((t) => (
              <tr key={t.type}>
                <td>{typeLabel(t.type)}</td>
                <td className="num">{t.count}</td>
                <td className="num">
                  {t.avgScoreRate === null ? '—' : `${(t.avgScoreRate * 100).toFixed(1)}%`}
                </td>
                <td className="num">{(t.reviewRate * 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="dim">
          样本量下限 {MIN_SAMPLE_FOR_CONCLUSION} 份：低于它时得分率的随机波动
          大于真实的班级差异，因此不给教学结论。
        </div>
      </div>

      {/* ------------------------------------------------ 分数分布 */}
      <div className="result">
        <div className="result-head">
          <strong>分数分布</strong>
          <span className="dim">按得分率分箱，跨满分制可比</span>
        </div>
        {stats.distribution.map((b) => (
          <div className="row" key={b.bucket}>
            <span className="mono">{b.bucket}</span>
            <span className="dim">{'█'.repeat(Math.min(b.count, 40))}</span>
            <span className="num">{b.count} 人</span>
          </div>
        ))}
      </div>
    </div>
  );
}