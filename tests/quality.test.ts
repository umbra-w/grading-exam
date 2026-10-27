import { describe, expect, it } from 'vitest';
import {
  MARGINAL_LONGEST_EDGE,
  MIN_LONGEST_EDGE,
  classifyImageQuality,
  parsePngSize,
} from '../src/main/page/quality';

/*
 * 图片质量闸门。
 *
 * 这个模块要解决一个很具体的浪费：**图看不清的时候，模型不会说"我看不清"，
 * 它会编一个分**。而且我们付了钱。
 *
 * 所以闸门有两个作用，缺一不可：
 *   1. 把"根本不该送去评分的图"拦在 API 调用之前（省钱，且不产生假分）
 *   2. 把"勉强能看但不可靠的图"标记出来，结果走复核队列而不是自动填分
 *
 * ⚠ 阈值是**未标定的经验值**，与 `0.75` 置信度阈值同性质。
 * 标定需要真实平台的截图样本（BLOCKERS.md 的教师/账号依赖）。
 * 这里只保证：口径一致、可解释、可以一次改一处。
 */

describe('parsePngSize', () => {
  /** 造一个最小合法 PNG 头（签名 + IHDR），只到宽高就够 */
  function pngHeader(w: number, h: number): Uint8Array {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    // 接下来的 4 字节是 IHDR 长度，再 4 字节是 'IHDR'
    b.set([0x49, 0x48, 0x44, 0x52], 12);
    b[16] = (w >>> 24) & 0xff;
    b[17] = (w >>> 16) & 0xff;
    b[18] = (w >>> 8) & 0xff;
    b[19] = w & 0xff;
    b[20] = (h >>> 24) & 0xff;
    b[21] = (h >>> 16) & 0xff;
    b[22] = (h >>> 8) & 0xff;
    b[23] = h & 0xff;
    return b;
  }

  it('从 IHDR 读出宽高', () => {
    expect(parsePngSize(pngHeader(1280, 640))).toEqual({ width: 1280, height: 640 });
  });

  it('不是 PNG 就返回 null，不猜尺寸', () => {
    // 猜尺寸会让后续判定基于一个编出来的数字——比直接拒判更危险
    expect(parsePngSize(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).toBeNull();
  });

  it('太短就返回 null，不越界读', () => {
    expect(parsePngSize(new Uint8Array(0))).toBeNull();
    expect(parsePngSize(new Uint8Array(20))).toBeNull();
  });

  it('签名对但不是 IHDR 也返回 null', () => {
    const b = pngHeader(100, 100);
    b.set([0x58, 0x58, 0x58, 0x58], 12); // 把 'IHDR' 改掉
    expect(parsePngSize(b)).toBeNull();
  });
});

describe('classifyImageQuality', () => {
  const ok = { width: 1200, height: 500, devicePixelRatio: 1 };

  it('尺寸充足 → 可以直接评分', () => {
    const r = classifyImageQuality(ok);
    expect(r.verdict).toBe('ok');
    expect(r.mustReview).toBe(false);
    expect(r.longestEdge).toBe(1200);
    expect(r.effectiveWidth).toBe(1200);
  });

  it('无尺寸信息 → insufficient，必须复核（不能默认通过）', () => {
    // 「没测过」不等于「测过且通过」（§6.3 的同一条纪律）
    const r = classifyImageQuality({ width: null, height: null, devicePixelRatio: 1 });
    expect(r.verdict).toBe('insufficient');
    expect(r.mustReview).toBe(true);
  });

  it('过小 → too_small，必须复核', () => {
    const r = classifyImageQuality({ width: 120, height: 60, devicePixelRatio: 1 });
    expect(r.verdict).toBe('too_small');
    expect(r.mustReview).toBe(true);
  });

  it('边界：正好等于下限不再是 too_small（口径是 < 而不是 <=）', () => {
    // 三段口径：< MIN 不合格 / MIN~MARGINAL-1 偏小 / >= MARGINAL 通过
    const r = classifyImageQuality({ width: MIN_LONGEST_EDGE, height: 100, devicePixelRatio: 1 });
    expect(r.verdict).toBe('marginal');
  });

  it('边界：比下限少 1 像素就是 too_small', () => {
    const r = classifyImageQuality({ width: MIN_LONGEST_EDGE - 1, height: 100, devicePixelRatio: 1 });
    expect(r.verdict).toBe('too_small');
  });

  it('边界：正好等于建议下限就是 ok', () => {
    const r = classifyImageQuality({ width: MARGINAL_LONGEST_EDGE, height: 160, devicePixelRatio: 1 });
    expect(r.verdict).toBe('ok');
  });

  it('边界：比建议下限少 1 像素是 marginal', () => {
    const r = classifyImageQuality({ width: MARGINAL_LONGEST_EDGE - 1, height: 160, devicePixelRatio: 1 });
    expect(r.verdict).toBe('marginal');
  });

  it('高 DPR 按逻辑像素判定，不因像素多而放行', () => {
    /*
     * 这条是整个模块最容易写错的地方。
     * 2 倍缩放的截图像素数变成 4 倍，若直接按像素判，
     * 一个 300 逻辑像素宽的题目区域（远远看不清）会被判成"充足"。
     */
    const r = classifyImageQuality({ width: 600, height: 300, devicePixelRatio: 2 });
    expect(r.effectiveWidth).toBe(300);
    expect(r.verdict).toBe('too_small');
  });

  it('DPR 非法（0 / 负数 / NaN）时按 1 处理，不让它把判定带偏', () => {
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = classifyImageQuality({ width: 1200, height: 500, devicePixelRatio: bad });
      expect(r.devicePixelRatio).toBe(1);
      expect(r.verdict).toBe('ok');
    }
  });

  it('极窄长条 → aspect_suspect（多半拾取框选歪了）', () => {
    const r = classifyImageQuality({ width: 2000, height: 40, devicePixelRatio: 1 });
    expect(r.verdict).toBe('aspect_suspect');
    expect(r.mustReview).toBe(true);
    expect(r.reasons.join()).toContain('长宽比');
  });

  it('极窄长条但整体也小 → 报 too_small（更根本的问题优先）', () => {
    // 两种毛病同时存在时报更根本的那个，否则会去修长宽比而真正的问题是图太小
    const r = classifyImageQuality({ width: 120, height: 20, devicePixelRatio: 1 });
    expect(r.verdict).toBe('too_small');
  });

  it('压缩率异常低 → mostly_blank（截图多半是空白页）', () => {
    /*
     * 均匀白底的 PNG 压缩率极高。给一个"像素很多但字节极少"的样本，
     * 等于截图内容几乎为空——这种情况送去评分，模型会对着一片白编答案。
     */
    const r = classifyImageQuality({ ...ok, encodedBytes: 3000 });
    expect(r.verdict).toBe('mostly_blank');
    expect(r.mustReview).toBe(true);
  });

  it('字节数正常时不误报 mostly_blank', () => {
    const r = classifyImageQuality({ ...ok, encodedBytes: 400_000 });
    expect(r.verdict).toBe('ok');
  });

  it('没给 encodedBytes 就不做空白判定（不猜）', () => {
    const r = classifyImageQuality(ok);
    expect(r.verdict).toBe('ok');
    expect(r.checks.blank).toBe('not_measured');
  });

  it('三种判定都通过但偏小时 → marginal，可评分但提示复核', () => {
    // 450 落在 MIN(400) 与 MARGINAL(560) 之间
    const r = classifyImageQuality({ width: 450, height: 200, devicePixelRatio: 1 });
    expect(r.verdict).toBe('marginal');
    // marginal 不强制复核，但必须**提示**——否则这个分级没有意义
    expect(r.mustReview).toBe(false);
    expect(r.shouldReview).toBe(true);
  });

  it('三档必须能区分开：ok / marginal / too_small', () => {
    const vals = [
      classifyImageQuality({ width: 1400, height: 600, devicePixelRatio: 1 }).verdict,
      classifyImageQuality({ width: 450, height: 200, devicePixelRatio: 1 }).verdict,
      classifyImageQuality({ width: 80, height: 40, devicePixelRatio: 1 }).verdict,
    ];
    expect(vals).toEqual(['ok', 'marginal', 'too_small']);
  });

  it('每条判定都带可执行的处置建议，不只是"质量差"', () => {
    const r = classifyImageQuality({ width: 100, height: 50, devicePixelRatio: 1 });
    expect(r.advice.length).toBeGreaterThan(0);
    expect(r.reasons.length).toBeGreaterThan(0);
    // 建议要指向"怎么办"，不是复述"哪里坏了"
    expect(r.advice).not.toBe(r.reasons[0]);
  });
});

describe('分级与判定链的一致性', () => {
  it('mustReview 与 verdict 严格对应，不出现"判了坏却不用复核"', () => {
    const cases = [
      { width: 1200, height: 500, devicePixelRatio: 1 },
      { width: 100, height: 50, devicePixelRatio: 1 },
      { width: 2000, height: 40, devicePixelRatio: 1 },
      { width: 450, height: 200, devicePixelRatio: 1 },
      { width: null, height: null, devicePixelRatio: 1 },
    ];
    const mustReviewVerdicts = new Set(['too_small', 'mostly_blank', 'aspect_suspect', 'insufficient']);
    for (const c of cases) {
      const r = classifyImageQuality(c);
      expect(r.mustReview).toBe(mustReviewVerdicts.has(r.verdict));
    }
  });

  it('ok 既不强制也不建议复核', () => {
    const r = classifyImageQuality({ width: 1200, height: 500, devicePixelRatio: 1 });
    expect(r.mustReview).toBe(false);
    expect(r.shouldReview).toBe(false);
  });

  it('shouldReview 涵盖 mustReview（强制复核的必然也"建议复核"）', () => {
    const cases = [
      { width: 1200, height: 500, devicePixelRatio: 1 },
      { width: 100, height: 50, devicePixelRatio: 1 },
      { width: 2000, height: 40, devicePixelRatio: 1 },
      { width: 450, height: 200, devicePixelRatio: 1 },
      { width: null, height: null, devicePixelRatio: 1 },
    ];
    for (const c of cases) {
      const r = classifyImageQuality(c);
      if (r.mustReview) expect(r.shouldReview).toBe(true);
    }
  });
});