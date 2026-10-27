import type { JSX } from 'react';
import { useState } from 'react';

interface MiniOverlayProps {
  onRestore: () => void;
  onNextPaper?: () => void;
  onFillScore?: (score: number) => void;
}

export function MiniOverlay({ onRestore, onNextPaper, onFillScore }: MiniOverlayProps): JSX.Element {
  const [score, setScore] = useState('8.5');

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'linear-gradient(135deg, #1e2130, #2c3144)',
        color: '#ffffff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 16px',
        userSelect: 'none',
        zIndex: 99999,
        borderBottom: '2px solid var(--accent)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontWeight: 700, color: 'var(--sakura)', fontSize: 13 }}>
          ◈ 阅卷悬浮条
        </span>
        <span style={{ fontSize: 12, color: '#aaa' }}>
          ⌨️ 小键盘已就绪
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="text"
          value={score}
          onChange={(e) => setScore(e.target.value)}
          placeholder="分值"
          style={{
            width: 60,
            padding: '4px 6px',
            borderRadius: 6,
            border: '1px solid #4f46e5',
            background: '#13151f',
            color: '#fff',
            fontWeight: 700,
            textAlign: 'center',
            fontSize: 14,
          }}
        />
        <button
          className="btn btn-primary"
          style={{ padding: '4px 10px', fontSize: 12 }}
          onClick={() => onFillScore?.(Number(score) || 0)}
        >
          填分 (Enter)
        </button>
        <button
          className="btn btn-secondary"
          style={{ padding: '4px 10px', fontSize: 12 }}
          onClick={() => onNextPaper?.()}
        >
          下一份 (Space)
        </button>
      </div>

      <button
        className="btn btn-secondary"
        style={{ padding: '4px 10px', fontSize: 12 }}
        onClick={onRestore}
        title="还原回完整工作台窗口"
      >
        ⛶ 还原窗口
      </button>
    </div>
  );
}
