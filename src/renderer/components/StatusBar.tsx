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
 *
 * 本轮改动：此前三项拾取状态是**写死的**「未拾取」灰标，
 * 无论实际拾取与否都不变——状态栏在说谎。
 * 现改为订阅 evt:pick 并读一次已有状态，真实反映。
 */
export function StatusBar(): JSX.Element {
  const info = useStore((s) => s.appInfo);
  const usage = useStore((s) => s.usage);
  const [picks, setPicks] = useState<Partial<Record<PickKind, PickResult>>>({});

  useEffect(() => {
    let alive = true;

    // 先读一次现状：面板可能在别的页签里已经拾取过，切回来不能显示成"未拾取"
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

      {/* 拾取配置的真实状态（SPEC F1.2 / F1.8） */}
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
    </div>
  );
}