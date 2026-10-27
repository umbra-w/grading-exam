import { useEffect, useRef, useState, type JSX } from 'react';
import { useStore } from '../store';

const LEVEL_TAG: Record<string, string> = {
  info: 'INFO',
  ok: ' OK ',
  warn: 'WARN',
  error: 'ERR ',
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function LogBar(): JSX.Element {
  const logs = useStore((s) => s.logs);
  const [collapsed, setCollapsed] = useState(false);
  const [follow, setFollow] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 自动滚到底；用户手动上滚时暂停跟随，避免打断排查
  useEffect(() => {
    if (!follow || collapsed) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, follow, collapsed]);

  function onScroll(): void {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atBottom);
  }

  const errCount = logs.filter((l) => l.level === 'error').length;
  const warnCount = logs.filter((l) => l.level === 'warn').length;

  return (
    <div className={`logbar${collapsed ? ' collapsed' : ''}`}>
      <div className="logbar-head">
        <span className="title">运行日志</span>
        <span className="badge gray">{logs.length} 条</span>
        {errCount > 0 ? <span className="badge" style={{ color: '#fca5a5' }}>{errCount} 错误</span> : null}
        {warnCount > 0 ? <span className="badge amber">{warnCount} 警告</span> : null}

        <span className="spacer" />

        {!collapsed ? (
          <button onClick={() => setFollow((v) => !v)} title="是否自动滚动到最新">
            {follow ? '跟随中' : '已暂停'}
          </button>
        ) : null}
        <button onClick={() => setCollapsed((v) => !v)}>{collapsed ? '展开' : '收起'}</button>
      </div>

      {!collapsed ? (
        <div className="logbar-body" ref={bodyRef} onScroll={onScroll}>
          {logs.length === 0 ? (
            <div className="empty">暂无日志</div>
          ) : (
            logs.map((l, i) => (
              <div key={`${l.ts}-${i}`} className={`logline ${l.level}`}>
                <span className="t">{fmtTime(l.ts)}</span>{' '}
                <span className="t">{LEVEL_TAG[l.level] ?? 'INFO'}</span>{' '}
                {'  '.repeat(l.depth ?? 0)}
                {l.message}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}