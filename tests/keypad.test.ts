import { describe, expect, it } from 'vitest';
import {
  initialKeypadState,
  keypadReducer,
  parseKeypadEvent,
} from '../src/renderer/sheet/keypad';

describe('小键盘快捷键批改流 (Phase C2)', () => {
  it('正确累加数字和小数点形成分值字符串', () => {
    let state = initialKeypadState(true);
    state = keypadReducer(state, { type: 'digit', char: '8' });
    expect(state.buffer).toBe('8');

    state = keypadReducer(state, { type: 'digit', char: '.' });
    state = keypadReducer(state, { type: 'digit', char: '5' });
    expect(state.buffer).toBe('8.5');

    // 重复输入小数点应被忽略
    state = keypadReducer(state, { type: 'digit', char: '.' });
    expect(state.buffer).toBe('8.5');
  });

  it('退格与清空操作正确', () => {
    let state = { buffer: '9.5', enabled: true };
    state = keypadReducer(state, { type: 'backspace' });
    expect(state.buffer).toBe('9.');

    state = keypadReducer(state, { type: 'clear' });
    expect(state.buffer).toBe('');
  });

  it('禁用状态下不吸收输入', () => {
    let state = { buffer: '', enabled: false };
    state = keypadReducer(state, { type: 'digit', char: '5' });
    expect(state.buffer).toBe('');
  });

  it('parseKeypadEvent 准确解析快捷键动作', () => {
    expect(parseKeypadEvent('Enter')).toBe('commit');
    expect(parseKeypadEvent(' ')).toBe('next');
    expect(parseKeypadEvent('Escape')).toBe('cancel');
    expect(parseKeypadEvent('7')).toEqual({ digit: '7' });
    expect(parseKeypadEvent('.')).toEqual({ digit: '.' });

    // 处于 input 或 textarea 焦点时不拦截
    expect(parseKeypadEvent('7', 'INPUT')).toBeNull();
    expect(parseKeypadEvent('Enter', 'TEXTAREA')).toBeNull();
  });
});
