/**
 * 空白卷检测（照片导入路径）—— 渲染层与主进程共用的纯逻辑。
 *
 * 为什么放在 shared 而不是 main/page/quality：调用方有两个 ——
 *   · 批量图片导入面板（渲染层）：在调视觉模型**之前**逐图判定
 *   · quality.ts（主进程）：评分闸门 re-export 保持单一出口
 * 判定规则必须只有一份实现，两边各写一遍迟早在阈值上漂移。
 */

/**
 * 图片灰度统计（由薄绑定算出，本模块只做判定）。
 *
 * 为什么不直接复用 quality.ts 的 `blank` 检查：那个走的是 **PNG 压缩字节比**
 * （`encodedBytes / 像素数`）—— 对截图成立（近空白页 PNG 压得极小），
 * 对手机拍的照片**失效**：JPEG 无论内容几乎都压到相近体积，
 * 字节比判不出"这页没内容"。照片路径需要像素统计。
 *
 * 思路来源：小卷喵 0.16.0 的 `empty_paper_detection.pyx`
 * （调模型前用阈值判空白卷，逆向报告 rea_xjm/report_B §3）——
 * 该思路的纯函数化：统计量由薄绑定计算，判定保持可测。
 */
export interface GrayStats {
  /** 0..255 平均灰度 */
  mean: number;
  /** 灰度标准差：0 = 完全均匀（全白/全黑/纯色） */
  stdDev: number;
  /** 参与统计的采样像素数，必须 > 0 */
  samples: number;
}

/**
 * 空白卷判定的标准差上限（0..255 灰度尺度）。
 *
 * ⚠ **未标定的经验值**（与 `0.75` 置信度阈值同性质）：真实答卷照片
 * 即使空着也有纸张纹理、光照渐变、边角阴影，实测 sd 通常 ≥ 15；
 * 纯噪点扫描件 sd 约 2~6。6 是保守取值 —— 只拦"几乎纯色"的图，
 * 不确定时宁可放行（识别后走复核队列），不误杀真实答卷。
 * 标定需要真实答卷照片样本（BLOCKERS.md 的教师依赖）。
 */
export const BLANK_STDDEV_MAX = 6;

export type BlankVerdict = 'blank' | 'usable' | 'unknown';

/**
 * 判定一张照片是否"没有内容"，供批量导入在**调视觉模型之前**拦截。
 *
 * 为什么必须在 API 之前：空白页送去识别，模型要么编造答案（花钱买假分），
 * 要么返回全空（还得靠提示词约束才不至于猜）——两种都比"本地直接判空"
 * 差。判为 `blank` 的图**跳过 API 调用**，直接标记待人工确认。
 *
 * 三态与 quality.ts 的 `CheckState` 同纪律：
 *   · `blank`  —— 统计量可信且几乎无内容（不调 API）
 *   · `usable` —— 有内容（照常送识别）
 *   · `unknown`—— 统计量缺失/非法（**不猜**；放行送识别，
 *                 由识别结果与复核队列兜底 —— "没测"绝不冒充"测过"）
 */
export function classifyBlankPaper(stats: GrayStats | null): BlankVerdict {
  if (!stats) return 'unknown';
  const { mean, stdDev, samples } = stats;
  if (!Number.isFinite(mean) || !Number.isFinite(stdDev) || !(samples > 0)) return 'unknown';
  // 严格小于：正好压在阈值上的图按"有内容"处理（边界放行，宁可多花一次识别）
  return stdDev < BLANK_STDDEV_MAX ? 'blank' : 'usable';
}