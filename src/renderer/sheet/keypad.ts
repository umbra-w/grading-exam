/**
 * 教师小键盘极速批改流状态机 (Phase C2 —— 吸收小卷喵快捷键高效打分体验)。
 *
 * 快捷键契约：
 * 1. 数字键 0-9 / 小键盘 0-9 与小数点 '.'：向当前分值缓冲区累加输入（如先按 8 再按 .5 形成 8.5）
 * 2. 退格键 Backspace：删除缓冲区最后一位
 * 3. 回车键 Enter：提交当前缓冲区分数（填入平台或当前题）并清空缓冲区
 * 4. 空格键 Space：快速切换至下一份试卷
 * 5. Esc 键：清空当前缓冲区或暂停自动化
 */

export interface KeypadState {
  buffer: string;
  enabled: boolean;
}

export type KeypadAction =
  | { type: 'digit'; char: string }
  | { type: 'backspace' }
  | { type: 'clear' }
  | { type: 'toggle'; enabled?: boolean };

export function initialKeypadState(enabled = true): KeypadState {
  return { buffer: '', enabled };
}

export function keypadReducer(state: KeypadState, action: KeypadAction): KeypadState {
  if (action.type === 'toggle') {
    return { ...state, enabled: action.enabled ?? !state.enabled, buffer: '' };
  }

  if (!state.enabled) return state;

  switch (action.type) {
    case 'digit': {
      const char = action.char;
      if (char === '.' && state.buffer.includes('.')) {
        return state; // 防止重复输入小数点
      }
      if (state.buffer.length >= 6) {
        return state; // 限制分值字符串长度防溢出
      }
      return { ...state, buffer: state.buffer + char };
    }
    case 'backspace':
      return { ...state, buffer: state.buffer.slice(0, -1) };
    case 'clear':
      return { ...state, buffer: '' };
    default:
      return state;
  }
}

/**
 * 将键盘按键事件解析为教师批改动作指令。
 */
export function parseKeypadEvent(
  key: string,
  eventTargetTagName?: string
): 'commit' | 'next' | 'cancel' | { digit: string } | null {
  // 如果焦点当前处于输入框或文本域内，不拦截普通按键
  const tag = eventTargetTagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    return null;
  }

  if (key === 'Enter') return 'commit';
  if (key === ' ') return 'next';
  if (key === 'Escape') return 'cancel';

  if (/^[0-9.]$/.test(key)) {
    return { digit: key };
  }

  return null;
}
