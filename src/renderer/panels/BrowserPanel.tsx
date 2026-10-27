import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { BrowserKernel, GradingMode, PickKind, PickResult } from '@shared/types';

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
    key: 'standard',
    name: '标准模式',
    desc: '仅 AI 评分，不自动填分。结果需要你自己动手录入。',
  },
  {
    key: 'steady',
    name: '稳健模式',
    desc: '填分与提交前都停下来等你确认。默认推荐。',
  },
  {
    key: 'top',
    name: '顶尖模式',
    desc: '截图→评分→填分→提交，全程无人值守。',
    warn: '慎用',
  },
];

/**
 * 浏览器自动化阅卷面板。
 *
 * 本轮接线说明：主进程的 browser:* / picker:* / page:* 通道**已经实现**，
 * 但界面此前仍写着「Phase 2 未实现」且按钮全部 disabled —— 界面在说谎。
 * 现已接上真实通道；仍未实现的只有自动连续阅卷（auto:*），
 * 该按钮保持禁用并明确说明，不假装可用。
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

  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 当前正在等待用户去页面上点击的那一项；null = 不在拾取中 */
  const [picking, setPicking] = useState<PickKind | null>(null);
  const [picked, setPicked] = useState<Partial<Record<PickKind, PickResult>>>({});
  const [coordinateMode, setCoordinateMode] = useState(false);
  /** 坐标模式下手输的屏幕坐标（Canvas 平台没有 DOM 可拾取） */
  const [coord, setCoord] = useState({ x: 0, y: 0 });

  const pickedCount = PICKS.filter((p) => picked[p.kind]).length;

  function log(level: 'info' | 'warn' | 'error' | 'ok', message: string): void {
    pushLog({ ts: Date.now(), level, message });
  }

  // 订阅拾取结果。必须取消订阅：StrictMode 下会挂载两次，漏了会收到双份
  useEffect(() => {
    const off = window.gradingExam.onPick((r) => {
      setPicked((prev) => ({ ...prev, [r.kind]: r }));
      setPicking(null);
      const where = r.mode === 'coordinate' ? `坐标 (${r.topX}, ${r.topY})` : (r.selector ?? '(无选择器)');
      log('ok', `已拾取「${labelOf(r.kind)}」：${where}${r.inIframe ? '（iframe 内）' : ''}`);
    });
    return off;
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

  function notImplemented(action: string): void {
    log('warn', `${action}：连续阅卷状态机（Phase 5）尚未接入，此按钮暂不可用`);
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
        <h2>评分标准</h2>
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

        <div className="row">
          <button className="primary" disabled onClick={() => notImplemented('自动运行')}>
            开始连续阅卷
          </button>
          <button className="danger" disabled onClick={() => notImplemented('停止')}>
            停止
          </button>
          <span className="spacer" />
          <span className="badge gray">Phase 5 未接入</span>
        </div>
        <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
          连续阅卷中单份失败只告警不中断；0 分卷跳过填分直接提交。
          该状态机尚未接入，按钮保持禁用而不是假装可用。
        </p>
      </div>
    </>
  );
}

function labelOf(kind: PickKind): string {
  return PICKS.find((p) => p.kind === kind)?.label ?? kind;
}