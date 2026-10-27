/**
 * 导出 —— 把批改结果落成 Excel / Markdown。
 *
 * 拆成"纯函数构造数据"+"薄绑定写文件"两层：
 *   · `buildWorkbookRows` / `buildMarkdown` 是纯函数 → 可单测
 *   · `exportExcel` / `exportMarkdown` 只负责调用库并写盘 → 依赖真实 fs
 * 本机 Electron 起不来（BLOCKERS.md B3），这是唯一能验证导出内容正确性的办法。
 *
 * 两个已知的真实坑，都在这里处理：
 *   1. **Excel 中文乱码**：exceljs 写的是标准 xlsx（内部 UTF-8），不存在乱码；
 *      真正的乱码来源是"用 exceljs 导出却让用户存成 CSV"。因此这里只出 xlsx，
 *      并且明确不提供 CSV——避免用户拿到 UTF-8 CSV 用 Excel 打开满屏问号。
 *   2. **列宽与对齐**：中文列宽按字符数算会偏窄（中文比英文宽），
 *      所以宽度按"字符显示宽度"估算，CJK 记 2。
 */

import type { PaperReport, StudentResult } from '@shared/types';

/* ------------------------------------------------------------ 纯函数层 */

/** 一个单元格的显示宽度：CJK 与全角字符算 2，其余算 1 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||   // 韩文字母
      (code >= 0x2e80 && code <= 0xa4cf) ||   // CJK 部首、假名、汉字
      (code >= 0xac00 && code <= 0xd7a3) ||   // 韩文音节
      (code >= 0xf900 && code <= 0xfaff) ||   // CJK 兼容汉字
      (code >= 0xfe30 && code <= 0xfe6f) ||   // CJK 兼容形式
      (code >= 0xff00 && code <= 0xff60) ||   // 全角形式
      (code >= 0xffe0 && code <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

/** 根据表头与数据行算一个合适的列宽（exceljs 的单位约等于"字符数"） */
export function columnWidth(header: string, cells: string[], min = 8, max = 60): number {
  const widest = [header, ...cells].reduce((m, c) => Math.max(m, displayWidth(c)), 0);
  return Math.min(max, Math.max(min, widest + 2));
}

/** 明细表的一行（扁平化，便于 Excel 与 Markdown 共用） */
export interface DetailRow {
  姓名: string;
  考号: string;
  题号: string;
  题型: string;
  满分: string;
  得分: string;
  得分点: string;
  失分点: string;
  评语: string;
  置信度: string;
  需复核: string;
}

/** 题型的中文显示名。与 CONTRACT.md 的枚举一一对应，不认识的类型原样返回 */
const TYPE_CN: Record<string, string> = {
  choice: '选择',
  judge: '判断',
  fill: '填空',
  short: '简答',
  calc: '计算',
  essay: '论述',
};

export function typeLabel(t: string): string {
  return TYPE_CN[t] ?? t;
}

/**
 * 把报告摊平成明细行。
 *
 * 为什么用**明细（每题一行）**而不是一人一行宽表：
 * 一人一行在题目数变化时列数会变，不同班级的表格无法直接对比，
 * 而且合并单元格里塞不下评语。明细表可以透视成任何宽表，反之不行。
 */
export function buildWorkbookRows(report: PaperReport): DetailRow[] {
  const rows: DetailRow[] = [];
  for (const s of report.results) {
    if (s.details.length === 0) {
      // 允许"只统计没明细"的情况（例如只导总分），但要留一行占位，
      // 否则这个学生在明细表里会凭空消失
      rows.push({
        姓名: s.name, 考号: s.examNo, 题号: '—', 题型: '—',
        满分: String(s.fullTotal), 得分: String(s.total),
        得分点: '', 失分点: '', 评语: s.comment,
        置信度: '', 需复核: '',
      });
      continue;
    }
    for (const d of s.details) {
      const needsReview = d.confidence < 0.75;
      rows.push({
        姓名: s.name,
        考号: s.examNo,
        题号: d.questionId,
        题型: typeLabel(d.type),
        满分: String(d.fullScore),
        得分: String(d.score),
        得分点: d.hitPoints.join('；'),
        失分点: d.missedPoints.join('；'),
        评语: d.comment,

        // 置信度写出来而不是判断后只给个"低"字：
        // 教师需要看到数值才能自己判断要不要复核，
        // 一个布尔标记会丢掉"到底多不确定"这个信息
        置信度: d.confidence.toFixed(2),
        需复核: needsReview ? '是' : '',
      });
    }
  }
  return rows;
}

/** 生成 Markdown 报告 */
export function buildMarkdown(report: PaperReport): string {
  const lines: string[] = [];
  lines.push(`# ${report.paperTitle} 阅卷报告`);
  lines.push('');
  lines.push(`生成时间：${new Date(report.generatedAt).toLocaleString('zh-CN')}`);
  lines.push('');

  const st = report.stats;
  lines.push('## 总览');
  lines.push('');
  lines.push('| 指标 | 值 |');
  lines.push('|---|---|');
  lines.push(`| 参考人数 | ${st.count} |`);
  lines.push(`| 平均分 | ${st.average.toFixed(2)} |`);
  lines.push(`| 最高分 | ${st.max} |`);
  lines.push(`| 最低分 | ${st.min} |`);
  lines.push(`| 及格率 | ${(st.passRate * 100).toFixed(1)}% |`);
  lines.push('');

  if (st.distribution.length > 0) {
    lines.push('## 分数分布');
    lines.push('');
    for (const b of st.distribution) {
      // 用方块做简易柱状图。Markdown 表格里画不了图，
      // 但纯数字列表看不出分布形状，所以用重复字符做视觉编码
      lines.push(`- ${b.bucket}：${'█'.repeat(Math.min(b.count, 50))} ${b.count} 人`);
    }
    lines.push('');
  }

  if (st.lossRanking.length > 0) {
    lines.push('## 高频失分点');
    lines.push('');
    lines.push('| 失分点 | 次数 |');
    lines.push('|---|---|');
    for (const l of st.lossRanking) {
      lines.push(`| ${l.point} | ${l.count} |`);
    }
    lines.push('');
  }

  lines.push('## 学生明细');
  lines.push('');
  for (const s of report.results) {
    if (s.details.length === 0) continue;
    lines.push(`### ${s.name}（${s.examNo}）　总分 ${s.total} / ${s.fullTotal}`);
    lines.push('');
    lines.push('| 题号 | 题型 | 得分 | 满分 | 得分点 | 失分点 |');
    lines.push('|---|---|---|---|---|---|');
    for (const d of s.details) {
      const hit = d.hitPoints.join('；') || '—';
      const miss = d.missedPoints.join('；') || '—';
      lines.push(
        `| ${d.questionId} | ${typeLabel(d.type)} | ${d.score} | ${d.fullScore} | ${hit} | ${miss} |`,
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** 需要人工复核的学生（用于导出时提示） */
export function lowConfidenceStudents(report: PaperReport, threshold = 0.75): StudentResult[] {
  return report.results.filter((s) => s.details.some((d) => d.confidence < threshold));
}

/* ---------------------------------------------------------- 薄绑定层 */

/**
 * 写 Excel 文件。
 *
 * 只出 .xlsx，不出 .csv —— 见文件头注释：
 * UTF-8 CSV 在中文 Windows 的 Excel 里会满屏乱码，
 * 而"另存为 xlsx"这个坑用户不会知道，只会以为软件导出坏了。
 */
export async function exportExcel(report: PaperReport, outPath: string): Promise<string> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Grading_exam';
  wb.created = new Date(report.generatedAt);

  const rows = buildWorkbookRows(report);

  // Sheet 1：明细
  const ws = wb.addWorksheet('阅卷明细');
  const headers = Object.keys(
    rows[0] ?? {
      姓名: '', 考号: '', 题号: '', 题型: '', 满分: '', 得分: '',
      得分点: '', 失分点: '', 评语: '', 置信度: '', 需复核: '',
    },
  ) as Array<keyof DetailRow>;

  ws.columns = headers.map((h) => ({
    header: h as string,
    key: h as string,
    width: columnWidth(
      h as string,
      rows.map((r) => String(r[h])),
    ),
  }));

  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

  for (const r of rows) {
    ws.addRow(r);
  }

  // 冻结首行：几百行明细里不冻结表头就没法看
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };

  // 「需复核」列高亮，让教师一眼找到要看的行
  const reviewCol = headers.indexOf('需复核' as keyof DetailRow) + 1;
  if (reviewCol > 0) {
    ws.eachRow((row, i) => {
      if (i === 1) return;
      if (row.getCell(reviewCol).value === '是') {
        row.getCell(reviewCol).font = { color: { argb: 'FF991B1B' }, bold: true };
      }
    });
  }

  // Sheet 2：总览
  const ws2 = wb.addWorksheet('班级总览');
  ws2.columns = [
    { header: '指标', key: 'k', width: 16 },
    { header: '值', key: 'v', width: 20 },
  ];
  ws2.getRow(1).font = { bold: true };
  const st = report.stats;
  for (const [k, v] of [
    ['试卷', report.paperTitle],
    ['参考人数', st.count],
    ['平均分', Number(st.average.toFixed(2))],
    ['最高分', st.max],
    ['最低分', st.min],
    ['及格率', `${(st.passRate * 100).toFixed(1)}%`],
  ] as Array<[string, string | number]>) {
    ws2.addRow({ k, v });
  }

  await wb.xlsx.writeFile(outPath);
  return outPath;
}

/** 写 Markdown 报告 */
export async function exportMarkdown(report: PaperReport, outPath: string): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(outPath, buildMarkdown(report), 'utf8');
  return outPath;
}