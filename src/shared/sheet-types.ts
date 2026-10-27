/**
 * 答题卡批改模块核心类型契约（Phase A 本地答题卡批改闭环）。
 *
 * 涵盖：
 * 1. 题区坐标与模板定义 (SheetRegion, SheetTemplate)
 * 2. 客观题 OMR 填涂识别结果 (OmrResult)
 * 3. 批改结果与分值 (QuestionGradeResult, SheetGradeResult)
 * 4. 红笔批注与印章图元 (AnnotationStamp)
 */

export interface NormalizedRect {
  /** 相对左侧坐标 0..1 */
  x: number;
  /** 相对顶部坐标 0..1 */
  y: number;
  /** 相对宽度 0..1 */
  width: number;
  /** 相对高度 0..1 */
  height: number;
}

export type SheetQuestionType = 'objective' | 'subjective';

export interface SheetRegion {
  id: string;
  questionNo: string;
  title: string;
  type: SheetQuestionType;
  fullScore: number;
  rect: NormalizedRect;
  /** 客观题标准答案（如 "B" 或 "ACD"） */
  standardAnswer?: string;
  /** 客观题选项数（默认 4 项：A, B, C, D） */
  optionCount?: number;
  /** 主观题评分要点/细则 */
  rubric?: string;
}

export interface SheetTemplate {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  regions: SheetRegion[];
}

export interface OmrOptionDetail {
  option: string;
  /** 填涂灰度占比 0..1（越黑越接近 1） */
  fillRatio: number;
  /** 是否判定为填涂 */
  isFilled: boolean;
}

export interface OmrResult {
  questionNo: string;
  /** 识别出的答案字符串，如 "B"、"AC" 或 ""（未作答） */
  recognizedAnswer: string;
  options: OmrOptionDetail[];
  /** 判定置信度 0..1 */
  confidence: number;
  /** 是否为空白未作答 */
  isBlank: boolean;
}

export type GradeStatus = 'full' | 'partial' | 'zero';

export interface QuestionGradeResult {
  questionNo: string;
  type: SheetQuestionType;
  fullScore: number;
  awardedScore: number;
  status: GradeStatus;
  studentAnswer: string;
  comment: string;
  confidence: number;
  rect: NormalizedRect;
}

export interface SheetGradeResult {
  sheetId: string;
  fileName: string;
  studentName?: string;
  studentId?: string;
  totalScore: number;
  maxScore: number;
  questions: QuestionGradeResult[];
  gradedAt: string;
}

export type StampType =
  | 'checkmark'     // 满分打勾 ✓
  | 'cross'         // 0分打叉 ✗
  | 'half_check'    // 部分分半勾 √-
  | 'score_badge'   // 单题分值章
  | 'total_badge'   // 整卷总分双圈红章
  | 'text_comment'; // 评语/扣分原因

export interface AnnotationStamp {
  type: StampType;
  /** 相对坐标 0..1 */
  x: number;
  y: number;
  score?: number;
  text?: string;
  color?: string;
}
