/**
 * 自动化纯逻辑单测 —— Phase 2 里唯一能在本机验证的部分。
 *
 * 本机 Electron 起不来（BLOCKERS.md B3），窗口级行为无法验证。
 * 所以这里把「坐标累加 / 回读判定 / 错误分类 / 幂等提交 / 像素比换算」
 * 全部钉死——它们正是踩坑最多、代价最高的地方。
 */
import { describe, it, expect } from 'vitest';
import {
  accumulateOffset,
  centerOf,
  toTopClickPoint,
  isPointInViewport,
  readReturnedValue,
  verifyFilledValue,
  normalizeNumeric,
  classifyError,
  canSubmit,
  nextSubmitState,
  toDevicePixelClip,
  keyInfoForKey,
  summarizeRun,
  throttledDelay,
  type Rect,
} from '../src/main/page/geometry';

const rect = (x: number, y: number, w: number, h: number): Rect => ({ x, y, width: w, height: h });

/* -------------------------------------------- 约束 3：坐标累加 */

describe('accumulateOffset —— 跨域 iframe 坐标累加', () => {
  it('无 iframe 时原样返回', () => {
    expect(accumulateOffset(rect(10, 20, 100, 40), [])).toEqual(rect(10, 20, 100, 40));
  });

  it('单层 iframe：加上该 iframe 的偏移', () => {
    const r = accumulateOffset(rect(10, 20, 100, 40), [rect(300, 150, 800, 600)]);
    expect(r).toEqual(rect(310, 170, 100, 40));
  });

  it('★ 两层嵌套 iframe：必须逐层累加，尺寸取最内层', () => {
    // 外层 iframe 在 (100, 50)，内层 iframe 在外层视口的 (20, 30)
    // 内层元素说自己在 (5, 5) → 顶层应为 (125, 85)
    const r = accumulateOffset(rect(5, 5, 60, 24), [rect(100, 50, 900, 700), rect(20, 30, 400, 300)]);
    expect(r.x).toBe(125);
    expect(r.y).toBe(85);
    expect(r.width).toBe(60); // 尺寸不累加
    expect(r.height).toBe(24);
  });

  it('负偏移（frame 被滚动到视口外）也正确累加', () => {
    const r = accumulateOffset(rect(10, 10, 50, 20), [rect(-30, -40, 400, 300)]);
    expect(r.x).toBe(-20);
    expect(r.y).toBe(-30);
  });

  it('小数偏移不被取整（精度留到点击时再处理）', () => {
    const r = accumulateOffset(rect(1.4, 2.6, 10, 10), [rect(0.5, 0.5, 100, 100)]);
    expect(r.x).toBeCloseTo(1.9);
    expect(r.y).toBeCloseTo(3.1);
  });
});

describe('centerOf / toTopClickPoint', () => {
  it('取矩形中心', () => {
    expect(centerOf(rect(10, 20, 100, 40))).toEqual({ x: 60, y: 40 });
  });

  it('中心点取整（CDP 需要整数坐标）', () => {
    const p = centerOf(rect(10, 20, 101, 41));
    expect(Number.isInteger(p.x)).toBe(true);
    expect(Number.isInteger(p.y)).toBe(true);
  });

  it('★ 端到端：iframe 内元素的顶层点击点', () => {
    // 内层元素 (5,5,60,24)，内层 iframe 在外层 (20,30)，外层 iframe 在顶层 (100,50)
    const pt = toTopClickPoint(rect(5, 5, 60, 24), [rect(100, 50, 900, 700), rect(20, 30, 400, 300)]);
    expect(pt).toEqual({ x: 155, y: 97 }); // 125 + 30, 85 + 12
  });
});

describe('isPointInViewport —— 派发前拦截', () => {
  const vp = { width: 1280, height: 800 };

  it('视口内为 true', () => {
    expect(isPointInViewport({ x: 640, y: 400 }, vp)).toBe(true);
    expect(isPointInViewport({ x: 0, y: 0 }, vp)).toBe(true);
  });

  it('★ 视口外为 false —— 宁可什么都不做，也不要点错', () => {
    // 坐标算错时若直接派发，可能点到别的按钮（例如误提交），这是不可逆的
    expect(isPointInViewport({ x: -1, y: 400 }, vp)).toBe(false);
    expect(isPointInViewport({ x: 640, y: -1 }, vp)).toBe(false);
    expect(isPointInViewport({ x: 1280, y: 400 }, vp)).toBe(false); // 右边界不含
    expect(isPointInViewport({ x: 640, y: 800 }, vp)).toBe(false);
  });
});

/* ---------------------------------------- 约束 1：填分回读判定 */

describe('readReturnedValue —— 处理各种 RemoteObject 形态', () => {
  it('原始类型', () => {
    expect(readReturnedValue('6')).toBe('6');
    expect(readReturnedValue(6)).toBe('6');
    expect(readReturnedValue(true)).toBe('true');
  });

  it('null / undefined → null', () => {
    expect(readReturnedValue(null)).toBeNull();
    expect(readReturnedValue(undefined)).toBeNull();
  });

  it('CDP 的 {value} 包装', () => {
    expect(readReturnedValue({ value: 5.5 })).toBe('5.5');
    expect(readReturnedValue({ value: null })).toBeNull();
    expect(readReturnedValue({ value: undefined })).toBeNull();
  });

  it('unserializableValue（NaN / Infinity）', () => {
    expect(readReturnedValue({ unserializableValue: 'NaN' })).toBe('NaN');
  });

  it('description 兜底', () => {
    expect(readReturnedValue({ description: 'HTMLInputElement' })).toBe('HTMLInputElement');
  });

  it('对象值被 JSON 化，不抛异常', () => {
    expect(readReturnedValue({ value: { a: 1 } })).toBe('{"a":1}');
  });
});

describe('normalizeNumeric —— 消除平台回读的无害差异', () => {
  it('6 与 6.0 视为同一值', () => {
    expect(normalizeNumeric('6')).toBe(normalizeNumeric('6.0'));
  });

  it('去空白与单位', () => {
    expect(normalizeNumeric(' 6.5 ')).toBe('6.5');
    expect(normalizeNumeric('6分')).toBe('6');
    expect(normalizeNumeric('6点')).toBe('6');
  });

  it('全角数字与全角小数点', () => {
    expect(normalizeNumeric('６')).toBe('6');
    expect(normalizeNumeric('６．５')).toBe('6.5');
  });

  it('非数值内容退化为去空白比较', () => {
    expect(normalizeNumeric('abc')).toBe('abc');
    expect(normalizeNumeric(' a b ')).toBe('ab');
  });
});

describe('verifyFilledValue —— 区分四种回读结果', () => {
  it('一致 → ok', () => {
    expect(verifyFilledValue('6', '6').verdict).toBe('ok');
    expect(verifyFilledValue('6.0', '6').verdict).toBe('ok');
    expect(verifyFilledValue(' 5.5 ', '5.5').verdict).toBe('ok');
  });

  it('★ 回读不到值 → unreadable（元素可能已被重渲染）', () => {
    const r = verifyFilledValue('6', null);
    expect(r.verdict).toBe('unreadable');
    expect(r.message).toContain('重新拾取');
  });

  it('★ 回读为空 → empty（写入未生效，受控组件典型故障）', () => {
    const r = verifyFilledValue('6', '');
    expect(r.verdict).toBe('empty');
    expect(r.message).toContain('受信任输入事件');
  });

  it('★ 值不一致 → mismatch', () => {
    const r = verifyFilledValue('6', '5');
    expect(r.verdict).toBe('mismatch');
    expect(r.message).toContain('期望 6');
  });

  it('unreadable 优先于 mismatch —— 两种故障处置不同', () => {
    // 回读不到值时要重拾元素；值不对时要重填。混为一谈会误导排查方向。
    expect(verifyFilledValue('6', null).verdict).toBe('unreadable');
  });

  it('纯空白回读算 empty 而非 mismatch', () => {
    expect(verifyFilledValue('6', '   ').verdict).toBe('empty');
  });
});

/* ---------------------------------------------------- 错误分类 */

describe('classifyError —— 决定「中断整轮」还是「只告警」', () => {
  it('★ VALUE_MISMATCH 不中断、可重试（SPEC P2-8）', () => {
    const c = classifyError('VALUE_MISMATCH: 期望 6 实际 5');
    expect(c.kind).toBe('VALUE_MISMATCH');
    expect(c.fatal).toBe(false);
    expect(c.retryable).toBe(true);
  });

  it('★ PAGE_CHANGED 中断整轮（平台改版，必须重拾）', () => {
    const c = classifyError('PAGE_CHANGED 页面结构指纹不一致');
    expect(c.kind).toBe('PAGE_CHANGED');
    expect(c.fatal).toBe(true);
    expect(c.action).toContain('重新拾取');
  });

  it('★ OUT_OF_VIEWPORT 不重试（重试也没用）', () => {
    const c = classifyError('OUT_OF_VIEWPORT 坐标超出视口');
    expect(c.kind).toBe('OUT_OF_VIEWPORT');
    expect(c.retryable).toBe(false);
  });

  it('未拾取 → PICK_MISSING', () => {
    expect(classifyError('scoreInput 未拾取').kind).toBe('PICK_MISSING');
    expect(classifyError('PICK_MISSING').kind).toBe('PICK_MISSING');
  });

  it('超时 → TIMEOUT 且可重试', () => {
    const c = classifyError('等待下一份试卷超时');
    expect(c.kind).toBe('TIMEOUT');
    expect(c.retryable).toBe(true);
  });

  it('AI 评分失败 → AI_FAILED，不中断轮次', () => {
    const c = classifyError('评分失败: EMPTY_CONTENT');
    expect(c.kind).toBe('AI_FAILED');
    expect(c.fatal).toBe(false);
  });

  it('用户取消 → CANCELLED', () => {
    expect(classifyError('用户主动停止').kind).toBe('CANCELLED');
    expect(classifyError('已停止').kind).toBe('CANCELLED');
    expect(classifyError('用户取消运行').kind).toBe('CANCELLED');
  });

  it('★ 但"页面停止响应"不能被误判为用户取消', () => {
    // /停止/ 放宽后会引入这个风险，用本用例钉死
    expect(classifyError('页面停止响应，结构已变化').kind).toBe('PAGE_CHANGED');
  });

  it('未知错误 → UNKNOWN，保留原文', () => {
    const c = classifyError('某个没见过的问题');
    expect(c.kind).toBe('UNKNOWN');
    expect(c.message).toBe('某个没见过的问题');
  });

  it('空输入不抛异常', () => {
    expect(() => classifyError('')).not.toThrow();
    expect(classifyError('').kind).toBe('UNKNOWN');
  });
});

/* ---------------------------------------------- 幂等提交状态机 */

describe('幂等提交 —— 重复提交是不可逆副作用', () => {
  it('★ 同一份已提交过 → 不允许再提交', () => {
    expect(canSubmit('idle', 'SUB-1', new Set(['SUB-1']))).toBe(false);
  });

  it('★ inFlight 期间不允许再次提交', () => {
    expect(canSubmit('inFlight', 'SUB-2', new Set())).toBe(false);
  });

  it('已提交状态不允许再提交', () => {
    expect(canSubmit('submitted', 'SUB-3', new Set())).toBe(false);
  });

  it('新的一份且空闲 → 允许', () => {
    expect(canSubmit('idle', 'SUB-4', new Set(['SUB-1']))).toBe(true);
  });

  it('失败后可重试', () => {
    expect(canSubmit('failed', 'SUB-5', new Set())).toBe(true);
  });
});

describe('nextSubmitState —— 只允许合法迁移', () => {
  it('正常路径 idle → inFlight → submitted', () => {
    expect(nextSubmitState('idle', 'start')).toBe('inFlight');
    expect(nextSubmitState('inFlight', 'ok')).toBe('submitted');
  });

  it('失败路径', () => {
    expect(nextSubmitState('inFlight', 'fail')).toBe('failed');
    expect(nextSubmitState('failed', 'start')).toBe('inFlight');
  });

  it('★ 非法迁移不改状态（防止状态被意外重置）', () => {
    expect(nextSubmitState('idle', 'ok')).toBe('idle');
    expect(nextSubmitState('submitted', 'start')).toBe('submitted');
    expect(nextSubmitState('inFlight', 'inFlight' as never)).toBe('inFlight');
  });

  it('reset 回到 idle', () => {
    expect(nextSubmitState('submitted', 'reset')).toBe('idle');
    expect(nextSubmitState('failed', 'reset')).toBe('idle');
  });
});

/* ------------------------------------------------ 截图像素比 */

describe('toDevicePixelClip —— 高分屏截图裁剪', () => {
  const vp = { width: 1280, height: 800 };

  it('dpr=1 时不变', () => {
    const c = toDevicePixelClip(rect(100, 200, 300, 400), 1, vp);
    expect(c).toMatchObject({ x: 100, y: 200, width: 300, height: 400, scale: 1 });
  });

  it('★ dpr=2 时按设备像素放大 —— 否则高分屏裁出偏移区域', () => {
    const c = toDevicePixelClip(rect(100, 200, 300, 400), 2, vp);
    expect(c).toMatchObject({ x: 200, y: 400, width: 600, height: 800, scale: 2 });
  });

  it('非法 dpr 回退为 1', () => {
    expect(toDevicePixelClip(rect(10, 10, 10, 10), 0, vp).scale).toBe(1);
    expect(toDevicePixelClip(rect(10, 10, 10, 10), -2, vp).scale).toBe(1);
  });

  it('★ 越界矩形被夹进视口（避免裁出空白图）', () => {
    const c = toDevicePixelClip(rect(1200, 700, 500, 500), 1, vp);
    expect(c.x).toBe(1200);
    expect(c.y).toBe(700);
    expect(c.width).toBe(80); // 1280-1200
    expect(c.height).toBe(100); // 800-700
  });

  it('完全在视口外时仍给出至少 1×1，不产生 0 尺寸', () => {
    const c = toDevicePixelClip(rect(5000, 5000, 10, 10), 1, vp);
    expect(c.width).toBeGreaterThanOrEqual(1);
    expect(c.height).toBeGreaterThanOrEqual(1);
  });
});

/* --------------------------------------------------- 键位映射 */

describe('keyInfoForKey —— Canvas 平台靠 keydown 判定', () => {
  it('命名键有正确 keyCode', () => {
    expect(keyInfoForKey('Enter').keyCode).toBe(13);
    expect(keyInfoForKey('Tab').keyCode).toBe(9);
    expect(keyInfoForKey('Backspace').keyCode).toBe(8);
    expect(keyInfoForKey('Escape').keyCode).toBe(27);
  });

  it('★ 数字与字母按 US 布局推算 keyCode', () => {
    // keyCode 错会导致 Canvas 平台忽略输入
    expect(keyInfoForKey('5').keyCode).toBe(53);
    expect(keyInfoForKey('A').keyCode).toBe(65);
    expect(keyInfoForKey('0').keyCode).toBe(48);
  });

  it('数字键带 text，供模拟输入', () => {
    expect(keyInfoForKey('7').text).toBe('7');
  });

  it('小数点', () => {
    expect(keyInfoForKey('.').keyCode).toBe(190);
    expect(keyInfoForKey('.').text).toBe('.');
  });

  it('小写字母也能正确推算', () => {
    expect(keyInfoForKey('a').keyCode).toBe(65);
    expect(keyInfoForKey('a').code).toBe('KeyA');
  });

  it('未知键不抛异常', () => {
    expect(() => keyInfoForKey('F13')).not.toThrow();
    expect(keyInfoForKey('F13').code).toBe('F13');
  });
});

/* -------------------------------------------- 单份隔离与续跑 */

describe('summarizeRun —— 单份隔离 + 断点续跑', () => {
  it('★ 一份失败不影响其他份（不做短路）', () => {
    const s = summarizeRun([
      { submissionId: 'A', ok: true, submitted: true },
      { submissionId: 'B', ok: false, errorKind: 'VALUE_MISMATCH', submitted: false },
      { submissionId: 'C', ok: true, submitted: true },
    ]);
    expect(s.total).toBe(3);
    expect(s.succeeded).toBe(2);
    expect(s.failed).toBe(1);
    expect(s.completedIds).toEqual(['A', 'C']);
    expect(s.failedIds).toEqual(['B']);
  });

  it('★ 续跑只处理未完成的', () => {
    const s = summarizeRun([
      { submissionId: 'A', ok: true, submitted: true },
      { submissionId: 'B', ok: false, errorKind: 'TIMEOUT', submitted: false },
    ]);
    expect(s.completedIds).not.toContain('B');
    expect(s.failedIds).toContain('B');
  });

  it('致命错误被识别出来（用于触发整轮暂停）', () => {
    const s = summarizeRun([
      { submissionId: 'A', ok: false, errorKind: 'PAGE_CHANGED', submitted: false },
    ]);
    expect(s.fatalKinds).toContain('PAGE_CHANGED');
  });

  it('已成功但未提交（仅 AI 评分模式）不计入 submitted', () => {
    const s = summarizeRun([{ submissionId: 'A', ok: true, submitted: false }]);
    expect(s.succeeded).toBe(1);
    expect(s.submitted).toBe(0);
  });

  it('空输入安全', () => {
    expect(summarizeRun([])).toMatchObject({ total: 0, succeeded: 0, failed: 0 });
  });
});

/* ------------------------------------------------------- 节流 */

describe('throttledDelay —— 抖动降低被风控概率', () => {
  it('±20% 区间内', () => {
    const lo = throttledDelay(1000, 0.2, () => 0);
    const hi = throttledDelay(1000, 0.2, () => 1);
    expect(lo).toBe(800);
    expect(hi).toBe(1200);
  });

  it('jitter=0 时精确等于基准', () => {
    expect(throttledDelay(500, 0, () => 0.5)).toBe(500);
  });

  it('jitter 被限制在 0.5 以内（避免延迟过大）', () => {
    expect(throttledDelay(1000, 10, () => 0)).toBe(500);
  });

  it('base=0 直接返回 0', () => {
    expect(throttledDelay(0, 0.2)).toBe(0);
  });

  it('结果非负', () => {
    for (let i = 0; i < 20; i++) {
      expect(throttledDelay(100, 0.5)).toBeGreaterThanOrEqual(0);
    }
  });
});