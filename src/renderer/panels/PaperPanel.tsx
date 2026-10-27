import type { JSX } from 'react';
import { PlaceholderPanel } from './PlaceholderPanel';

export function PaperPanel(): JSX.Element {
  return (
    <PlaceholderPanel
      title="整卷阅卷（批量批改）"
      glyph="▤"
      phase="Phase 5"
      items={[
        '试卷信息：手动录入题目 / 上传试卷文件由 AI 解析（含客观题答案与主观题得分点）',
        '题型分类：客观题（选择/判断/填空）本地归一化精确比对，零网络零 token',
        '主观题（简答/计算/论述）走 AI 评分，并发上限 3，带重试与节流',
        '学生答卷：批量上传图片由 AI 视觉识别姓名/考号与逐题答案；或从剪贴板批量导入',
        '汇总总分、排名、平均分、及格率，并按姓名或考号对应导出 Excel',
        '提交状态机（未提交/提交中/已提交/失败）保证幂等，同一答卷不得重复提交',
        '单份失败只告警并继续；中断后可从上次位置断点续跑，已完成结果不重算',
        '内建按题型 / 质量层 / 学科的分层统计，避免手工汇总误差',
      ]}
    />
  );
}