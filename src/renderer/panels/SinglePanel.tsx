import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type {
  AICallResult,
  GradeResult,
  ImagePart,
  ObjectiveVerdictResult,
  ParseResult,
  QuestionType,
} from '@shared/types';

/**
 * 单题批改面板（Phase 4）。
 *
 * 设计上的一条主线：**让"两条评分路径"在界面上也分得清**。
 *   · 客观题 → 本地比对，零网络零 token，结果确定可复现
 *   · 主观题 → AI 评分，消耗 token，结果带置信度与复核建议
 * 如果把它们糊成一个"开始评分"按钮，教师就永远不知道哪次花了自己钱、
 * 哪次的结果本该是 100% 可复现的。所以这里明确分成两张卡。
 *
 * 另一条主线：**失败必须看得见**。文件解析失败、AI 调用失败、
 * 低置信度、疑似写法差异，全部在界面上有明确落点，不写进控制台了事。
 */

type RubricSource = 'manual' | 'file' | 'parsed';

const TYPE_OPTIONS: Array<{ v: QuestionType; label: string; objective: boolean }> = [
  { v: 'choice', label: '选择', objective: true },
  { v: 'judge', label: '判断', objective: true },
  { v: 'fill', label: '填空', objective: true },
  { v: 'short', label: '简答', objective: false },
  { v: 'calc', label: '计算', objective: false },
  { v: 'essay', label: '论述', objective: false },
];

/** 客观题判定的中文与配色。集中一处，避免各处自己拼字符串拼错 */
const VERDICT_UI: Record<
  ObjectiveVerdictResult['verdict'],
  { label: string; badge: string; desc: string }
> = {
  correct: { label: '正确', badge: 'green', desc: '归一化后与标准答案一致' },
  correct_alt: { label: '正确（备选答案）', badge: 'green', desc: '命中教师录入的备选答案' },
  blank: { label: '未作答', badge: 'gray', desc: '学生没有作答，与「做错」分开统计' },
  wrong: { label: '错误', badge: 'amber', desc: '归一化后与标准答案不一致' },
  suspect: { label: '疑似（需人工确认）', badge: 'pink', desc: '写法差异，本路径不自动给分' },
};

export function SinglePanel(): JSX.Element {
  const pushLog = useStore((s) => s.appendLog);

  /* ---------------------------------------------------- 评分标准（P4-1） */
  const [rubricSource, setRubricSource] = useState<RubricSource>('manual');
  const [qType, setQType] = useState<QuestionType>('calc');
  const [stem, setStem] = useState('');
  const [fullScore, setFullScore] = useState(10);
  const [reference, setReference] = useState('');
  const [pointsText, setPointsText] = useState('');
  /** 客观题标准答案（本地比对用） */
  const [objectiveAnswer, setObjectiveAnswer] = useState('');
  /** 备选答案：每行一个 */
  const [acceptableText, setAcceptableText] = useState('');

  const [parsed, setParsed] = useState<ParseResult | null>(null);
  const [parsing, setParsing] = useState(false);
  const [optimizing, setOptimizing] = useState(false);
  const [optDetails, setOptDetails] = useState<{ correct: string[]; incorrect: string[] } | null>(null);

  /* ------------------------------------------------------ 学生答案（P4-4） */
  const [answerText, setAnswerText] = useState('');
  const [name, setName] = useState('');
  const [examNo, setExamNo] = useState('');
  const [images, setImages] = useState<ImagePart[]>([]);

  /* ------------------------------------------------------- 结果与状态 */
  const [grade, setGrade] = useState<GradeResult | null>(null);
  const [objective, setObjective] = useState<ObjectiveVerdictResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const imageInput = useRef<HTMLInputElement | null>(null);

  const typeMeta = TYPE_OPTIONS.find((t) => t.v === qType)!;
  const isObjective = typeMeta.objective;


  async function onOptimizeCriteria(): Promise<void> {
    const raw = reference.trim() || pointsText.trim() || stem.trim();
    if (!raw) {
      log('warn', '请先填写参考答案或题干，再进行细则扩充');
      return;
    }
    setOptimizing(true);
    log('info', 'AI 正在分析并扩充评分细则...');
    try {
      const res = await window.gradingExam.aiOptimizeCriteria({
        rawCriteria: `参考答案：${reference}\n题干：${stem}\n现有细则：${pointsText}`,
        fullScore,
      });
      if (res.ok && res.result) {
        setPointsText(res.result.scoringPoints.join('\n'));
        setOptDetails({
          correct: res.result.supplementaryCorrect,
          incorrect: res.result.supplementaryIncorrect,
        });
        log('ok', `细则扩充成功，生成 ${res.result.scoringPoints.length} 个采分要点`);
      } else {
        log('warn', res.error || '细则扩充未返回有效结构');
      }
    } catch (err) {
      log('error', '细则扩充失败: ' + String(err));
    } finally {
      setOptimizing(false);
    }
  }

  function log(level: 'info' | 'warn' | 'error' | 'ok', message: string): void {
    pushLog({ ts: Date.now(), level, message });
  }

  /**
   * 切换题型时清掉不适用路径的残留结果。
   *
   * 为什么必须清：客观题切到主观题后，如果旧的"本地比对：正确"
   * 还挂在屏幕上，教师会以为当前这题已经判过了。
   * 这是"界面说了假话"的典型——结果是上一个配置的。
   */
  function changeType(next: QuestionType): void {
    setQType(next);
    setObjective(null);
    setGrade(null);
    setError(null);
  }

  /* ------------------------------------------------------- P4-1 上传解析 */
  async function pickAndParse(): Promise<void> {
    const picked = await window.gradingExam.pickFile({
      filters: [{ name: '试卷文件', extensions: ['docx', 'pdf', 'txt', 'md', 'markdown'] }],
    });
    if (picked.canceled || picked.paths.length === 0) return;

    setParsing(true);
    setError(null);
    try {
      const r = await window.gradingExam.parseFile(picked.paths[0]);
      setParsed(r);
      if (!r.ok) {
        // 失败原因直接展示；不同的 code 后续可给不同的操作建议
        setError(r.message);
        log('warn', `解析失败（${r.code}）：${r.message}`);
      } else {
        // 解析成功不自动覆盖手动内容——教师可能已经手打了题干
        log('ok', `已解析 ${r.name}，${r.charCount} 字`);
        for (const w of r.warnings) log('warn', `${r.name}：${w.message}`);
      }
    } finally {
      setParsing(false);
    }
  }

  /** 把解析出的文本送 AI 拆成结构化题目（Phase 4 P4-3） */
  async function parseWithAI(): Promise<void> {
    const text = parsed?.ok ? parsed.text : '';
    if (!text.trim()) {
      setError('请先上传并成功解析一个文件，再让 AI 拆题。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r: AICallResult = await window.gradingExam.aiParsePaper({ rawText: text });
      if (!r.ok) {
        setError(r.diag.rawSnippet ?? r.diag.errorCode ?? 'AI 拆题失败，请查看日志了解原因。');
        log('error', 'AI 拆题失败');
        return;
      }
      // 把 AI 结果填进表单，但**保留教师已填的内容**：
      // AI 只是助手，最终以人填的为准
      log('ok', 'AI 已拆出题目结构，请核对后再修改');
      setRubricSource('parsed');
      setStem((prev) => prev || text.slice(0, 800));
    } finally {
      setBusy(false);
    }
  }

  /* ------------------------------------------------------- P4-4 图片粘贴 */
  async function onPickImages(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    const next: ImagePart[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const buf = await f.arrayBuffer();
      // 转 base64：IPC 只能传可序列化数据。
      // 逐块处理而不是 String.fromCharCode(...u8)：答案截图动辄几 MB，
      // 展开成几百万个参数会直接栈溢出（RangeError: Maximum call stack size exceeded）。
      const u8 = new Uint8Array(buf);
      let bin = '';
      const CHUNK = 0x8000;
      for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode(...u8.subarray(i, i + CHUNK));
      }
      next.push({ data: btoa(bin), mime: f.type });
    }
    if (next.length === 0) {
      setError('拖入的不是图片文件。');
      return;
    }
    setImages((prev) => [...prev, ...next]);
    log('info', `已加入 ${next.length} 张答案图片`);
  }

  /* --------------------------------------------------- 评分：客观题本地 */
  async function runObjective(): Promise<void> {
    if (!objectiveAnswer.trim()) {
      setError('客观题需要先填「标准答案」才能本地比对。');
      return;
    }
    if (!answerText.trim()) {
      setError('请先输入学生答案。');
      return;
    }
    setBusy(true);
    setError(null);
    setGrade(null);
    try {
      const acceptable = acceptableText
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      const r = await window.gradingExam.compareObjective({
        student: answerText,
        expected: objectiveAnswer,
        ...(acceptable.length ? { acceptable } : {}),
      });
      setObjective(r);
      log(
        r.needsReview ? 'warn' : 'ok',
        `本地比对：${VERDICT_UI[r.verdict].label}${r.needsReview ? '（需人工复核）' : ''}`,
      );
    } finally {
      setBusy(false);
    }
  }

  /* ----------------------------------------------------- 评分：主观题 AI */
  async function runAI(): Promise<void> {
    if (!stem.trim()) {
      setError('请先填写题干。');
      return;
    }
    if (!reference.trim() && pointsText.trim() === '') {
      setError('请至少填写参考答案或得分点，否则 AI 没有评分依据。');
      return;
    }
    if (!answerText.trim() && images.length === 0) {
      setError('请先输入学生答案（文本或图片）。');
      return;
    }
    setBusy(true);
    setError(null);
    setObjective(null);
    try {
      const r = await window.gradingExam.aiGrade({
        question: {
          stem,
          fullScore,
          referenceAnswer: reference,
          scoringPoints: pointsText
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        },
        answerText,
        ...(images.length ? { images } : {}),
      });
      if (!r.ok || !r.grade) {
        // 失败不伪造结果：明确报错，保留教师已填内容
        setError(r.diag.rawSnippet ?? r.diag.errorCode ?? 'AI 评分失败，请查看日志。');
        log('error', 'AI 评分失败');
        return;
      }
      const g = r.grade;
      setGrade(g);
      // 0 分走同一条成功路径 —— 它就是正常结果，不是失败。
      // 历史上有过把 0 分当"没解析出结果"处理的做法，那会让真实 0 分学生被漏掉。
      log(
        g.reviewRequested ? 'warn' : 'ok',
        `AI 评分完成：${g.score}/${fullScore}，置信度 ${g.confidence.toFixed(2)}` +
          (g.reviewRequested ? '（建议复核）' : ''),
      );
      for (const w of g.warnings) log('warn', w);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // 题型切换后把"不该出现的路径"清干净，避免旧结果留在屏幕上
    setError(null);
  }, [qType]);

  return (
    <>
      {/* 说明条：把两条路径的成本差异摆在最前面 */}
      <div className="card">
        <h2>智能阅卷（单题批改）</h2>
        <p className="hint">
          客观题走<b>本地比对</b>（零网络、零 token、结果可复现）；
          主观题走 <b>AI 评分</b>（消耗 token，返回置信度与复核建议）。
          两条路径分开，是为了让你清楚每次操作花了什么。
        </p>
      </div>

      {/* ---------------- 评分标准 ---------------- */}
      <div className="card">
        <h2>① 评分标准</h2>

        <div className="field">
          <label>题型</label>
          <select value={qType} onChange={(e) => changeType(e.target.value as QuestionType)}>
            {TYPE_OPTIONS.map((t) => (
              <option key={t.v} value={t.v}>
                {t.label}
                {t.objective ? '（本地比对）' : '（AI 评分）'}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>满分</label>
          <input
            type="number"
            min={0.5}
            step={0.5}
            value={fullScore}
            onChange={(e) => setFullScore(Number(e.target.value) || 0)}
          />
          {fullScore <= 0 && <span className="badge amber">满分必须大于 0</span>}
        </div>

        <div className="field">
          <label>录入方式</label>
          <div className="segmented">
            {(
              [
                ['manual', '手动输入'],
                ['file', '上传试卷文件'],
                ['parsed', 'AI 拆题后编辑'],
              ] as Array<[RubricSource, string]>
            ).map(([v, label]) => (
              <button
                key={v}
                className={rubricSource === v ? 'seg active' : 'seg'}
                onClick={() => setRubricSource(v)}
                disabled={v === 'parsed' && !parsed?.ok}
                title={v === 'parsed' && !parsed?.ok ? '需要先成功解析一个文件' : label}
              >
                {label}
              </button>
            ))}
          </div>
          {/* 切换录入方式**不清空已填内容**：教师可能手打了一半又想去传文件，
              传完还想回来接着改。清空等于让人白干且无法撤销。 */}
          <p className="hint">切换录入方式不会清空已填内容。</p>
        </div>

        {rubricSource !== 'manual' && (
          <>
            <div className="row">
              <button onClick={() => void pickAndParse()} disabled={parsing || busy}>
                {parsing ? '解析中…' : '选择文件并解析'}
              </button>
              <button onClick={() => void parseWithAI()} disabled={!parsed?.ok || busy}>
                让 AI 拆题
              </button>
              <span className="hint">支持 .docx .pdf .txt .md（不做 OCR）</span>
            </div>

            {parsed && !parsed.ok && (
              <div className="notice err">
                <b>解析失败（{parsed.code}）</b>
                <div>{parsed.message}</div>
              </div>
            )}

            {parsed?.ok && (
              <div className="notice">
                <b>
                  已解析 {parsed.name}
                  {parsed.pageCount ? `（${parsed.pageCount} 页）` : ''}，{parsed.charCount} 字
                </b>
                {parsed.warnings.map((w) => (
                  <div key={w.code} className="warn-line">
                    ⚠ {w.message}
                  </div>
                ))}
                <details>
                  <summary>查看解析文本</summary>
                  <pre className="text-preview">{parsed.text.slice(0, 4000)}</pre>
                </details>
              </div>
            )}
          </>
        )}

        <div className="field">
          <label>题干</label>
          <textarea
            rows={3}
            value={stem}
            onChange={(e) => setStem(e.target.value)}
            placeholder="例如：求碳酸钙（CaCO₃）的摩尔质量，写出计算过程。"
          />
        </div>

        {isObjective ? (
          <>
            <div className="field">
              <label>标准答案</label>
              <input
                value={objectiveAnswer}
                onChange={(e) => setObjectiveAnswer(e.target.value)}
                placeholder="选择题填字母（如 B）；填空填答案原文"
              />
            </div>
            <div className="field">
              <label>备选答案（每行一个，可选）</label>
              <textarea
                rows={2}
                value={acceptableText}
                onChange={(e) => setAcceptableText(e.target.value)}
                placeholder={'3\n三\n叁'}
              />
              <p className="hint">
                同一题的不同正确写法。这是<b>题目级</b>的宽松，不要靠它掩盖比对规则的问题。
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>参考答案</label>
              <textarea
                rows={3}
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="完整的参考答案"
              />
            </div>
            <div className="field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={{ margin: 0 }}>得分点（每行一个）</label>
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ padding: '2px 8px', fontSize: '12px' }}
                  onClick={() => void onOptimizeCriteria()}
                  disabled={optimizing || busy}
                  title="根据参考答案自动拆解得分点、补充正确/错误情形"
                >
                  {optimizing ? '✨ 细则扩充中…' : '✨ AI 智能扩充细则'}
                </button>
              </div>
              <textarea
                rows={4}
                value={pointsText}
                onChange={(e) => setPointsText(e.target.value)}
                placeholder={'写出 M(CaCO₃) = 40+12+16×3 的算式\n正确计算得 100\n标注单位 g/mol'}
              />
              {optDetails && (
                <div className="notice" style={{ marginTop: '8px' }}>
                  <b>✨ 细则智能扩充完成</b>
                  {optDetails.correct.length > 0 && (
                    <div style={{ marginTop: '4px', fontSize: '12px' }}>
                      <span className="badge green" style={{ marginRight: '6px' }}>补充正确情形</span>
                      {optDetails.correct.join('；')}
                    </div>
                  )}
                  {optDetails.incorrect.length > 0 && (
                    <div style={{ marginTop: '4px', fontSize: '12px' }}>
                      <span className="badge amber" style={{ marginRight: '6px' }}>补充错误情形</span>
                      {optDetails.incorrect.join('；')}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ---------------- 学生答案 ---------------- */}
      <div className="card">
        <h2>② 学生答案</h2>
        <div className="row">
          <div className="field inline">
            <label>姓名（选填）</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="张三" />
          </div>
          <div className="field inline">
            <label>考号（选填）</label>
            <input value={examNo} onChange={(e) => setExamNo(e.target.value)} placeholder="20260101" />
          </div>
        </div>
        <p className="hint">姓名与考号不填也能评分，只是导出的表格里没有归属。</p>

        <div className="field">
          <label>答案文本</label>
          <textarea
            rows={5}
            value={answerText}
            onChange={(e) => setAnswerText(e.target.value)}
            placeholder="粘贴或手打学生答案。客观题请只填答案本身。"
          />
        </div>

        <div className="row">
          <button onClick={() => imageInput.current?.click()} disabled={busy}>
            添加答案截图
          </button>
          {/* 用隐藏的 file input 而不是引第三方拖拽库：少一个依赖少一处风险 */}
          <input
            ref={imageInput}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => void onPickImages(e.target.files)}
          />
          {images.length > 0 && (
            <>
              <span className="badge blue">已加 {images.length} 张图</span>
              <button onClick={() => setImages([])}>清空图片</button>
            </>
          )}
        </div>
        {images.length > 0 && (
          <p className="hint">
            图片会送视觉模型识别。**识别结果需要人工核对**——手写体识别错一个数字就会误判。
          </p>
        )}
        <input ref={fileInput} type="file" style={{ display: 'none' }} />
      </div>

      {/* ---------------- 评分结果 ---------------- */}
      <div className="card">
        <h2>③ {isObjective ? '本地比对' : 'AI 评分'}</h2>

        <div className="row">
          {isObjective ? (
            <button className="primary" onClick={() => void runObjective()} disabled={busy}>
              {busy ? '比对中…' : '本地比对（不消耗 token）'}
            </button>
          ) : (
            <button className="primary" onClick={() => void runAI()} disabled={busy}>
              {busy ? '评分中…' : 'AI 评分'}
            </button>
          )}
        </div>

        {error && (
          <div className="notice err">
            <b>无法继续</b>
            <div>{error}</div>
          </div>
        )}

        {/* 客观题结果 */}
        {objective && (
          <div className="result">
            <div className="result-head">
              <span className={`badge ${VERDICT_UI[objective.verdict].badge}`}>
                {VERDICT_UI[objective.verdict].label}
              </span>
              <span className="score">
                {objective.awarded ? fullScore : 0} / {fullScore}
              </span>
              {objective.needsReview && <span className="badge amber">需人工复核</span>}
              <span className="badge gray">未消耗 token</span>
            </div>
            <p className="hint">{VERDICT_UI[objective.verdict].desc}</p>
            <table className="data">
              <tbody>
                <tr>
                  <th>学生答案（归一化后）</th>
                  <td>{objective.normalized || '（空）'}</td>
                </tr>
                <tr>
                  <th>标准答案（归一化后）</th>
                  <td>{objective.expected || '（空）'}</td>
                </tr>
                <tr>
                  <th>判定原因</th>
                  <td>{objective.reason}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* 主观题结果 */}
        {grade && (
          <div className="result">
            <div className="result-head">
              <span className="score">
                {grade.score} / {fullScore}
              </span>
              {grade.paperState && grade.paperState !== 'normal' && (
                <span className={`badge ${grade.paperState === 'blank' ? 'gray' : (grade.paperState === 'task_finished' ? 'purple' : 'pink')}`}>
                  {grade.paperState === 'blank' ? '空白卷' : (grade.paperState === 'task_finished' ? '任务完成' : '错位答卷')}
                </span>
              )}
              {grade.mathIntegrity && (
                <span className={`badge ${grade.mathIntegrity.ok ? 'green' : 'amber'}`} title={grade.mathIntegrity.reason}>
                  {grade.mathIntegrity.ok ? (grade.mathExpression ? `✓ 算术对账自洽 (${grade.mathExpression})` : '✓ 算式自洽') : '⚠ 算术对账存疑'}
                </span>
              )}
              <span className={`badge ${grade.confidence >= 0.75 ? 'green' : 'amber'}`}>
                置信度 {grade.confidence.toFixed(2)}
              </span>
              {grade.reviewRequested && <span className="badge amber">建议人工复核</span>}
            </div>
            {/* 0 分明确标注为正常结果，避免教师以为软件没跑出来 */}
            {grade.score === 0 && (
              <p className="hint">
                这是**正常的 0 分**（AI 判定未达任何得分点），不是失败。
              </p>
            )}
            <p className="comment">{grade.comment}</p>

            {grade.hitPoints.length > 0 && (
              <>
                <h3>✅ 命中得分点</h3>
                <ul>
                  {grade.hitPoints.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            )}
            {grade.missedPoints.length > 0 && (
              <>
                <h3>❌ 未命中</h3>
                <ul>
                  {grade.missedPoints.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </>
            )}

            {grade.warnings.length > 0 && (
              <div className="notice">
                {grade.warnings.map((w) => (
                  <div key={w} className="warn-line">
                    ⚠ {w}
                  </div>
                ))}
              </div>
            )}

            <p className="hint">
              提示词版本 {grade.promptVersion}（{grade.promptHash.slice(0, 8)}）·
              {grade.confidence < 0.75
                ? '置信度低于阈值，结果已标记为需复核。'
                : '置信度达标，仍建议抽查。'}
            </p>
          </div>
        )}

        {!objective && !grade && !error && (
          <div className="empty-state small">
            <div className="desc">填好上面的内容后点按钮，结果会显示在这里。</div>
          </div>
        )}
      </div>
    </>
  );
}