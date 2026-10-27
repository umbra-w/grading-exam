import { useEffect, useRef, useState, type JSX } from 'react';
import { useStore } from '../store';

const LEVEL_CONFIG: Record<string, { label: string; cls: string }> = {
  info: { label: 'INFO', cls: 'info' },
  ok: { label: 'OK', cls: 'ok' },
  warn: { label: 'WARN', cls: 'warn' },
  error: { label: 'ERR', cls: 'error' },
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function LogBar(): JSX.Element {
  const logs = useStore((s) => s.logs);
  const isLogOpen = useStore((s) => s.isLogOpen);
  const toggleLog = useStore((s) => s.toggleLog);
  const clearLogs = useStore((s) => s.clearLogs);

  const [follow, setFollow] = useState(true);
  const [filterErrorOnly, setFilterErrorOnly] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!follow || !isLogOpen) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, follow, isLogOpen]);

  function onScroll(): void {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setFollow(atBottom);
  }

  const errCount = logs.filter((l) => l.level === 'error').length;
  const warnCount = logs.filter((l) => l.level === 'warn').length;
  const displayLogs = filterErrorOnly ? logs.filter((l) => l.level === 'error' || l.level === 'warn') : logs;

  return (
    <div className={`logbar${isLogOpen ? '' : ' collapsed'}`}>
      <div className="logbar-head">
        <span className="title">
          <span className="log-icon">❯_</span>
          <span>运行控制台</span>
        </span>
        <span className="badge gray">{logs.length} 条</span>
        {errCount > 0 ? (
          <span
            className="badge red"
            onClick={() => setFilterErrorOnly(true)}
            style={{ cursor: 'pointer' }}
            title="点击仅看错误"
          >
            {errCount} 错误
          </span>
        ) : null}
        {warnCount > 0 ? (
          <span
            className="badge amber"
            onClick={() => setFilterErrorOnly(true)}
            style={{ cursor: 'pointer' }}
            title="点击仅看警告"
          >
            {warnCount} 警告
          </span>
        ) : null}

        <span className="spacer" />

        <button
          className={filterErrorOnly ? 'active' : ''}
          onClick={() => setFilterErrorOnly((v) => !v)}
          title="筛选告警与错误"
        >
          {filterErrorOnly ? '查看全部' : '只看异常'}
        </button>

        <button onClick={() => setFollow((v) => !v)} title="是否随新日志自动滚到底部">
          {follow ? '跟随中' : '已暂停'}
        </button>

        <button onClick={clearLogs} title="清空当前日志">
          清空
        </button>

        <button className="close-btn" onClick={toggleLog} title="收起控制台">
          ✕
        </button>
      </div>

      {isLogOpen ? (
        <div className="logbar-body" ref={bodyRef} onScroll={onScroll}>
          {displayLogs.length === 0 ? (
            <div className="empty">暂无运行日志</div>
          ) : (
            displayLogs.map((l, i) => {
              const cfg = LEVEL_CONFIG[l.level] ?? { label: 'INFO', cls: 'info' };
              return (
                <div key={`${l.ts}-${i}`} className={`logline ${cfg.cls}`}>
                  <span className="t">{fmtTime(l.ts)}</span>
                  <span className={`tag tag-${cfg.cls}`}>{cfg.label}</span>
                  {'  '.repeat(l.depth ?? 0)}
                  <span className="msg">{l.message}</span>
                </div>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
