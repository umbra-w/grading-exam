import { describe, expect, it } from 'vitest';
import {
  PLATFORM_PRESETS,
  matchPlatformPreset,
  getPlatformPresetById,
} from '../src/shared/platform-presets';

describe('网阅平台预设库 (Phase B1)', () => {
  it('预设库完整包含主流平台智学网、好分数、七天网络与通用配置', () => {
    const ids = PLATFORM_PRESETS.map((p) => p.id);
    expect(ids).toContain('zhixue');
    expect(ids).toContain('haofenshu');
    expect(ids).toContain('qitian');
    expect(ids).toContain('generic');

    // 每个平台都必须有题区、分数框、提交按钮候选链
    for (const p of PLATFORM_PRESETS) {
      expect(p.selectors.questionArea.length).toBeGreaterThan(0);
      expect(p.selectors.scoreInput.length).toBeGreaterThan(0);
      expect(p.selectors.submitButton.length).toBeGreaterThan(0);
      expect(p.defaultThrottleMs).toBeGreaterThanOrEqual(1000);
    }
  });

  it('能根据智学网域名准确匹配 zhixue 预设', () => {
    const p1 = matchPlatformPreset('https://teacher.zhixue.com/marking/paper?examId=123');
    expect(p1.id).toBe('zhixue');
    expect(p1.name).toBe('智学网');

    const p2 = matchPlatformPreset('http://marking.zhixue.com/task');
    expect(p2.id).toBe('zhixue');
  });

  it('能根据好分数/易择域名准确匹配 haofenshu 预设', () => {
    const p1 = matchPlatformPreset('https://mark.haofenshu.com/marking/index');
    expect(p1.id).toBe('haofenshu');

    const p2 = matchPlatformPreset('https://www.yize.com/grade/sheet');
    expect(p2.id).toBe('haofenshu');
  });

  it('能根据七天网络域名准确匹配 qitian 预设', () => {
    const p = matchPlatformPreset('https://mark.7tin.cn/teacher/grading');
    expect(p.id).toBe('qitian');
  });

  it('未知域名或空 URL 安全回落到通用平台 (generic)', () => {
    const p1 = matchPlatformPreset('https://unknown-exam-platform.edu.cn');
    expect(p1.id).toBe('generic');

    const p2 = matchPlatformPreset('');
    expect(p2.id).toBe('generic');
  });

  it('getPlatformPresetById 能根据 ID 获取对应预设', () => {
    const p = getPlatformPresetById('zhixue');
    expect(p.id).toBe('zhixue');

    const fallback = getPlatformPresetById('non-existent');
    expect(fallback.id).toBe('generic');
  });
});
