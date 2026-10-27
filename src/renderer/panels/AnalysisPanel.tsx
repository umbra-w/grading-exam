import type { JSX } from 'react';
import { PlaceholderPanel } from './PlaceholderPanel';

export function AnalysisPanel(): JSX.Element {
  return (
    <PlaceholderPanel
      title="学情分析"
      glyph="◔"
      phase="Phase 6"
      items={[
        '聚合失分点并排序，生成失分 TOP 榜',
        '成绩分布分箱（0~20% / 20~40% / 40~60% / 60~80% / 80~100%），人数总和须等于参考人数',
        '生成学情报告：统计概览、失分点、教学改进建议（Markdown）',
        '报告导出到设置中的导出目录',
        '失败样本带错误类型标签，可直接汇入失败案例库（对应调研报告附录 B 卡片模板）',
      ]}
    />
  );
}