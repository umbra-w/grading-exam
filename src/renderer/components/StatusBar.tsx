import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import type { PickKind, PickResult } from '@shared/types';

function fmtInt(n: number): string {
  return n.toLocaleString('en-US');
}

const PICK_LABELS: Array<{ kind: PickKind; label: string }> = [
  { kind: 'questionRegion', label: '题目区域' },
  { kind: 'scoreInput', label: '分数框' },
  { kind: 'submitButton', label: '提交按钮' },
];

/**
 * 底部状态栏。
 */
export function StatusBar(): JSX.Element {
  const info = useStore((s) => s.appInfo);
  const usage = useStore((s) => s.usage);
  const logs = useStore((s) => s.logs);
  const isLogOpen = useStore((s) => s.isLogOpen);
  const toggleLog = useStore((s) => s.toggleLog);

  const [picks, setPicks] = useState<Partial<Record<PickKind, PickResult>>>({});

  useEffect(() => {
    let alive = true;

    void (async () => {
      const st = await window.gradingExam.pickerState();
      if (alive) setPicks(st.picks ?? {});
    })();

    const off = window.gradingExam.onPick((r) => {
      setPicks((prev) => ({ ...prev, [r.kind]: r }));
    });

    return () => {
      alive = false;
      off();
    };
  }, []);

  const doneCount = PICK_LABELS.filter((p) => picks[p.kind]).length;
  const errCount = logs.filter((l) => l.level === 'error').length;

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof document !== 'undefined') {
      return (document.documentElement.getAttribute('data-theme') as 'light' | 'dark') || 'light';
    }
    return 'light';
  });

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', next);
    }
    try {
      localStorage.setItem('ge_theme', next);
    } catch {
      // 忽略
    }
  };

  return (
    <div className="statusbar">
      {info ? (
        <>
          <span className="kv">
            版本 <b>{info.version}</b>
          </span>
          <span className="kv">
            Electron <b>{info.electron}</b>
          </span>
        </>
      ) : (
        <span className="kv">初始化中…</span>
      )}

      <span className="spacer" />

      {/* 拾取配置的真实状态 */}
      {PICK_LABELS.map((p) => {
        const r = picks[p.kind];
        return (
          <span className="kv" key={p.kind} title={r?.selector ?? undefined}>
            {p.label}{' '}
            {r ? (
              <span className="badge green">
                {r.mode === 'coordinate' ? `${r.topX},${r.topY}` : '已拾取'}
              </span>
            ) : (
              <span className="badge gray">未拾取</span>
            )}
          </span>
        );
      })}
      <span className={`badge ${doneCount === 3 ? 'blue' : 'gray'}`}>{doneCount}/3</span>

      <span className="kv" title="当前会话累计 token 用量">
        用量 <b>{fmtInt(usage.total)}</b>
        <span style={{ marginLeft: 4 }}>tok</span>
        {usage.prompt || usage.completion ? (
          <span style={{ marginLeft: 6, fontSize: 11 }}>
            (入 {fmtInt(usage.prompt)} / 出 {fmtInt(usage.completion)})
          </span>
        ) : null}
      </span>

      <button
        className="btn btn-secondary"
        style={{
          padding: '1px 8px',
          fontSize: 11,
          marginLeft: 8,
          borderColor: errCount > 0 ? 'var(--err)' : undefined,
          color: errCount > 0 ? 'var(--err-text)' : undefined,
          background: isLogOpen ? 'var(--bg-deep)' : undefined,
        }}
        onClick={toggleLog}
        title="展开/收起底部运行控制台 (可查看详细调用与网络日志)"
      >
        ❯_ 控制台 {errCount > 0 ? `(${errCount} 错误)` : `(${logs.length})`}
      </button>

      <button
        className="btn btn-secondary"
        style={{ padding: '1px 8px', fontSize: 11, marginLeft: 4 }}
        onClick={toggleTheme}
        title="切换 Fluent 浅色 / 暗黑主题"
      >
        {theme === 'dark' ? '🌙 深色' : '☀️ 浅色'}
      </button>

      <button
        className="btn btn-secondary"
        style={{ padding: '1px 6px', fontSize: 11, marginLeft: 4 }}
        onClick={() => {
          void window.gradingExam.windowCompact(true);
        }}
        title="缩小为屏幕边缘悬浮条模式，不遮挡浏览器阅卷网页"
      >
        ⛶ 悬浮条
      </button>
    </div>
  );
}
