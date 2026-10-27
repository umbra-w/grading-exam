/**
 * 连续阅卷状态机的单测。
 *
 * 这些测试替代不了真机验证（CDP 调用本身仍需真机），但它们钉住的是
 * **决策**：什么时候重试、什么时候放弃、什么时候允许提交。
 * 这些决策错了，真机上会表现为"少填了几份但成绩单看起来是完整的"——
 * 本项目最不能接受的一类结果。
 */
import { describe, it, expect } from 'vitest';
import {
  cleanScoreText,
  initialFillState,
  nextFillStep,
  runFillLoop,
  DEFAULT_MAX_ATTEMPTS,
  type FillState,
} from '../src/main/page/autoloop';
import type { FillCheck } from '../src/main/page/geometry';

const ok = (expected: string, actual: string): FillCheck => ({
  verdict: 'ok', expected, actual, message: '一致',
});
const mismatch = (expected: string, actual: string | null): FillCheck => ({
  verdict: 'mismatch', expected, actual, message: '不一致',
});
const empty = (expected: string): FillCheck => ({
  verdict: 'empty', expected, actual: '', message: '元素为空',
});
const unreadable = (expected: string): FillCheck => ({
  verdict: 'unreadable', expected, actual: null, message: '回读不到值：元素可能已被重渲染',
});

const cfg = { x: 100, y: 200 };

describe('cleanScoreText（分数清洗）', () => {
  it('去掉首尾空白与全角空格', () => {
    expect(cleanScoreText('  6.0  ')).toBe('6.0');
    expect(cleanScoreText('\u30006\u3000')).toBe('6');
  });

  it('全角数字转半角', () => {
    expect(cleanScoreText('６．５')).toBe('6.5');
    expect(cleanScoreText('１２')).toBe('12');
  });

  it('去掉千分位逗号', () => {
    expect(cleanScoreText('1,000')).toBe('1000');
  });

  it('去掉正号前缀', () => {
    expect(cleanScoreText('+5')).toBe('5');
  });

  it('去掉百分号（平台按分值理解，不按百分数）', () => {
    expect(cleanScoreText('50%')).toBe('50');
    expect(cleanScoreText('50％')).toBe('50');
  });

  it('★ 不擅自增删小数位（拿不准就保持原样）', () => {
    // 6 → 6，不变成 6.0 或 6.00。擅自改数值格式可能触发平台"格式错误"，
    // 而且改变了用户看到的东西
    expect(cleanScoreText('6')).toBe('6');
    expect(cleanScoreText('6.0')).toBe('6.0');
    expect(cleanScoreText('6.00')).toBe('6.00');
    expect(cleanScoreText('0.5')).toBe('0.5');
  });

  it('★ 空串与纯空白返回空串，而不是 0', () => {
    // 空分 ≠ 0 分。把空当 0 会静默给学生记零分
    expect(cleanScoreText('')).toBe('');
    expect(cleanScoreText('   ')).toBe('');
    expect(cleanScoreText('\u3000')).toBe('');
  });

  it('负号与小数点保留（负数在扣分场景可能出现）', () => {
    expect(cleanScoreText('-1.5')).toBe('-1.5');
  });

  it('非数字文本原样返回，交给回读校验去判失败', () => {
    // 清洗层不做"合法性判断"——那会让"文本被静默改掉"无法被发现
    expect(cleanScoreText('缺考')).toBe('缺考');
  });
});

describe('initialFillState', () => {
  it('文本经清洗后进入状态', () => {
    const s = initialFillState(' ６.０ ', cfg);
    expect(s.text).toBe('6.0');
    expect(s.phase).toBe('pending');
    expect(s.attempts).toBe(0);
  });

  it('默认写方式为 insert（DOM 受控组件），上限为 3', () => {
    const s = initialFillState('6', cfg);
    expect(s.write).toBe('insert');
    expect(s.maxAttempts).toBe(DEFAULT_MAX_ATTEMPTS);
  });

  it('可指定 type（Canvas 平台）与自定上限', () => {
    const s = initialFillState('6', { ...cfg, write: 'type', maxAttempts: 5 });
    expect(s.write).toBe('type');
    expect(s.maxAttempts).toBe(5);
  });
});

describe('nextFillStep —— 正常路径', () => {
  it('pending → 点击分数框，并计入一次尝试', () => {
    const s = initialFillState('6', cfg);
    const { action, next } = nextFillStep(s);
    expect(action).toEqual({ kind: 'click', x: 100, y: 200 });
    expect(next.phase).toBe('focusing');
    expect(next.attempts).toBe(1);
  });

  it('focusing → 全选（insertText 是插入不是替换，必须先清空）', () => {
    const s = { ...initialFillState('6', cfg), phase: 'focusing' as const };
    const { action, next } = nextFillStep(s);
    expect(action).toEqual({ kind: 'selectAll' });
    expect(next.phase).toBe('clearing');
  });

  it('clearing → 写入（insert 模式）', () => {
    const s = { ...initialFillState('6', cfg), phase: 'clearing' as const };
    const { action, next } = nextFillStep(s);
    expect(action).toEqual({ kind: 'insert', text: '6' });
    expect(next.phase).toBe('typing');
  });

  it('clearing → 写入（type 模式，Canvas 逐字符）', () => {
    const s = { ...initialFillState('6', { ...cfg, write: 'type' }), phase: 'clearing' as const };
    const { action } = nextFillStep(s);
    expect(action).toEqual({ kind: 'type', text: '6' });
  });

  it('★ typing → 必须回读校验，不许直接判成功', () => {
    // 这是"填了没反应"的防线：发出去了 ≠ 生效了
    const s = { ...initialFillState('6', cfg), phase: 'typing' as const };
    const { action, next } = nextFillStep(s);
    expect(action).toEqual({ kind: 'read' });
    expect(next.phase).toBe('verifying');
  });

  it('verifying + ok → success 并进入 done', () => {
    const s = { ...initialFillState('6', cfg), phase: 'verifying' as const };
    const { action, next } = nextFillStep(s, ok('6', '6'));
    expect(action).toEqual({ kind: 'success' });
    expect(next.phase).toBe('done');
    expect(next.lastCheck?.verdict).toBe('ok');
  });

  it('runFillLoop 走完正常路径的动作序列', () => {
    const { actions, final } = runFillLoop(initialFillState('6', cfg), () => ok('6', '6'));
    expect(actions.map((a) => a.kind)).toEqual(['click', 'selectAll', 'insert', 'read', 'success']);
    expect(final.phase).toBe('done');
  });
});

describe('nextFillStep —— 空分不填', () => {
  it('★ 分数为空 → 直接失败，且**不派发任何点击**', () => {
    // 空分被当成 0 填进去，等于静默给学生零分
    const s = initialFillState('   ', cfg);
    const { action, next } = nextFillStep(s);
    expect(action.kind).toBe('fail');
    if (action.kind === 'fail') expect(action.reason).toBe('empty_score');
    expect(next.phase).toBe('gaveUp');
  });

  it('空分时 runFillLoop 不产生任何 click', () => {
    const { actions } = runFillLoop(initialFillState('', cfg), () => ok('', ''));
    expect(actions.filter((a) => a.kind === 'click')).toHaveLength(0);
    expect(actions[0]!.kind).toBe('fail');
  });
});

describe('nextFillStep —— 失败与重试', () => {
  it('★ mismatch 且未到上限 → 重新点击重试', () => {
    const s = { ...initialFillState('6', cfg), phase: 'verifying' as const, attempts: 1 };
    const { action, next } = nextFillStep(s, mismatch('6', '5'));
    expect(action.kind).toBe('click');
    expect(next.phase).toBe('focusing');
    expect(next.attempts).toBe(2);
  });

  it('★ empty 也重试（框架可能把输入丢掉了）', () => {
    const s = { ...initialFillState('6', cfg), phase: 'verifying' as const, attempts: 1 };
    const { action } = nextFillStep(s, empty('6'));
    expect(action.kind).toBe('click');
  });

  it('★ unreadable 不重试，直接放弃（元素已不在，重试会点到别处）', () => {
    const s = { ...initialFillState('6', cfg), phase: 'verifying' as const, attempts: 1 };
    const { action, next } = nextFillStep(s, unreadable('6'));
    expect(action.kind).toBe('fail');
    if (action.kind === 'fail') {
      expect(action.reason).toBe('unreadable');
      expect(action.detail).toMatch(/重新拾取|重拾/);
    }
    expect(next.phase).toBe('gaveUp');
  });

  it('★ mismatch 到上限 → 放弃，错误信息里带期望值与实际值', () => {
    const s = {
      ...initialFillState('6', cfg),
      phase: 'verifying' as const,
      attempts: DEFAULT_MAX_ATTEMPTS,
    };
    const { action, next } = nextFillStep(s, mismatch('6', '5'));
    expect(action.kind).toBe('fail');
    if (action.kind === 'fail') {
      expect(action.reason).toBe('fill_not_verified');
      expect(action.detail).toMatch(/期望 6/);
      expect(action.detail).toMatch(/实际 5/);
      // 必须声明"未提交"——否则用户以为交上去了
      expect(action.detail).toMatch(/未提交/);
    }
    expect(next.phase).toBe('gaveUp');
  });

  it('★ 第二次尝试成功（含重试的完整序列）', () => {
    let n = 0;
    const { actions, final } = runFillLoop(initialFillState('6', cfg), () => {
      n++;
      return n === 1 ? mismatch('6', '') : ok('6', '6');
    });
    expect(actions.map((a) => a.kind)).toEqual([
      'click', 'selectAll', 'insert', 'read', // 第一次
      'click', 'selectAll', 'insert', 'read', // 重试
      'success',
    ]);
    expect(final.phase).toBe('done');
    expect(final.attempts).toBe(2);
  });

  it('★ 一直失败 → 重试次数恰好等于上限，然后放弃', () => {
    const { actions, final } = runFillLoop(initialFillState('6', cfg), () => mismatch('6', '0'));
    const clicks = actions.filter((a) => a.kind === 'click').length;
    expect(clicks).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(final.phase).toBe('gaveUp');
    expect(actions.at(-1)!.kind).toBe('fail');
  });

  it('★ 自定义上限生效', () => {
    const { actions } = runFillLoop(
      initialFillState('6', { ...cfg, maxAttempts: 5 }),
      () => mismatch('6', '0'),
    );
    expect(actions.filter((a) => a.kind === 'click')).toHaveLength(5);
  });

  it('★ deliverable：verifying 阶段没有校验结果 → 拒绝放行', () => {
    // 不放行未校验的写入：宁可失败也不假装成功
    const s = { ...initialFillState('6', cfg), phase: 'verifying' as const };
    const { action, next } = nextFillStep(s, undefined);
    expect(action.kind).toBe('fail');
    if (action.kind === 'fail') expect(action.reason).toBe('no_verify_result');
    expect(next.phase).toBe('gaveUp');
  });

  it('runFillLoop 的 responder 返回 undefined 时不会死循环', () => {
    const { actions } = runFillLoop(initialFillState('6', cfg), () => undefined);
    expect(actions.length).toBeLessThan(64);
    expect(actions.at(-1)!.kind).toBe('fail');
  });
});

describe('nextFillStep —— 终态幂等', () => {
  it('done 状态再推进仍是 success', () => {
    const s: FillState = { ...initialFillState('6', cfg), phase: 'done' };
    expect(nextFillStep(s).action.kind).toBe('success');
  });

  it('gaveUp 状态再推进仍是 fail（带上次的原因）', () => {
    const s: FillState = {
      ...initialFillState('6', cfg),
      phase: 'gaveUp',
      lastCheck: mismatch('6', '5'),
    };
    const { action } = nextFillStep(s);
    expect(action.kind).toBe('fail');
    if (action.kind === 'fail') expect(action.reason).toBe('gave_up');
  });
});

describe('不变量', () => {
  it('★ 任何路径都不会在未校验的情况下产生 success', () => {
    // 穷举：各种起始阶段 × 各种校验结果
    const phases = ['pending', 'focusing', 'clearing', 'typing', 'verifying'] as const;
    const checks: Array<FillCheck | undefined> = [
      undefined, ok('6', '6'), mismatch('6', '5'), empty('6'), unreadable('6'),
    ];
    for (const phase of phases) {
      for (const check of checks) {
        const { final } = runFillLoop(
          { ...initialFillState('6', cfg), phase },
          () => check,
        );
        if (final.phase === 'done') {
          expect(final.lastCheck?.verdict, `phase=${phase} 走了 success 但校验不是 ok`).toBe('ok');
        }
      }
    }
  });

  it('★ 从 pending 起跑的完整路径里，success 之前一定执行过 read', () => {
    // 这条只对"从头开始"成立：从 typing 起跑时 read 是该阶段的隐含语义，
    // 不产生动作。用一条过强的断言去覆盖两种情形是错的（本测试第一版就这样）。
    const checks: Array<FillCheck | undefined> = [ok('6', '6'), mismatch('6', '5'), empty('6')];
    for (const check of checks) {
      const { actions } = runFillLoop(initialFillState('6', cfg), () => check);
      const i = actions.findIndex((a) => a.kind === 'success');
      if (i >= 0) {
        expect(actions.slice(0, i).some((a) => a.kind === 'read')).toBe(true);
      }
    }
  });

  it('★ 成功的路径里，写入动作一定发生在 read 之前', () => {
    const { actions } = runFillLoop(initialFillState('6', cfg), () => ok('6', '6'));
    const write = actions.findIndex((a) => a.kind === 'insert' || a.kind === 'type');
    const read = actions.findIndex((a) => a.kind === 'read');
    expect(write).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(write);
  });

  it('★ 任何路径都不会写空文本', () => {
    // 注意：不能拿"空分"来做这个穷举——那会立刻走 empty_score 分支，
    // 根本到不了写入阶段，等于什么都没验证。
    // 要验证的是"有分数可写时，写入动作的文本不为空"。
    const phases = ['pending', 'focusing', 'clearing', 'typing', 'verifying'] as const;
    for (const phase of phases) {
      const { actions } = runFillLoop(
        { ...initialFillState('6', cfg), phase },
        () => empty('6'),
      );
      for (const a of actions) {
        if (a.kind === 'insert' || a.kind === 'type') {
          expect(a.text, `phase=${phase} 写入了空文本`).not.toBe('');
        }
      }
    }
  });

  it('★ 分数写成什么都没写出来时，绝不产生写入动作', () => {
    const { actions } = runFillLoop(initialFillState('   ', cfg), () => empty(''));
    expect(actions.some((a) => a.kind === 'insert' || a.kind === 'type')).toBe(false);
  });
});