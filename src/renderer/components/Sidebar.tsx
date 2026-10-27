import type { JSX } from 'react';
import { useStore } from '../store';
import type { PageKey } from '../store';

interface NavDef {
  key: PageKey;
  label: string;
  /** 简单的字符图标。用字形而非图标字体/图片：零依赖，且随字号自然缩放 */
  glyph: string;
  /** 悬停提示。写"这个面板现在能做什么"，不写内部 Phase 编号——
   *  Phase 是开发计划里的分期，用户看到的应该是能力，不是我们的排期 */
  title: string;
  /** 该面板的界面是否已可用。未可用的仍可点进去看说明，但不假装能用 */
  done: boolean;
}

const NAV: NavDef[] = [
  { key: 'sheet', label: '答题卡批改', glyph: '❐', title: '本地答题卡批改：切片批改、0 Token 客观题填涂识别、红笔批注与试卷导出', done: true },
  { key: 'paper', label: '整卷阅卷', glyph: '▤', title: '批量识别与成绩录入：照片识别、客观题比对与总分汇总', done: true },
  { key: 'browser', label: '浏览器阅卷', glyph: '◈', title: '拾取与窗口已可用；连续阅卷待实现', done: true },
  { key: 'single', label: '智能阅卷', glyph: '✎', title: '单题批改：客观题本地比对 + 主观题 AI 评分', done: true },
  { key: 'review', label: '复核队列', glyph: '☑', title: '人工复核低置信度评分：改分、翻转评分点、确认或排除', done: true },
  { key: 'analysis', label: '学情分析', glyph: '◔', title: '学情分析与教学建议报告', done: true },
  { key: 'settings', label: '设置', glyph: '⚙', title: 'AI 供应商与导出目录', done: true },
];

export function Sidebar(): JSX.Element {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);

  return (
    <nav className="sidebar">
      <div className="brand">
        <div className="name">
          <span className="mark" />
          <span>Grading_exam</span>
        </div>
        <small>AI 阅卷助手 · 开源版</small>
      </div>

      <div className="nav-group">功能</div>

      {NAV.map((n) => (
        <button
          key={n.key}
          className={`nav-item${page === n.key ? ' active' : ''}`}
          onClick={() => setPage(n.key)}
          title={n.title}
        >
          <span className="icon">{n.glyph}</span>
          <span>{n.label}</span>
          {n.done ? null : <span className="tag">未实现</span>}
        </button>
      ))}
    </nav>
  );
}