import type { JSX } from 'react';
import { PlaceholderPanel } from './PlaceholderPanel';

export function SinglePanel(): JSX.Element {
  return (
    <PlaceholderPanel
      title="智能阅卷（单题批改）"
      glyph="✎"
      phase="Phase 4"
      items={[
        '评分标准两种录入方式可切换：手动输入 / 上传试卷文件（.docx .pdf .txt .md）',
        '上传后由 AI 解析出题目、满分、参考答案与得分点，支持切题与手动修改',
        '学生答案输入：粘贴文本 / 粘贴截图 / 从剪贴板批量粘贴',
        '学生姓名与考号选填，软件自动从答案首行或图片中识别',
        '点击「AI 评分」输出分数、评语、命中点与失分点',
        '0 分必须作为正常结果处理，不得被当作失败',
        '每次评分返回置信度与复核建议；低置信度进入复核队列，不得静默跳过',
      ]}
    />
  );
}