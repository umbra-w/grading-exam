import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { BrowserKernel, GradingMode, PickKind, PickResult } from '@shared/types';
import { PLATFORM_PRESETS, getPlatformPresetById } from '@shared/platform-presets';

interface PickRow {
  kind: PickKind;
  label: string;
  glyph: string;
}

const PICKS: PickRow[] = [
  { kind: 'questionRegion', label: '题目区域', glyph: '▣' },
  { kind: 'scoreInput', label: '分数输入框', glyph: '◫' },
  { kind: 'submitButton', label: '提交按钮', glyph: '◉' },
];

/** 三种批阅模式的说明。把风险差异直接写在卡片上，不藏在下拉里 */
const MODES: Array<{ key: GradingMode; name: string; desc: string; warn?: string }> = [
  {
    key: 'trial',
    name: '🧪 试运行模式',
    desc: '仅改 1 份，填入分数后等待人工确认，绝不自动提交。首次在平台批阅强烈推荐！',
  },
  {
    key: 'steady',
    name: '🛡️ 稳健模式',
    desc: '填分前停下来等你确认；软件不会替你提交，提交由你手动完成。默认推荐。',
  },
  {
    key: 'top',
    name: '⚡ 自动模式',
    desc: '截图→评分→填分→按下平台的提交按钮，连续无人值守。限已充分验证的平台。',
    warn: '会真实提交',
  },
  {
    key: 'standard',
    name: '仅评分模式',
    desc: '仅 AI 评分，不自动填分。结果需要你自己动手录入。',
  },
];

/**
 * 浏览器自动化阅卷面板。
 *
 * 接线说明：主进程的 browser:* / picker:* / page:* / auto:* 通道
 * **都已实现**（auto:* 的执行层在 page/auto-runner.ts）。
 *
 * ⚠ 但 auto:* 依赖真实 CDP，**本机无法验证**（Electron 起不来，§5）。
 * 所以面板必须把"未在真机验证过"说清楚，而不是让它看起来像
 * "已经可用的无人值守阅卷"——那是本项目最不能犯的错（§1.2）。
 */
export function BrowserPanel(): JSX.Element {
  const pushLog = useStore((s) => s.appendLog);

  const [url, setUrl] = useState('');
  const [kernel, setKernel] = useState<BrowserKernel>('chrome');
  const [mode, setMode] = useState<GradingMode>('steady');
  const [stem, setStem] = useState('');
  const [fullScore, setFullScore] = useState(10);
  const [reference, setReference] = useState('');
  const [points, setPoints] = useState('');
  // 下面三项是 auto:start 必需的，原先面板没有，导致配置组装不出来
  const [maxPapers, setMaxPapers] = useState(0);
  const [throttleMs, setThrottleMs] = useState(800);
  const [nextPaperTimeoutSec, setNextPaperTimeoutSec] = useState(60);
  const [presetId, setPresetId] = useState('zhixue');

  async function handleExtractRubric(): Promise<void> {
    try {
      const res = await window.gradingExam.pickFile({
        filters: [{ name: '评分细则截图', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        multi: false,
      });
      if (res.canceled || !res.paths[0]) return;
      setBusy(true);
      log('info', '正在通过 AI 视觉解析评分细则截图...');
      const read = await window.gradingExam.readImages([res.paths[0]]);
      if (!read.ok || !read.images?.[0]) {
        log('error', '未能读取所选截图');
        return;
      }
      const base64 = read.images[0].dataUrl.split(',')[1] ?? '';
      const extRes = await window.gradingExam.aiExtractRubric({
        image: { data: base64, mime: 'image/jpeg' },
      });
      if (extRes.ok && extRes.rubric) {
        const r = extRes.rubric;
        if (r.stem) setStem(r.stem);
        if (r.fullScore) setFullScore(r.fullScore);
        if (r.referenceAnswer) setReference(r.referenceAnswer);
        if (r.scoringPoints?.length) setPoints(r.scoringPoints.join('\n'));
        log('ok', `已自动提取细则：满分 ${r.fullScore} 分，得分点 ${r.scoringPoints.length} 条`);
      } else {
        log('warn', extRes.error ?? '未完全解析出结构化细则');
      }
    } catch (err) {
      log('error', `提取细则出错：${(err as Error)?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 当前正在等待用户去页面上点击的那一项；null = 不在拾取中 */
  const [picking, setPicking] = useState<PickKind | null>(null);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoCurrent, setAutoCurrent] = useState('');
  const [autoHandled, setAutoHandled] = useState(0);
  const [picked, setPicked] = useState<Partial<Record<PickKind, PickResult>>>({});
  const [coordinateMode, setCoordinateMode] = useState(false);
  /** 坐标模式下手输的屏幕坐标（Canvas 平台没有 DOM 可拾取） */
  const [coord, setCoord] = useState({ x: 0, y: 0 });

  const pickedCount = PICKS.filter((p) => picked[p.kind]).length;

  function log(level: 'info' | 'warn' | 'error' | 'ok', message: string): void {
    pushLog({ ts: Date.now(), level, message });
  }

  // 阅卷窗口是否打开。**不只在 openPage 里设**：用户手动关掉窗口、
// 或面板重新挂载（切页签、开发者热更新）后，本地状态就会与事实不符——
// 那种情况下界面说"已打开"，点拾取却报"请先打开阅卷窗口"，用户完全懵。
  // 所以这里以主进程的 pickerState 为权威，并把刷新点铺到三处。
  useEffect(() => {
    let alive = true;
    const sync = (): void => {
      void window.gradingExam
        .pickerState()
        .then((s) => {
          if (!alive) return;
          setOpened(s.open);
          // 主进程是权威来源：本地 picked 只做即时反馈，
          // 但切页签/重挂载后必须以主进程为准，否则会漏掉已拾取项
          if (Object.keys(s.picks ?? {}).length > 0) {
            setPicked(s.picks);
          }
          setPicking(s.pendingPick ?? null);
        })
        .catch(() => undefined);
    };

    sync(); // 挂载时
    window.addEventListener('focus', sync); // 用户从阅卷窗口切回来时
    return () => {
      alive = false;
      window.removeEventListener('focus', sync);
    };
  }, []);

  // 订阅拾取结果。必须取消订阅：StrictMode 下会挂载两次，漏了会收到双份
  useEffect(() => {
    const off = window.gradingExam.onPick((r) => {
      setPicked((prev) => ({ ...prev, [r.kind]: r }));
      setPicking(null);
      const where = r.mode === 'coordinate' ? `坐标 (${r.topX}, ${r.topY})` : (r.selector ?? '(无选择器)');
      log('ok', `已拾取「${labelOf(r.kind)}」：${where}${r.inIframe ? '（iframe 内）' : ''}`);
    });
    // 窗口被用户关掉时同步状态，否则面板会一直显示"窗口已打开"
    const offClosed = window.gradingExam.onBrowserClosed(() => {
      setOpened(false);
      setPicking(null);
      log('warn', '阅卷窗口已被关闭');
    });
    /*
     * 订阅连续阅卷进度。
     *
     * 历史：这个订阅曾经不存在，而 `evt:progress` 被登记在
     * `check_ipc.py` 的"依赖 Phase 5 未实现"白名单里——那不是疏忽，
     * 是当时执行层确实没写。执行层接通后两件事一起做了：补上订阅，
     * 并把白名单清空（留着就等于对该事件永久免检）。
     *
     * 必须真的收下来：否则面板无法反映运行状态，老师会以为
     * "点了开始没反应"。也必须取消订阅（StrictMode 挂载两次会收双份）。
     */
    const offProgress = window.gradingExam.onProgress((raw) => {
      const p = raw as { running?: boolean; handled?: number; current?: string } | null;
      if (!p) return;
      setAutoRunning(Boolean(p.running));
      setAutoHandled(typeof p.handled === 'number' ? p.handled : 0);
      setAutoCurrent(typeof p.current === 'string' ? p.current : '');
    });
    return () => {
      off();
      offClosed();
      offProgress();
    };
  }, [pushLog]);

  async function openPage(): Promise<void> {
    const target = url.trim();
    if (!target) {
      log('warn', '请先填写阅卷平台网址');
      return;
    }
    setBusy(true);
    try {
      const res = await window.gradingExam.browserOpen(target, kernel);
      setOpened(res.ok);
      log(res.ok ? 'ok' : 'error', res.ok ? `已打开阅卷窗口：${target}` : `打开失败：${res.error ?? '未知原因'}`);
    } finally {
      setBusy(false);
    }
  }

  async function navigate(): Promise<void> {
    const target = url.trim();
    if (!target) {
      log('warn', '请先填写网址再跳转');
      return;
    }
    const res = await window.gradingExam.browserNavigate(target);
    if (!res.ok) log('error', `跳转失败：${res.error ?? '未知原因'}`);
  }

  async function closePage(): Promise<void> {
    await window.gradingExam.browserClose();
    setOpened(false);
    setPicking(null);
  }

  async function startPick(kind: PickKind): Promise<void> {
    if (!opened) {
      log('warn', '请先打开阅卷窗口，再进行拾取');
      return;
    }
    // 再点一次同一项 = 取消，避免误触发后无法退出
    if (picking === kind) {
      await window.gradingExam.pickerCancel();
      setPicking(null);
      return;
    }
    const res = await window.gradingExam.pickerStart(kind);
    if (!res.ok) {
      log('error', `进入拾取失败：${res.error ?? '未知原因'}`);
      return;
    }
    setPicking(kind);
    log('info', `请在阅卷窗口里点击「${labelOf(kind)}」的所在位置（再点此按钮可取消）`);
  }

  /** 坐标模式：Canvas 平台没有 DOM，只能手输坐标 */
  async function submitCoordinate(kind: PickKind): Promise<void> {
    if (!(coord.x > 0 && coord.y > 0)) {
      log('warn', '请填写有效的屏幕坐标');
      return;
    }
    // 契约里坐标字段是 localX / localY（相对当前 frame），页面坐标系
    const res = await window.gradingExam.pickerCoordinate({
      kind,
      localX: coord.x,
      localY: coord.y,
      framePath: [],
    });
    if (res.ok && res.pick) {
      setPicked((prev) => ({ ...prev, [kind]: res.pick! }));
      log('ok', `已记录「${labelOf(kind)}」坐标 (${coord.x}, ${coord.y})`);
    } else {
      log('error', `坐标记录失败：${res.error ?? '未知原因'}`);
    }
  }

  async function captureQuestion(): Promise<void> {
    const res = await window.gradingExam.captureQuestion();
    if (!res.ok) {
      log('error', `截图失败：${res.error ?? '未知原因'}`);
      return;
    }
    const kb = Math.round((res.base64?.length ?? 0) / 1024);
    log('ok', `题目区域截图完成（约 ${kb} KB base64），已交给评分流程`);
  }

  async function checkDrift(): Promise<void> {
    const res = await window.gradingExam.checkDrift();
    if (!res.changed) {
      log('ok', '页面结构与拾取时一致');
      return;
    }
    // 漂移不静默失败，也不硬闯——停下来让人确认（SPEC F1.9）
    const detail = (res.details ?? []).join('；') || '选择器可能已失效';
    log('warn', `检测到页面结构变化：${detail}。请重新拾取相关元素。${res.action ? `（建议：${res.action}）` : ''}`);
  }

  /**
   * 开工前校验：缺什么就**明确指出缺什么**。
   *
   * 为什么不把校验放主进程：这里能直接说"请先拾取分数输入框"，
   * 而主进程只能返回一个错误码。校验规则（哪种模式需要哪些拾取项）
   * 与主进程的 `missingPicks()` 一致——那边是执行层的最后一道门，
   * 这边只是提前反馈，两边都要有（缺了任何一边都会出现
   * "点了没反应"或"启动了才报错"）。
   */
  function missingForStart(): string[] {
    const missing: string[] = [];
    if (!stem.trim()) missing.push('题干');
    if (!(fullScore > 0)) missing.push('满分');
    if (!picked.questionRegion) missing.push('题目区域（用于截图评分）');
    if (mode !== 'standard' && !picked.scoreInput) missing.push('分数输入框');
    if (mode === 'top' && !picked.submitButton) missing.push('提交按钮（无人值守模式必须拾取）');
    return missing;
  }

  async function startAuto(): Promise<void> {
    if (!opened) {
      log('warn', '请先打开阅卷窗口再开始连续阅卷');
      return;
    }
    const missing = missingForStart();
    if (missing.length > 0) {
      log('warn', `还缺：${missing.join('、')}。补齐后再启动。`);
      return;
    }
    setBusy(true);
    try {
      const res = await window.gradingExam.autoStart({
        pageUrl: url.trim(),
        kernel,
        mode,
        // 卷子标识由执行层从页面读取（URL + 分数框初值指纹），
        // 这里给的是**题目**标识，两者不是一回事
        questionId: stem.trim().slice(0, 40),
        question: {
          stem: stem.trim(),
          fullScore,
          referenceAnswer: reference.trim(),
          scoringPoints: points
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        },
        picks: picked,
        throttleMs,
        maxPapers,
        nextPaperTimeoutMs: Math.max(1, nextPaperTimeoutSec) * 1000,
      });
      if (!res.ok) {
        log('error', `启动失败：${res.error ?? '未知原因'}`);
        return;
      }
      setAutoRunning(true);
      setAutoHandled(0);
      log('ok', '连续阅卷已启动。单份失败只告警不中断。');
      if (mode === 'top') {
        log('warn', '无人值守模式会自动提交。请留意平台上的实际结果，事后抽检。');
      }
    } finally {
      setBusy(false);
    }
  }

  async function stopAuto(): Promise<void> {
    const res = await window.gradingExam.autoStop();
    // 主进程会说"当前没有正在运行的连续阅卷"；这里如实跟随，
    // 不因为本地以为是运行中就假装停掉了
    log(res.ok ? 'info' : 'warn', res.ok ? '已请求停止连续阅卷' : '当前没有正在运行的连续阅卷');
    if (res.ok) setAutoRunning(false);
  }

  async function confirmAuto(): Promise<void> {
    const res = await window.gradingExam.autoConfirm();
    log(res.ok ? 'ok' : 'warn', res.ok ? '已确认本份评分' : '当前没有等待确认的评分');
  }

  return (
    <>
      <div className="notice info">
        所有自动化动作都只作用于<b>你自己的账号</b>。拾取成功会持久化，
        平台改版后需重新拾取——检测到结构变化时会停下来提醒，不会静默填错。
      </div>

      <div className="card">
        <h2>阅卷平台</h2>
        <p className="hint">选择器一律靠拾取取得，不硬编码任何平台选择器。</p>

        <div className="grid3">
          <div className="field">
            <label>浏览器内核</label>
            <select value={kernel} onChange={(e) => setKernel(e.target.value as BrowserKernel)}>
              <option value="chrome">Chrome</option>
              <option value="edge">Edge</option>
            </select>
          </div>

          <div className="field" style={{ gridColumn: 'span 3', marginBottom: 6 }}>
            <label>网阅平台预设（内置选择器候选与安全节流建议）</label>
            <select
              value={presetId}
              onChange={(e) => {
                const p = getPlatformPresetById(e.target.value);
                setPresetId(p.id);
                if (p.id !== 'generic') {
                  setUrl(p.defaultUrl);
                }
                setThrottleMs(p.defaultThrottleMs);
                log('info', `已切换至 ${p.name} 预设（建议操作间隔 ${p.defaultThrottleMs}ms）`);
              }}
            >
              {PLATFORM_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <p className="hint" style={{ marginTop: 4 }}>
              {getPlatformPresetById(presetId).notes}
            </p>
          </div>

          <div className="field" style={{ gridColumn: 'span 2' }}>
            <label>阅卷平台网址</label>
            <div className="row">
              <input
                type="text"
                value={url}
                placeholder="https://YOUR_PLATFORM/…"
                onChange={(e) => setUrl(e.target.value)}
                style={{ flex: 1 }}
              />
              <button className="primary" disabled={busy} onClick={() => void openPage()}>
                {opened ? '重新打开' : '打开页面'}
              </button>
            </div>
          </div>
        </div>

        <div className="row">
          <button disabled={!opened || busy} onClick={() => void navigate()}>
            跳转
          </button>
          <button disabled={!opened} onClick={() => void closePage()}>
            关闭窗口
          </button>
          <button disabled={!opened} onClick={() => void checkDrift()}>
            检测页面变化
          </button>
          <span className="spacer" />
          <span className={`badge ${opened ? 'green' : 'gray'}`}>
            {opened ? '窗口已打开' : '窗口未打开'}
          </span>
        </div>
      </div>

      <div className="card">
        <h2>元素拾取</h2>
        <p className="hint">
          点击按钮后到阅卷窗口里点一下目标位置。三项都拾取完才算配置完成。
        </p>

        <div className="row" style={{ marginBottom: 12 }}>
          {PICKS.map((p) => {
            const done = Boolean(picked[p.kind]);
            const isPicking = picking === p.kind;
            return (
              <button
                key={p.kind}
                className={isPicking ? 'picking' : done ? 'picked' : ''}
                disabled={!opened || (picking !== null && !isPicking)}
                onClick={() => void startPick(p.kind)}
              >
                {isPicking ? `◎ 点击页面…（${p.label}）` : done ? `✓ ${p.label}` : `拾取${p.label}`}
              </button>
            );
          })}
          <span className="spacer" />
          <span className={`badge ${pickedCount === 3 ? 'green' : 'gray'}`}>
            {pickedCount} / 3 已拾取
          </span>
        </div>

        <div className="pick-grid">
          {PICKS.map((p) => {
            const r = picked[p.kind];
            const cls = r ? 'pick-slot filled' : picking === p.kind ? 'pick-slot pending' : 'pick-slot';
            return (
              <div key={p.kind} className={cls}>
                <div className="name">
                  <span>{p.glyph}</span>
                  <span>{p.label}</span>
                  {r ? <span className="badge green" style={{ marginLeft: 'auto' }}>已拾取</span> : null}
                </div>
                {r ? (
                  <div className="detail">
                    {r.mode === 'coordinate'
                      ? `坐标 (${r.topX}, ${r.topY})`
                      : `x${r.topX} y${r.topY} · ${r.tag ?? '?'}`}
                    {r.inIframe ? ' · iframe 内' : ''}
                    {r.selector ? <div>{r.selector}</div> : null}
                  </div>
                ) : (
                  <div className="detail dim">尚未拾取</div>
                )}
              </div>
            );
          })}
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="ghost"
            disabled={!opened}
            onClick={() => setCoordinateMode((v) => !v)}
          >
            {coordinateMode ? '收起坐标模式' : '切换为坐标模式（Canvas 平台）'}
          </button>
          <button disabled={!picked.questionRegion} onClick={() => void captureQuestion()}>
            截取题目区域
          </button>
        </div>

        {coordinateMode ? (
          <div style={{ marginTop: 12 }}>
            <p className="hint" style={{ marginBottom: 8 }}>
              部分平台把试卷画在 Canvas 上，页面里没有可拾取的元素。
              此时可手输屏幕坐标（左上角为原点）。
            </p>
            <div className="row">
              <div className="field" style={{ marginBottom: 0 }}>
                <label>X</label>
                <input
                  type="number"
                  value={coord.x}
                  onChange={(e) => setCoord((c) => ({ ...c, x: Number(e.target.value) || 0 }))}
                  style={{ width: 110 }}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>Y</label>
                <input
                  type="number"
                  value={coord.y}
                  onChange={(e) => setCoord((c) => ({ ...c, y: Number(e.target.value) || 0 }))}
                  style={{ width: 110 }}
                />
              </div>
              {PICKS.map((p) => (
                <button key={p.kind} onClick={() => void submitCoordinate(p.kind)}>
                  记为{p.label}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>评分标准</h2>
          <button className="btn btn-secondary" onClick={handleExtractRubric} disabled={busy}>
            📸 截图一键提取细则
          </button>
        </div>
        <div className="field">
          <label>题目</label>
          <textarea value={stem} placeholder="题干原文" onChange={(e) => setStem(e.target.value)} />
        </div>
        <div className="grid2">
          <div className="field">
            <label>满分</label>
            <input
              type="number"
              value={fullScore}
              onChange={(e) => setFullScore(Number(e.target.value) || 0)}
            />
          </div>
          <div className="field">
            <label>参考答案</label>
            <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label>得分点（每行一条）</label>
          <textarea
            value={points}
            placeholder={'1. 正确列出方程 2 分\n2. 求解过程正确 3 分\n3. 结果带单位 1 分'}
            onChange={(e) => setPoints(e.target.value)}
          />
        </div>
      </div>

      <div className="card">
        <h2>批阅模式与运行</h2>
        <p className="hint">默认稳健模式。提交动作不可逆，所以默认让机器等你。</p>

        <div className="mode-cards" style={{ marginBottom: 14 }}>
          {MODES.map((m) => (
            <button
              key={m.key}
              className={`mode-card${mode === m.key ? ' active' : ''}`}
              onClick={() => setMode(m.key)}
            >
              <div className="mc-name">
                <span>{mode === m.key ? '◉' : '○'}</span>
                <span>{m.name}</span>
                {m.warn ? <span className="mc-warn">{m.warn}</span> : null}
              </div>
              <div className="mc-desc">{m.desc}</div>
            </button>
          ))}
        </div>

        <div className="grid3" style={{ marginTop: 12 }}>
          <div className="field">
            <label>连续处理份数上限</label>
            <input
              type="number"
              min={0}
              value={maxPapers}
              onChange={(e) => setMaxPapers(Math.max(0, Number(e.target.value) || 0))}
            />
            <p className="hint" style={{ marginBottom: 0 }}>0 = 不限，直到等不到下一份为止。</p>
          </div>
          <div className="field">
            <label>每步操作间隔（毫秒）</label>
            <input
              type="number"
              min={0}
              step={100}
              value={throttleMs}
              onChange={(e) => setThrottleMs(Math.max(0, Number(e.target.value) || 0))}
            />
            <p className="hint" style={{ marginBottom: 0 }}>适当间隔可降低被平台判为机器人的概率。</p>
          </div>
          <div className="field">
            <label>下一份等待超时（秒）</label>
            <input
              type="number"
              min={1}
              value={nextPaperTimeoutSec}
              onChange={(e) => setNextPaperTimeoutSec(Math.max(1, Number(e.target.value) || 1))}
            />
            <p className="hint" style={{ marginBottom: 0 }}>超时按"批完了"处理，并会如实说明是等超时结束的。</p>
          </div>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            disabled={!opened || autoRunning || busy}
            onClick={() => void startAuto()}
          >
            {autoRunning ? '运行中…' : '开始连续阅卷'}
          </button>
          <button className="danger" disabled={!autoRunning} onClick={() => void stopAuto()}>
            停止
          </button>
          <button disabled={!autoRunning} onClick={() => void confirmAuto()}>
            确认本份
          </button>
          <span className="spacer" />
          <span className={`badge ${autoRunning ? 'green' : 'gray'}`}>
            {autoRunning ? `运行中 ${autoHandled} 份` : '未运行'}
          </span>
        </div>

        {autoRunning ? (
          <div className="notice info" style={{ marginTop: 10 }}>
            当前：{autoCurrent || '…'}
          </div>
        ) : null}

        <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
          单份失败只告警不中断（拾取配置缺失除外——那会整轮中止）。
          steady 模式不会自动提交，提交由你手动完成；
          top 模式会真的按下提交按钮。
          <b> 自动提交依赖真实阅卷平台，本机无法验证，请先小份数试跑并抽检平台结果。</b>
        </p>
      </div>
    </>
  );
}

function labelOf(kind: PickKind): string {
  return PICKS.find((p) => p.kind === kind)?.label ?? kind;
}