import type { JSX } from 'react';

interface Props {
  title: string;
  glyph: string;
  phase: string;
  /** 该面板要落地的功能点，直接引自 SPEC，避免规划与实现脱节 */
  items: string[];
}

/**
 * 尚未实现的面板的统一占位。
 *
 * 设计取舍：不渲染成空白页（会让人以为坏了），也不渲染成"能用的样子"
 * （那是欺骗）。用带图标的空态 + 明确的待实现清单，让人一眼看到
 * 「这里还没做」以及「将会做什么」。
 */
export function PlaceholderPanel({ title, glyph, phase, items }: Props): JSX.Element {
  return (
    <>
      <div className="card">
        <div className="empty-state">
          <div className="glyph">{glyph}</div>
          <div className="title">{title}</div>
          <div className="desc">
            计划在 <b>{phase}</b> 落地。下面是按 SPEC 需要实现的功能点，
            列出来是为了让进度可对照，而不是让这个页面看起来已经能用。
          </div>
        </div>
      </div>

      <div className="card">
        <h2>待实现清单</h2>
        <p className="hint">共 {items.length} 项，引自 SPEC，实现后逐条勾除。</p>
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 2, color: 'var(--text-mid)' }}>
          {items.map((it) => (
            <li key={it}>{it}</li>
          ))}
        </ul>
      </div>
    </>
  );
}