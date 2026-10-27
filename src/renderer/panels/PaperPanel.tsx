import type { JSX } from 'react';
import { useMemo, useState } from 'react';
import type {
  AICallResult,
  GradeResult,
  ImportedImage,
  PaperReport,
  QuestionType,
} from '@shared/types';
import type { BlankVerdict, GrayStats } from '@shared/blank-paper';
import { classifyBlankPaper } from '@shared/blank-paper';
import type { RawVisionSheet } from '../answer-import';
import { useStore } from '../store';
import {
  type PaperQuestion,
  type ParseOutcome,
  buildResults,
  formatSheetExample,
  parseScoresText,
} from '../paper-entry';
import { buildBatchImport, enumerateSheets, parseVisionSheet } from '../answer-import';
import { buildScoreLine, gradeSubmissionPure, planGrading } from '../grade-pipeline';
import { grayStatsFromDataUrl } from '../gray-stats';

/*
 * 整卷阅卷（批量）与学情分析。
 *
 * ── 这个面板为什么是"粘贴录入"而不是"批量上传答卷图片" ──────────────
 *
 * SPEC F3.4 要求"批量上传答卷图片 → 视觉识别姓名/考号与逐题答案"，
 * 那条链路**尚未实现**。但整卷聚合口径（`main/io/paper.ts`）、
 * 导出（`main/io/export.ts`）都已完成 —— 如果面板什么都不做，
 * 这些能力就锁在柜子里，谁也用不上。
 *
 * 所以这里提供**当前真实可用**的最小入口：粘贴录入 + 逐条校验。
 * 它同时是将来视觉识别的**入口契约**（产出的就是同一份文本格式），
 * 不是一次性的临时脚手架。
 *
 * 界面上必须把这件事写清楚（下方 notice），不能让老师以为
 * "软件支持上传答卷图片识别" —— 那是 §1.2 明令禁止的假话。
 */

/** 题型候选。与 CONTRACT.md 的枚举一一对应 */
const TYPES: Array<{ value: QuestionType; label: string }> = [
  { value: 'choice', label: '选择' },
  { value: 'judge', label: '判断' },
  { value: 'fill', label: '填空' },
  { value: 'short', label: '简答' },
  { value: 'calc', label: '计算' },
  { value: 'essay', label: '论述' },
];

function defaultQuestions(): PaperQuestion[] {
  return [
    { questionId: 'Q1', type: 'choice', fullScore: 5 },
    { questionId: 'Q2', type: 'short', fullScore: 10 },
  ];
}

export function PaperPanel(): JSX.Element {
  const [title, setTitle] = useState('未命名试卷');
  const [questions, setQuestions] = useState<PaperQuestion[]>(defaultQuestions);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<ParseOutcome | null>(null);
  const [report, setReport] = useState<PaperReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // 汇总结果同时发布到 store：学情分析面板据此解读，
  // 而不是自己再算一遍（口径只能有一处）
  const setLastReport = useStore((s) => s.setLastReport);

  const sheet = useMemo(() => ({ questions }), [questions]);

  function setQuestion(idx: number, patch: Partial<PaperQuestion>): void {
    setQuestions((qs) => qs.map((q, i) => (i === idx ? { ...q, ...patch } : q)));
  }

  function addQuestion(): void {
    setQuestions((qs) => [
      ...qs,
      { questionId: `Q${qs.length + 1}`, type: 'short', fullScore: 10 },
    ]);
  }

  function removeQuestion(idx: number): void {
    // 至少留一题：零题的试卷没有任何意义，删空只会让人困惑
    setQuestions((qs) => (qs.length <= 1 ? qs : qs.filter((_, i) => i !== idx)));
  }

  function fillExample(): void {
    setText(formatSheetExample(sheet));
  }

  function doParse(): void {
    setParsed(parseScoresText(text, sheet));
    setReport(null);
    setMessage(null);
  }

  async function aggregate(): Promise<void> {
    if (!parsed) {
      setMessage('请先点「校验并解析」，确认没有错误后再汇总。');
      return;
    }
    // 有错误就拒绝汇总：拿一份已知有问题的数据去汇总，
    // 得到的是一个看起来正常但错的报告（§6.1）
    if (parsed.errors.length > 0) {
      setMessage('存在错误行，已阻止汇总。请先修正上面的错误。');
      return;
    }
    if (parsed.students.length === 0) {
      setMessage('还没有任何成绩。请先录入，再汇总。');
      return;
    }
    setBusy(true);
    try {
      const results = buildResults(parsed.students, sheet);
      const r = await window.gradingExam.paperAggregate({
        paperId: title,
        paperTitle: title,
        results,
        questionsMeta: questions,
      });
      setReport(r);
      setLastReport(r);
      setMessage(`已汇总 ${r.stats.count} 份答卷。`);
    } catch (e) {
      setMessage(`汇总失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportAs(kind: 'excel' | 'markdown'): Promise<void> {
    if (!report) return;
    setBusy(true);
    try {
      const ext = kind === 'excel' ? 'xlsx' : 'md';
      const r =
        kind === 'excel'
          ? await window.gradingExam.exportExcel({
              report,
              outPath: `${title}.${ext}`,
            })
          : await window.gradingExam.exportMarkdown({
              report,
              outPath: `${title}.${ext}`,
            });
      setMessage(r.ok ? `已导出：${r.path ?? ''}` : `导出失败：${r.error ?? '未知原因'}`);
    } catch (e) {
      setMessage(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const st = report?.stats;

  /* ───────────────────── F3.4 批量图片导入 ─────────────────────
   *
   * 流水线：选图（pickFile+readImages）→ 渲染层解码算灰度统计
   * → classifyBlankPaper 拦空白卷 → visionAnswers 逐张识别
   * → parseVisionSheet / buildBatchImport 对齐去重 → 展示核对。
   *
   * 诚实边界（界面必须说清，见下方 notice）：
   *   · 视觉调用 ⚠ 未在真机验证（需真实 API Key + 视觉模型）
   *   · 识别的是答案文本；自动判分未接线，分数仍需人工录入
   */
  interface ImportSlot {
    img: ImportedImage;
    stats: GrayStats | null;
    blank: BlankVerdict;
    width: number | null;
    height: number | null;
  }
  const [slots, setSlots] = useState<ImportSlot[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [readErrors, setReadErrors] = useState<string[]>([]);
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionProgress, setVisionProgress] = useState<{ done: number; total: number } | null>(null);
  const [batch, setBatch] = useState<ReturnType<typeof buildBatchImport> | null>(null);
  const [visionErr, setVisionErr] = useState<string | null>(null);

  function blankLabel(v: BlankVerdict): string {
    if (v === 'blank') return '空白卷·跳过';
    if (v === 'usable') return '可识别';
    return '未测·放行';
  }

  async function pickImages(): Promise<void> {
    setImportBusy(true);
    setImportMsg(null);
    setReadErrors([]);
    setVisionErr(null);
    try {
      const pick = await window.gradingExam.pickFile({
        filters: [{ name: '答卷图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
        multi: true,
      });
      if (pick.canceled || pick.paths.length === 0) return;
      const r = await window.gradingExam.readImages(pick.paths);
      setReadErrors(r.errors ?? []);
      if (!r.ok || !r.images || r.images.length === 0) {
        setImportMsg(r.error ?? '读取图片失败');
        return;
      }
      const next: ImportSlot[] = [];
      for (const img of r.images) {
        // 解码失败 → stats null → unknown → 放行识别（不猜，不拦）
        const dec = await grayStatsFromDataUrl(img.dataUrl);
        next.push({
          img,
          stats: dec?.stats ?? null,
          blank: classifyBlankPaper(dec?.stats ?? null),
          width: dec?.width ?? null,
          height: dec?.height ?? null,
        });
      }
      // 自然排序（photo2 在 photo10 前）：顺序决定无标识卷子的导入序号
      const order = new Map(enumerateSheets(next.map((s) => s.img.fileName)).map((o) => [o.fileName, o.importIndex]));
      next.sort((a, b) => (order.get(a.img.fileName) ?? 0) - (order.get(b.img.fileName) ?? 0));
      setSlots(next);
      setBatch(null);
      const blanks = next.filter((s) => s.blank === 'blank').length;
      setImportMsg(
        `已读入 ${next.length} 张图片` +
          (blanks > 0 ? `，其中 ${blanks} 张判定为空白卷（将跳过识别）` : '') +
          '。建议先「试一张」看识别效果，再「识别全部」。',
      );
    } finally {
      setImportBusy(false);
    }
  }

  async function recognizeOne(img: ImportedImage): Promise<RawVisionSheet> {
    // ImagePart 契约：{ data: 纯 base64, mime }；dataUrl 去掉前缀
    const comma = img.dataUrl.indexOf(',');
    const mime = /^data:([^;]+);/.exec(img.dataUrl)?.[1] ?? 'image/jpeg';
    const base64 = comma >= 0 ? img.dataUrl.slice(comma + 1) : img.dataUrl;
    const r = (await window.gradingExam.aiVisionAnswers({
      images: [{ data: base64, mime }],
      questionCount: questions.length,
    })) as AICallResult;
    if (!r.ok) {
      const why = r.diag?.errorCode ?? (r.diag?.httpStatus != null ? `HTTP ${r.diag.httpStatus}` : '未知原因');
      throw new Error(`${img.fileName}：识别失败（${why}）`);
    }
    // 优先用主进程已解析的 data；没有就退回原文解析（parseVisionSheet 两者都收）
    const parsed = r.data != null ? parseVisionSheet(r.data) : parseVisionSheet(r.text);
    if (!parsed.ok || !parsed.sheet) {
      throw new Error(`${img.fileName}：${parsed.errors.join('；') || '返回内容无法解析'}`);
    }
    return parsed.sheet;
  }

  function applyBatch(sheetsIn: RawVisionSheet[]): void {
    setBatch(buildBatchImport(sheetsIn, questions, title));
  }

  async function trialOne(): Promise<void> {
    const target = slots.find((s) => s.blank !== 'blank');
    if (!target) {
      setVisionErr('没有可识别的图片（全部被判为空白卷）。请确认选对了文件。');
      return;
    }
    setVisionBusy(true);
    setVisionErr(null);
    setImportMsg(null);
    try {
      const sheet = await recognizeOne(target.img);
      applyBatch([sheet]);
      setImportMsg(`试识别完成：${target.img.fileName}。请核对下方结果，确认提示词效果后再识别全部。`);
    } catch (e) {
      setVisionErr(e instanceof Error ? e.message : String(e));
    } finally {
      setVisionBusy(false);
    }
  }

  async function recognizeAll(): Promise<void> {
    const usable = slots.filter((s) => s.blank !== 'blank');
    if (usable.length === 0) {
      setVisionErr('没有可识别的图片（全部被判为空白卷）。');
      return;
    }
    setVisionBusy(true);
    setVisionErr(null);
    setImportMsg(null);
    setVisionProgress({ done: 0, total: usable.length });
    const collected: RawVisionSheet[] = [];
    const failures: string[] = [];
    try {
      for (let i = 0; i < usable.length; i++) {
        try {
          collected.push(await recognizeOne(usable[i]!.img));
        } catch (e) {
          // 单张失败不中断整批 —— 但每一条失败都要让人看到
          failures.push(e instanceof Error ? e.message : String(e));
        }
        setVisionProgress({ done: i + 1, total: usable.length });
      }
      applyBatch(collected);
      setImportMsg(`识别完成：成功 ${collected.length} 张，失败 ${failures.length} 张。`);
      setVisionErr(failures.length > 0 ? failures.join('\n') : null);
    } finally {
      setVisionBusy(false);
      setVisionProgress(null);
    }
  }

  async function copyDrafts(): Promise<void> {
    if (!batch) return;
    const all = batch.submissions.map((s) => s.extractedDraft ?? '').filter((s) => s !== '').join('\n\n');
    try {
      await navigator.clipboard.writeText(all);
      setImportMsg('全部草稿已复制到剪贴板（空白卷的草稿为空，已跳过）。');
    } catch {
      setImportMsg('复制失败（剪贴板权限被拒），请在下方文本框手动全选复制。');
    }
  }

  /* ───────────────── F3.4 自动判分（识别 → 分数 → 成绩行） ─────────────────
   *
   * 分流规则在 grade-pipeline.ts（纯逻辑、可测）。这里的薄绑定只有一件事：
   * 对每个学生的每道主观题调 ai:grade，把 GradeResult 喂回纯函数组装。
   * 产出成绩行后**替换**录入区内容 —— 替换而不是追加：导入批次是当前
   * 工作集，追加会把上一批的手工行混进来；且 parse 校验始终兜底。
   */
  interface GradedOne {
    submissionId: string;
    name: string;
    line: string;
    total: number;
    fullTotal: number;
    reviewCount: number;
  }
  const [graded, setGraded] = useState<GradedOne[] | null>(null);
  const [gradingBusy, setGradingBusy] = useState(false);
  const [gradingProgress, setGradingProgress] = useState<{ done: number; total: number } | null>(null);
  const [gradingMsg, setGradingMsg] = useState<string | null>(null);
  const [gradingErr, setGradingErr] = useState<string | null>(null);

  async function autoGrade(): Promise<void> {
    if (!batch || batch.submissions.length === 0) return;
    setGradingBusy(true);
    setGradingMsg(null);
    setGradingErr(null);
    setGraded(null);

    const plans = batch.submissions.map((sub) => planGrading(sub, questions));
    const total = plans.reduce((n, p) => n + p.items.filter((i) => i.method === 'ai').length, 0);
    setGradingProgress({ done: 0, total });

    const outs: GradedOne[] = [];
    const failures: string[] = [];
    let done = 0;
    try {
      for (let si = 0; si < batch.submissions.length; si++) {
        const sub = batch.submissions[si]!;
        const plan = plans[si]!;
        const aiMap = new Map<string, GradeResult>();
        for (const item of plan.items) {
          if (item.method !== 'ai') continue;
          const q = questions[item.index - 1]!;
          try {
            const r = (await window.gradingExam.aiGrade({
              question: {
                stem: `第${item.index}题（${TYPES.find((t) => t.value === item.type)?.label ?? item.type}，满分${item.fullScore}）`,
                fullScore: item.fullScore,
                referenceAnswer: q.referenceAnswer ?? '',
                scoringPoints: q.scoringPoints ?? [],
                subject: q.subject,
              },
              answerText: item.studentText ?? '',
            })) as AICallResult;
            if (r.ok && r.grade) {
              aiMap.set(item.questionId, r.grade);
            } else {
              failures.push(`${sub.id} 第${item.index}题：${r.diag?.errorCode ?? '未返回评分结果'}`);
            }
          } catch (e) {
            failures.push(`${sub.id} 第${item.index}题：${e instanceof Error ? e.message : String(e)}`);
          }
          done++;
          setGradingProgress({ done, total });
        }
        const out = gradeSubmissionPure(sub, questions, aiMap, Date.now());
        outs.push({
          submissionId: out.result.submissionId,
          name: out.result.name,
          line: buildScoreLine(out.result, questions),
          total: out.result.total,
          fullTotal: out.result.fullTotal,
          reviewCount: out.result.details.filter((d) => d.reviewRequested).length,
        });
      }
      setGraded(outs);
      setGradingMsg(
        `判分完成：${outs.length} 人。` +
          (failures.length > 0
            ? `${failures.length} 次 AI 调用失败 —— 对应题按「未评分」计入并强制复核，不会静默当 0 分。`
            : '请逐人核对后填入录入框。'),
      );
      setGradingErr(failures.length > 0 ? failures.join('\n') : null);
    } finally {
      setGradingBusy(false);
      setGradingProgress(null);
    }
  }

  function fillFromGraded(): void {
    if (!graded || graded.length === 0) return;
    setText(graded.map((g) => g.line).join('\n'));
    setParsed(null);
    setReport(null);
    setGradingMsg('成绩行已填入下方录入框（已替换原内容）。请点「校验并解析」核对后再汇总。');
  }

  return (
    <div className="card">
      <h2>整卷阅卷（批量）</h2>

      {/*
        诚实声明（§1.2）：说清"能做什么"和"还没验证什么"，两头都不许夸大。
        ① 图片识别已接入，但视觉模型调用未在真机验证过（无真实 API Key）；
        ② 识别产出的是答案文本，自动判分（客观题比对/主观题 AI）尚未接线，
           分数仍需老师按识别结果人工录入 —— 不写这条，老师会以为
           "传了图就能出成绩单"。
      */}
      <div className="notice">
        本面板支持两路录入：<strong>粘贴成绩</strong>（下方，逐条校验）或
        <strong>上传答卷图片识别答案</strong>（本区，识别结果需人工核对）。
        ⚠ 图片识别的视觉模型调用<strong>未在真机验证过</strong>（需要真实 API Key
        与支持视觉的模型）；识别的是<strong>答案文本</strong>，
        自动判分尚未接线 —— 分数仍需人工录入。
      </div>

      {/* ------------------------------------------------ 试卷信息与题目 */}
      <div className="field">
        <label>试卷名称</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="例如：高一数学第一次月考"
        />
      </div>

      <div className="row">
        <strong>题目定义</strong>
        <span className="spacer" />
        <button type="button" onClick={addQuestion}>
          加一题
        </button>
      </div>

      {questions.map((q, i) => (
        <div className="row" key={`${q.questionId}-${i}`}>
          <input
            type="text"
            className="mono"
            value={q.questionId}
            onChange={(e) => setQuestion(i, { questionId: e.target.value })}
            aria-label={`第 ${i + 1} 题题号`}
          />
          <select
            value={q.type}
            onChange={(e) => setQuestion(i, { type: e.target.value as QuestionType })}
            aria-label={`第 ${i + 1} 题题型`}
          >
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <input
            type="number"
            className="num"
            min={0}
            step={0.5}
            value={q.fullScore}
            onChange={(e) => setQuestion(i, { fullScore: Number(e.target.value) })}
            aria-label={`第 ${i + 1} 题满分`}
          />
          <button type="button" onClick={() => removeQuestion(i)} disabled={questions.length <= 1}>
            删除
          </button>
        </div>
      ))}

      {/* 每题第二行：判分依据输入（F3.4 自动判分用）。
          客观题没参考答案就不给自动判分（grade-pipeline 标"无法判分"，
          绝不交给模型猜）；主观题得分点缺失只警告不拦截。 */}
      {questions.map((q, i) => (
        <div className="row" key={`meta-${i}`}>
          {q.type === 'choice' || q.type === 'judge' || q.type === 'fill' ? (
            <>
              <span className="dim">参考答案</span>
              <input
                type="text"
                className="mono"
                value={q.referenceAnswer ?? ''}
                onChange={(e) => setQuestion(i, { referenceAnswer: e.target.value })}
                placeholder="如 B / 对 / 3（不填则该题无法自动判分）"
                aria-label={`第 ${i + 1} 题参考答案`}
              />
            </>
          ) : (
            <>
              <span className="dim">评分要点</span>
              <input
                type="text"
                className="mono"
                value={(q.scoringPoints ?? []).join('；')}
                onChange={(e) =>
                  setQuestion(i, {
                    scoringPoints: e.target.value
                      .split(/[;；]/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
                placeholder="用；分隔，可留空（缺失时 AI 评分依据不足，会提示）"
                aria-label={`第 ${i + 1} 题评分要点`}
              />
            </>
          )}
        </div>
      ))}

      {/* ------------------------------------------------ F3.4 批量图片导入 */}
      <div className="row">
        <strong>批量图片导入（识别答案）</strong>
        <span className="spacer" />
        <button type="button" onClick={() => void pickImages()} disabled={importBusy || visionBusy}>
          {importBusy ? '读取中…' : '选择答卷图片…'}
        </button>
        <button
          type="button"
          onClick={() => void trialOne()}
          disabled={importBusy || visionBusy || slots.length === 0}
        >
          先试一张
        </button>
        <button
          type="button"
          onClick={() => void recognizeAll()}
          disabled={importBusy || visionBusy || slots.length === 0}
        >
          识别全部
        </button>
      </div>

      {importMsg && <div className="dim">{importMsg}</div>}
      {readErrors.length > 0 && (
        <div className="warn-line">
          <strong>{readErrors.length} 个文件读取失败：</strong>
          <ul>
            {readErrors.slice(0, 6).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {slots.length > 0 && (
        <div className="field">
          <label>已选图片（空白卷不消耗 token，直接跳过）</label>
          {slots.map((s) => (
            <div className="row" key={s.img.fileName}>
              <span className="mono">{s.img.fileName}</span>
              <span className="dim">
                {s.width ?? '?'}×{s.height ?? '?'} · {(s.img.bytes / 1024).toFixed(0)} KB
              </span>
              <span className="badge">{blankLabel(s.blank)}</span>
            </div>
          ))}
        </div>
      )}

      {visionProgress && (
        <div className="dim">
          识别中 {visionProgress.done}/{visionProgress.total} …（逐张顺序调用，失败不影响后续）
        </div>
      )}
      {visionErr && (
        <div className="warn-line">
          <div>识别出现问题：</div>
          <div>{visionErr}</div>
        </div>
      )}

      {batch && (
        <div className="result">
          <div className="result-head">
            <strong>识别结果（{batch.submissions.length} 人，需逐条人工核对）</strong>
            <span className="spacer" />
            <button type="button" onClick={() => void copyDrafts()}>
              复制全部草稿
            </button>
          </div>
          {batch.warnings.length > 0 && (
            <div className="warn-line">
              <ul>
                {batch.warnings.slice(0, 10).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}
          {batch.submissions.map((sub, i) => {
            const a = batch.alignments[i];
            return (
              <div className="field" key={sub.id}>
                <div className="row">
                  <strong>{sub.id}</strong>
                  <span className="dim">
                    姓名：{sub.name || '（未识别）'} · 考号：{sub.examNo || '（未识别）'} ·
                    识别到 {sub.answers.length}/{questions.length} 题
                  </span>
                  {a?.needsReview && <span className="badge">需核对</span>}
                </div>
                {sub.answers.length > 0 && (
                  <div className="mono">
                    {sub.answers.map((ans) => (
                      <div key={ans.questionId}>
                        {ans.questionId}: {ans.text.slice(0, 80)}
                        {ans.text.length > 80 ? '…' : ''}
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  rows={2}
                  className="mono"
                  readOnly
                  value={sub.extractedDraft ?? ''}
                  aria-label={`${sub.id} 的识别草稿`}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* ------------------------------------------------ 自动判分（F3.4 收尾） */}
      {batch && (
        <>
          <div className="row">
            <strong>自动判分</strong>
            <span className="dim">
              客观题本地比对（零 token）· 主观题 AI 评分 · 缺参考答案的题标「无法判分」，绝不交给模型猜
            </span>
            <span className="spacer" />
            <button
              type="button"
              onClick={() => void autoGrade()}
              disabled={gradingBusy || visionBusy || importBusy}
            >
              {gradingBusy ? '判分中…' : '自动判分（全部学生）'}
            </button>
          </div>
          {gradingProgress && (
            <div className="dim">
              AI 评分中 {gradingProgress.done}/{gradingProgress.total} …（逐题顺序调用）
            </div>
          )}
          {gradingMsg && <div className="dim">{gradingMsg}</div>}
          {gradingErr && (
            <div className="warn-line">
              <div>以下 AI 调用失败（对应题按「未评分」计入，不是 0 分）：</div>
              <div>{gradingErr}</div>
            </div>
          )}
          {graded && graded.length > 0 && (
            <div className="result">
              <div className="result-head">
                <strong>判分结果（{graded.length} 人）</strong>
                <span className="spacer" />
                <button type="button" onClick={fillFromGraded}>
                  把成绩行填入下方录入框（替换）
                </button>
              </div>
              {graded.map((g) => (
                <div className="row" key={g.submissionId}>
                  <span className="mono">{g.name || g.submissionId}</span>
                  <span className="num">
                    {g.total}/{g.fullTotal}
                  </span>
                  {g.reviewCount > 0 && <span className="badge">{g.reviewCount} 题需复核</span>}
                  <span className="spacer" />
                  <span className="mono dim">{g.line}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ------------------------------------------------ 成绩录入 */}
      <div className="row">
        <strong>学生成绩录入</strong>
        <span className="spacer" />
        <button type="button" onClick={fillExample}>
          填入格式示例
        </button>
        <button type="button" onClick={doParse}>
          校验并解析
        </button>
      </div>

      <div className="field">
        <label>
          每行一份成绩：姓名,考号,{questions.map((q) => q.questionId).join(',')}
          （未填的题留空或写 -，会按"未录入"标记需复核）
        </label>
        <textarea
          rows={8}
          className="mono"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={formatSheetExample(sheet)}
        />
      </div>

      {parsed && (
        <>
          {parsed.errors.length > 0 && (
            <div className="warn-line">
              <strong>发现 {parsed.errors.length} 处错误（已阻止汇总）：</strong>
              <ul>
                {parsed.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          )}
          {parsed.errors.length === 0 && parsed.warnings.length > 0 && (
            <div className="warn-line">
              <strong>{parsed.warnings.length} 处提醒：</strong>
              <ul>
                {parsed.warnings.slice(0, 8).map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
              {parsed.warnings.length > 8 && <div className="dim">（其余省略）</div>}
            </div>
          )}
          <div className="dim">
            已解析 {parsed.students.length} 份成绩
            {parsed.errors.length > 0 ? '（有错误的行未计入）' : ''}。
          </div>
        </>
      )}

      <div className="row">
        <button type="button" onClick={() => void aggregate()} disabled={busy}>
          汇总统计
        </button>
        <button type="button" onClick={() => void exportAs('excel')} disabled={!report || busy}>
          导出 Excel
        </button>
        <button type="button" onClick={() => void exportAs('markdown')} disabled={!report || busy}>
          导出 Markdown
        </button>
        <span className="spacer" />
        {message && <span className="dim">{message}</span>}
      </div>

      {/* ------------------------------------------------ 报告展示 */}
      {!report && (
        <div className="empty-state">
          <div>还没有汇总结果</div>
          <div className="dim">
            定义题目 → 录入成绩 → 校验解析 → 汇总统计。汇总后可导出 Excel 或 Markdown。
          </div>
        </div>
      )}

      {report && st && (
        <>
          {/* 数据问题必须显眼：数字有没有问题，比数字本身更重要 */}
          {(st.numberValid === false || st.mixedFullScore) && (
            <div className="warn-line">
              {st.numberValid === false && (
                <div>存在总分超出 [0, 满分] 的答卷，平均值不可信。</div>
              )}
              {st.mixedFullScore && (
                <div>本次答卷的满分不一致，统计以满分 {st.fullTotal} 为基准。</div>
              )}
            </div>
          )}

          <div className="result">
            <div className="result-head">
              <strong>总览</strong>
              <span className="spacer" />
              <span className="badge">{st.count} 人</span>
            </div>
            <div className="grid3">
              <div>
                <div className="dim">平均分</div>
                <div className="num">
                  {/* null → 「—」：写成 0 会被读成"全班 0 分" */}
                  {st.average === null ? '—' : st.average.toFixed(2)}
                </div>
              </div>
              <div>
                <div className="dim">最高 / 最低</div>
                <div className="num">
                  {st.max === null ? '—' : st.max} / {st.min === null ? '—' : st.min}
                </div>
              </div>
              <div>
                <div className="dim">及格率</div>
                <div className="num">
                  {st.passRate === null ? '—' : `${(st.passRate * 100).toFixed(1)}%`}
                </div>
              </div>
            </div>
          </div>

          <div className="result">
            <div className="result-head">
              <strong>分数分布</strong>
              <span className="dim">（按得分率分箱，跨满分制可比）</span>
            </div>
            {st.distribution.map((b) => (
              <div className="row" key={b.bucket}>
                <span className="mono">{b.bucket}</span>
                <span className="dim">{'█'.repeat(Math.min(b.count, 40))}</span>
                <span className="num">{b.count} 人</span>
              </div>
            ))}
          </div>

          <div className="result">
            <div className="result-head">
              <strong>分层统计（按题型）</strong>
              <span className="dim">客观题与主观题不合并为一个准确率</span>
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
                {st.byType.map((t) => (
                  <tr key={t.type}>
                    <td>{TYPES.find((x) => x.value === t.type)?.label ?? t.type}</td>
                    <td className="num">{t.count}</td>
                    <td className="num">
                      {t.avgScoreRate === null ? '—' : `${(t.avgScoreRate * 100).toFixed(1)}%`}
                    </td>
                    <td className="num">{(t.reviewRate * 100).toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {st.lossRanking.length > 0 && (
            <div className="result">
              <div className="result-head">
                <strong>高频失分点</strong>
              </div>
              {st.lossRanking.slice(0, 12).map((l) => (
                <div className="row" key={l.point}>
                  <span>{l.point}</span>
                  <span className="spacer" />
                  <span className="num">{l.count} 次</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}