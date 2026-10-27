/**
 * 试卷红笔批注与印章渲染引擎 (Phase A4)。
 *
 * 负责在答题卡 Canvas 画布上盖上真实的批改痕迹：
 * 1. 满分红勾 (✓)
 * 2. 零分红叉 (✗)
 * 3. 部分分半勾 (√-)
 * 4. 得分红圈徽章 (+分 / 扣分)
 * 5. 卷头总分双圈红印章 (如 "92 分")
 */

import type {
  AnnotationStamp,
  SheetGradeResult,
} from '../../shared/sheet-types';

export const RED_INK_COLOR = '#d92626';

/**
 * 根据整卷批改结果，自动为所有题目生成标准红笔批注图元。
 */
export function generateStampsForSheet(sheet: SheetGradeResult): AnnotationStamp[] {
  const stamps: AnnotationStamp[] = [];

  // 1. 卷头总分大印章（默认右上角）
  stamps.push({
    type: 'total_badge',
    x: 0.82,
    y: 0.05,
    score: sheet.totalScore,
    text: `${sheet.totalScore}分`,
    color: RED_INK_COLOR,
  });

  // 2. 逐题打勾/打叉/分值徽章
  for (const q of sheet.questions) {
    const { rect, status, awardedScore, comment } = q;
    // 标记置于题区右上偏内侧
    const markX = rect.x + rect.width * 0.85;
    const markY = rect.y + rect.height * 0.25;

    if (status === 'full') {
      stamps.push({
        type: 'checkmark',
        x: markX,
        y: markY,
        score: awardedScore,
        color: RED_INK_COLOR,
      });
    } else if (status === 'zero') {
      stamps.push({
        type: 'cross',
        x: markX,
        y: markY,
        score: 0,
        color: RED_INK_COLOR,
      });
    } else {
      stamps.push({
        type: 'half_check',
        x: markX,
        y: markY,
        score: awardedScore,
        color: RED_INK_COLOR,
      });
    }

    // 分值徽章
    stamps.push({
      type: 'score_badge',
      x: Math.min(0.95, markX + 0.04),
      y: markY,
      score: awardedScore,
      text: `+${awardedScore}`,
      color: RED_INK_COLOR,
    });

    // 若有失分评语，显示简评
    if (comment && status !== 'full') {
      stamps.push({
        type: 'text_comment',
        x: rect.x + 0.02,
        y: rect.y + rect.height * 0.85,
        text: comment.length > 25 ? comment.slice(0, 24) + '…' : comment,
        color: RED_INK_COLOR,
      });
    }
  }

  return stamps;
}

/**
 * 在 Canvas 2D 上绘制单枚批注印章。
 */
export function drawStamp(
  ctx: CanvasRenderingContext2D,
  stamp: AnnotationStamp,
  canvasWidth: number,
  canvasHeight: number
): void {
  const px = stamp.x * canvasWidth;
  const py = stamp.y * canvasHeight;
  const color = stamp.color ?? RED_INK_COLOR;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (stamp.type) {
    case 'checkmark': {
      // 飘逸红勾
      ctx.lineWidth = Math.max(3, canvasWidth * 0.0035);
      ctx.beginPath();
      ctx.moveTo(px - 14, py + 2);
      ctx.lineTo(px - 4, py + 14);
      ctx.lineTo(px + 22, py - 18);
      ctx.stroke();
      break;
    }

    case 'cross': {
      // 红叉
      ctx.lineWidth = Math.max(3, canvasWidth * 0.0035);
      const size = 12;
      ctx.beginPath();
      ctx.moveTo(px - size, py - size);
      ctx.lineTo(px + size, py + size);
      ctx.moveTo(px + size, py - size);
      ctx.lineTo(px - size, py + size);
      ctx.stroke();
      break;
    }

    case 'half_check': {
      // 半勾
      ctx.lineWidth = Math.max(3, canvasWidth * 0.0035);
      ctx.beginPath();
      ctx.moveTo(px - 12, py + 2);
      ctx.lineTo(px - 3, py + 12);
      ctx.lineTo(px + 14, py - 6);
      ctx.stroke();
      // 加一个小短横表示折分
      ctx.beginPath();
      ctx.moveTo(px + 18, py - 6);
      ctx.lineTo(px + 26, py - 6);
      ctx.stroke();
      break;
    }

    case 'score_badge': {
      // 红圈分值
      const radius = 16;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.font = 'bold 15px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(stamp.text ?? `${stamp.score ?? 0}`, px, py);
      break;
    }

    case 'total_badge': {
      // 卷头总分大印章（双圈）
      const outerR = 36;
      const innerR = 32;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(px, py, outerR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(px, py, innerR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(stamp.text ?? `${stamp.score ?? 0}`, px, py);
      break;
    }

    case 'text_comment': {
      if (stamp.text) {
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        // 淡淡的半透明白底防止背景杂色遮挡文字
        const textWidth = ctx.measureText(stamp.text).width;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.fillRect(px - 2, py - 14, textWidth + 4, 16);

        ctx.fillStyle = color;
        ctx.fillText(stamp.text, px, py);
      }
      break;
    }
  }

  ctx.restore();
}

/**
 * 将整组印章画在 Canvas 上。
 */
export function renderStamps(
  ctx: CanvasRenderingContext2D,
  stamps: readonly AnnotationStamp[],
  width: number,
  height: number
): void {
  for (const s of stamps) {
    drawStamp(ctx, s, width, height);
  }
}
