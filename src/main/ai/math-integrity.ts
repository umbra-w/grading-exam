/**
 * 本地四则运算防幻觉对账层 (Math Integrity Gate)。
 *
 * 借鉴自木鱼阅卷逆向实战成果 (sizhejisuan)：
 * 大语言模型在批改包含多小题/多得分点的大题时，极易产生加减法算术幻觉
 * （例如各项给分 1, 2, 2, 0，但总分输出 6 或 4）。
 *
 * 本模块在客户端本地进行确定性代数求和与对账断言：
 * 1. 解析模型输出的算式（如 "1+2+2+0=5" 或 "1.5 + 2.5 = 4"）
 * 2. 检查表达式左右两端是否自洽相等
 * 3. 校验小题得分列表（subScores）求和与总分是否绝对一致
 * 4. 出现算术幻觉时给出明确报警、计算差额，供打折置信度或转人工复核
 */

export interface MathExpressionParseResult {
  operands: number[];
  declaredResult: number;
  actualSum: number;
  isSelfConsistent: boolean;
}

export interface MathIntegrityResult {
  /** 对账是否完全通过（无任何算术矛盾） */
  ok: boolean;
  /** 表达式左侧各项加和 */
  exprSum?: number;
  /** 小题列表求和 */
  subSum?: number;
  /** 系统接收到的总分 */
  totalScore: number;
  /** 推荐的修正总分（如有明确求和且总分有误） */
  suggestedScore?: number;
  /** 算术差异（模型总分 - 实际加和） */
  discrepancy: number;
  /** 对账失败的具体人话说明 */
  reason?: string;
}

/**
 * 规范化算术字符串：处理全角符号、汉字加号、多余空白等
 */
export function normalizeMathString(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/[＋﹢]/g, '+')
    .replace(/[＝﹦]/g, '=')
    .replace(/等于/g, '=')
    .replace(/加|与/g, '+')
    .replace(/\s+/g, '');
}

/**
 * 解析如 "1+2+2+0=5" 或 "2+3" 格式的加法求和表达式
 */
export function parseMathExpression(raw: string): MathExpressionParseResult | null {
  const normalized = normalizeMathString(raw);
  if (!normalized) return null;

  let leftPart = normalized;
  let rightPart: string | null = null;

  if (normalized.includes('=')) {
    const parts = normalized.split('=');
    if (parts.length === 2) {
      leftPart = parts[0];
      rightPart = parts[1];
    } else {
      return null;
    }
  }

  // 匹配所有加法操作数（支持小数与负数）
  const operandStrs = leftPart.split('+').filter((s) => s.length > 0);
  if (operandStrs.length === 0) return null;

  const operands: number[] = [];
  for (const s of operandStrs) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    operands.push(n);
  }

  // 计算浮点求和（防 0.1 + 0.2 = 0.30000000000000004 精度问题）
  const rawSum = operands.reduce((acc, curr) => acc + curr, 0);
  const actualSum = Math.round(rawSum * 100) / 100;

  let declaredResult = actualSum;
  let isSelfConsistent = true;

  if (rightPart !== null) {
    const declared = Number(rightPart);
    if (Number.isFinite(declared)) {
      declaredResult = declared;
      isSelfConsistent = Math.abs(declared - actualSum) < 0.001;
    } else {
      isSelfConsistent = false;
    }
  }

  return {
    operands,
    declaredResult,
    actualSum,
    isSelfConsistent,
  };
}

/**
 * 验证评分的四则运算自洽性
 */
export function verifyMathIntegrity(params: {
  score: number;
  subScores?: number[];
  mathExpression?: string;
}): MathIntegrityResult {
  const { score, subScores, mathExpression } = params;

  let exprSum: number | undefined;
  let subSum: number | undefined;
  let isExprOk = true;
  let isSubOk = true;
  const failureReasons: string[] = [];

  // 1. 检验表达式
  if (mathExpression && typeof mathExpression === 'string' && mathExpression.trim()) {
    const parsed = parseMathExpression(mathExpression);
    if (!parsed) {
      failureReasons.push(`加法表达式 "${mathExpression}" 格式无法解析`);
      isExprOk = false;
    } else {
      exprSum = parsed.actualSum;
      if (!parsed.isSelfConsistent) {
        failureReasons.push(
          `算术表达式自相矛盾：各小项加和为 ${parsed.actualSum}，但等号右边写为 ${parsed.declaredResult}`,
        );
        isExprOk = false;
      }
      if (Math.abs(parsed.actualSum - score) >= 0.001) {
        failureReasons.push(
          `算式加和 (${parsed.actualSum}) 与总得分 (${score}) 不一致`,
        );
        isExprOk = false;
      }
    }
  }

  // 2. 检验小题分列表
  if (Array.isArray(subScores) && subScores.length > 0) {
    const rawSubSum = subScores.reduce((acc, curr) => acc + (typeof curr === 'number' && Number.isFinite(curr) ? curr : 0), 0);
    subSum = Math.round(rawSubSum * 100) / 100;

    if (Math.abs(subSum - score) >= 0.001) {
      failureReasons.push(
        `小题分列表求和 [${subScores.join(', ')}] = ${subSum}，与总得分 ${score} 不一致`,
      );
      isSubOk = false;
    }

    if (exprSum !== undefined && Math.abs(subSum - exprSum) >= 0.001) {
      failureReasons.push(
        `小题列表和 (${subSum}) 与算式加和 (${exprSum}) 不一致`,
      );
      isSubOk = false;
    }
  }

  const ok = isExprOk && isSubOk;
  // 如果小题或算式求和自洽且可信，推荐使用该加和作为正确总分
  const suggestedScore = subSum !== undefined ? subSum : exprSum;
  const discrepancy = suggestedScore !== undefined ? Math.round((score - suggestedScore) * 100) / 100 : 0;

  return {
    ok,
    exprSum,
    subSum,
    totalScore: score,
    suggestedScore: ok ? undefined : suggestedScore,
    discrepancy,
    reason: ok ? undefined : failureReasons.join('；'),
  };
}
