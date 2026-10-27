/**
 * 连续阅卷的**决策逻辑**（纯函数，无 CDP、无网络、无计时器）。
 *
 * ── 为什么状态机必须是纯函数 ────────────────────────────────────────────────
 *
 * 连续阅卷是本项目唯一有**不可逆副作用**的功能：它会真的往平台的分数框写值、
 * 真的点提交。而本机 Electron 起不来（BLOCKERS.md B3），意味着真机上的第一次
 * 运行之前，这段逻辑无法被"跑一遍看看"验证。
 *
 * 所以把它拆成两层：
 *   · 本文件：给定"现在处于什么状态"，返回"下一步做什么"。**可单测。**
 *   · `auto.ts`：把动作翻译成 CDP 调用。薄绑定，⚠ 未验证。
 *
 * 这样真机上出问题时，能二分定位：是**决策**错了（本文件，有测试）
 * 还是**执行**错了（auto.ts，需真机）。
 *
 * ── 这个状态机要挡住的核心故障：假成功 ──────────────────────────────────────
 *
 * 「填了没反应」在阅卷平台上是常态：值看着写进去了，框架状态没更新，
 * 交上去还是原来的分。所以每次填分后**必须回读校验**，
 * 而校验失败要能重试、重试到上限就**停下来报错**，绝不能"继续下一份"。
 * 静默地少填一份比整个流程失败更糟：成绩单看起来是完整的。
 */
import type { FillCheck } from './geometry';

/** 单份答卷的填分阶段 */
export type FillPhase =
  | 'pending' // 还没开始
  | 'focusing' // 点击分数框聚焦
  | 'clearing' // 全选/清空已有内容
  | 'typing' // 写入分数
  | 'verifying' // 回读校验
  | 'done' // 值已确认写入
  | 'gaveUp'; // 重试到上限仍未确认

/** 状态机可能要求的动作 */
export type FillAction =
  /** 点击分数框（顶层坐标） */
  | { kind: 'click'; x: number; y: number }
  /** 全选已有内容，为替换做准备（insertText 是插入不是替换） */
  | { kind: 'selectAll' }
  /** 写入文本 */
  | { kind: 'insert'; text: string }
  /** 逐字符输入（Canvas 平台） */
  | { kind: 'type'; text: string }
  /** 回读元素当前值 */
  | { kind: 'read' }
  /** 已确认成功 */
  | { kind: 'success' }
  /** 放弃并报错（附带人类可读原因） */
  | { kind: 'fail'; reason: string; detail: string };

export interface FillInputMode {
  /** 'printable' 用 TextEncoder，'masked' 逐字符输入 */
  text: string;
  /** 写入方式：DOM 受控组件用 insert，Canvas 用逐字符 */
  write: 'insert' | 'type';
}

export interface FillConfig {
  /** 写入方式 */
  write?: 'insert' | 'type';
  /** 最多尝试几次（含首次）。默认 3 —— 见下方"为什么不是无限重试" */
  maxAttempts?: number;
  /** 分数框顶层坐标 */
  x: number;
  y: number;
}

/**
 * 为什么默认最多 3 次：重试是要**真的再点一次那个输入框**的。
 * 如果失败原因是"元素已经不是分数框了"（平台改版 / 页面跳转），
 * 重试只会让点击落到别处——可能误触提交。3 次足够覆盖
 * "输入太快被框架丢掉"这类瞬时问题，又不足以把误点放大。
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

export interface FillState {
  phase: FillPhase;
  /** 期望写入的分数文本（已清洗） */
  text: string;
  /** 已尝试次数 */
  attempts: number;
  /** 最近一次回读校验结果 */
  lastCheck: FillCheck | null;
  x: number;
  y: number;
  write: 'insert' | 'type';
  maxAttempts: number;
}

/**
 * 建立初始状态。
 *
 * `score` 会先经 `cleanScoreText` 清洗——**清洗放在这里而不是调用点**，
 * 因为每个调用点各洗一遍必然会漏一个。
 */
export function initialFillState(score: string, cfg: FillConfig): FillState {
  return {
    phase: 'pending',
    text: cleanScoreText(score),
    attempts: 0,
    lastCheck: null,
    x: cfg.x,
    y: cfg.y,
    write: cfg.write ?? 'insert',
    maxAttempts: cfg.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
  };
}

/**
 * 分数文本清洗。
 *
 * 平台分数框对格式的容忍度不一：有的只接受纯数字，有的要两位小数，
 * 有的会因为输入 "6.0" 而报"格式错误"。所以写入前统一清洗。
 *
 * 规则（保守优先——**拿不准就保持原样**，不要自作聪明改数值）：
 *   · 去掉首尾空白与全角空格
 *   · 去掉千分位逗号（1,000 → 1000）
 *   · 去掉正号前缀（+5 → 5）
 *   · 去掉百分号（50% → 50）—— 平台按分值理解，不按百分数
 *   · 全角数字转半角
 *   · **不做小数位增删**：6 → 6 就是 6，不擅自变成 6.00 或 6.0
 *   · 空串/纯空白 → 返回空串（调用方应视为"不填"而不是"填 0"）
 */
export function cleanScoreText(input: string): string {
  // ── 设计边界：只做「字符清理」，不做「数值归一化」 ──────────────────────────
  //
  // 这条边界是刻意的。清洗层一旦开始"理解"数字，就会在某个边界上
  // 静默篡改分值：比如把 `1,0` 当成千分位合并成 `10`，学生就多得了 9 分，
  // 而且成绩单看起来完全正常。
  //
  // 所以这里只做无条件安全的替换（去掉百分号、正号、空白、千分位逗号），
  // 以及**全角→半角**这一种有损但语义确定的转换。
  // 数值层面的差异（6 vs 6.0）交给回读校验去比，那里有归一化比较。
  let s = input.replace(/[\u3000\u00a0]/g, ' ').trim();
  if (!s) return '';
  s = toHalfWidthDigits(s);
  // 全角标点也是"数据"不是"噪声"：`６．５` 里的 `．` 是小数点。
  // 若只转全角数字而把 `．` 当噪声删掉，`6.5` 会变成 `65` —— 静默篡改数值。
  s = s.replace(/[．。]/g, '.');
  // 千分位逗号（含全角）直接去掉。**不做 $1$2 合并**：那种"智能"处理
  // 会把 `1,0` 变成 `10`。非规范的输入就该在后面被校验判失败，而不是被猜。
  s = s.replace(/[,，]/g, '');
  s = s.replace(/^\+/, '');
  s = s.replace(/[%％]\s*$/, '');
  // 末尾孤立的小数点（"6."）去掉：平台通常不接受
  s = s.replace(/\.$/, '');
  return s.trim();
}

function toHalfWidthDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    // 全角数字 U+FF10..U+FF19
    if (c >= 0xff10 && c <= 0xff19) out += String.fromCharCode(c - 0xfee0);
    else out += ch;
  }
  return out;
}

/**
 * 状态机的**唯一决策点**：给定当前状态与（可选的）最新回读结果，
 * 返回下一步动作与后继状态。
 *
 * 写成"输入状态 → 输出动作"而不是命令式流程，是为了让每个分支
 * 都能被单测直接喂进去，包括"重试到上限"这种在真机上难得一遇的路径。
 */
export function nextFillStep(
  state: FillState,
  check?: FillCheck,
): { action: FillAction; next: FillState } {
  switch (state.phase) {
    case 'pending':
      if (!state.text) {
        return {
          action: {
            kind: 'fail',
            reason: 'empty_score',
            detail: '分数为空，未向平台写入任何内容。这是刻意的：空白分不等于 0 分。',
          },
          next: { ...state, phase: 'gaveUp' },
        };
      }
      return {
        action: { kind: 'click', x: state.x, y: state.y },
        next: { ...state, phase: 'focusing', attempts: state.attempts + 1 },
      };

    case 'focusing':
      // insertText 是"插入"不是"替换"：元素非空且未全选时结果是追加。
      // 所以先全选，再写入——否则 "原值 5" + "新值 6" 会变成 "56"。
      return { action: { kind: 'selectAll' }, next: { ...state, phase: 'clearing' } };

    case 'clearing':
      return {
        action:
          state.write === 'type'
            ? { kind: 'type', text: state.text }
            : { kind: 'insert', text: state.text },
        next: { ...state, phase: 'typing' },
      };

    case 'typing':
      // 写完立刻回读。**不能**假设"发出去了就等于生效了"——
      // 这正是"填了没反应"的根因。
      return { action: { kind: 'read' }, next: { ...state, phase: 'verifying' } };

    case 'verifying': {
      if (!check) {
        // 没有校验结果就进入 verifying 是程序缺陷，不能放行
        return {
          action: {
            kind: 'fail',
            reason: 'no_verify_result',
            detail: '进入校验阶段却没有回读结果，拒绝继续（不放行未校验的写入）。',
          },
          next: { ...state, phase: 'gaveUp' },
        };
      }
      if (check.verdict === 'ok') {
        return { action: { kind: 'success' }, next: { ...state, phase: 'done', lastCheck: check } };
      }
      if (check.verdict === 'unreadable') {
        // 读不到元素：重试没有意义（元素已不在），必须让人重新拾取。
        // 这里**自己说明"要重拾"**，而不是假设上游文案里会有这句话——
        // 上游文本改动不该让本状态机的提示失去可操作性。
        return {
          action: {
            kind: 'fail',
            reason: 'unreadable',
            detail: `${check.message} 重试无法解决（元素已不在原处），请重新拾取分数框后再继续。`,
          },
          next: { ...state, phase: 'gaveUp', lastCheck: check },
        };
      }
      // empty / mismatch：可能是框架把输入丢掉了，重试
      if (state.attempts >= state.maxAttempts) {
        return {
          action: {
            kind: 'fail',
            reason: 'fill_not_verified',
            detail:
              `已尝试 ${state.attempts} 次，平台回读值仍与期望不一致` +
              `（期望 ${check.expected}，实际 ${check.actual ?? '读不到'}）。` +
              `已停止，未提交。请人工确认该题分数。`,
          },
          next: { ...state, phase: 'gaveUp', lastCheck: check },
        };
      }
      return {
        action: { kind: 'click', x: state.x, y: state.y },
        next: { ...state, phase: 'focusing', attempts: state.attempts + 1, lastCheck: check },
      };
    }

    case 'done':
      return { action: { kind: 'success' }, next: state };

    case 'gaveUp':
      return {
        action: {
          kind: 'fail',
          reason: 'gave_up',
          detail: state.lastCheck?.message ?? '该项已放弃填分。',
        },
        next: state,
      };

    default: {
      // 穷尽性检查：新增 phase 时这里会编译报错，而不是运行时静默走 else
      const never: never = state.phase;
      return {
        action: { kind: 'fail', reason: 'unknown_phase', detail: `未知阶段：${String(never)}` },
        next: { ...state, phase: 'gaveUp' },
      };
    }
  }
}

/**
 * 把整条填分流程跑到结束（在纯逻辑里模拟）。
 *
 * 用途：单测里验证"重试 N 次后放弃""第二次成功"这类路径，
 * 而不需要在真机上制造这些条件。
 *
 * @param responder 每次需要回读时给出的校验结果
 */
export function runFillLoop(
  state: FillState,
  responder: (attempt: number) => FillCheck | undefined,
): { actions: FillAction[]; final: FillState } {
  const actions: FillAction[] = [];
  let cur = state;
  // 上限是防御性的：状态机若出错（死循环）也必须有明确终点
  for (let guard = 0; guard < 64; guard++) {
    const { action, next } = nextFillStep(cur, cur.phase === 'verifying' ? responder(cur.attempts) : undefined);
    actions.push(action);
    cur = next;
    if (action.kind === 'success' || action.kind === 'fail') break;
  }
  return { actions, final: cur };
}