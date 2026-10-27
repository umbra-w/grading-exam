/**
 * 文件解析 —— 把试卷/答案文件转成纯文本，供 AI 解析或展示。
 *
 * 设计重心不在"支持几种格式"，而在**失败必须可见**。
 * 解析这类代码最容易出的问题不是解析错，而是：
 *   · 扫描件 PDF 抽不出文字 → 返回空字符串 → 上游当成"试卷是空的"
 *   · GBK 编码的 txt → 读成乱码 → AI 拿到乱码去解析 → 输出胡说八道
 *   · 加密 PDF → 库抛一句英文异常 → 用户完全不知道该怎么办
 * 三种都会让用户以为"软件坏了"。所以这里所有失败都返回**带原因码的结构化结果**，
 * 而不是抛异常或返回空串。
 */

import { readFile, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { ParseErrorCode, ParseWarning, ParseResult as SharedParseResult } from '@shared/types';

/**
 * 失败码与警告码的**真源在 `shared/types.ts`**（因为要跨 IPC 传输）。
 * 这里 re-export，让主进程内部调用方只需 import 这一个模块。
 */
export type { ParseErrorCode, ParseWarning };

/** 支持的文件扩展名（小写，含点） */
export const SUPPORTED_EXTENSIONS = ['.txt', '.md', '.markdown', '.docx', '.pdf'] as const;

/**
 * 单文件大小上限 50MB。
 * 目的是防呆而非防攻击：有人会误选几百 MB 的扫描册，
 * 那会让主进程吃满内存。这里明确拒绝并告诉用户原因。
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export interface ParseOk {
  ok: true;
  /** 从文件名推断，仅用于展示 */
  name: string;
  ext: string;
  bytes: number;
  /** 解析出的纯文本（已做基本清洗） */
  text: string;
  /** 字符数（去空白后），用于快速判断"抽到的内容是否够用" */
  charCount: number;
  /** PDF 的页数；非 PDF 为 undefined */
  pageCount?: number;
  /** 非致命问题。有警告不代表失败，但**必须展示给用户** */
  warnings: ParseWarning[];
}

export interface ParseFail {
  ok: false;
  name: string;
  ext: string;
  bytes: number;
  code: ParseErrorCode;
  /** 面向用户的中文说明，必须包含"下一步怎么办" */
  message: string;
}

export type ParseResult = ParseOk | ParseFail;

/**
 * 转成跨 IPC 的形状：**剥掉本机路径信息**。
 *
 * 渲染层不需要知道完整路径（它本来就有），但更重要的理由是
 * 让"能过 IPC 的形状"有唯一的转换点，而不是让渲染层拿到多余字段后
 * 各自决定要不要用——那样契约就形同虚设。
 */
export function toIpcResult(r: ParseResult): SharedParseResult {
  if (r.ok) {
    return {
      ok: true,
      name: r.name,
      ext: r.ext,
      text: r.text,
      charCount: r.charCount,
      ...(r.pageCount === undefined ? {} : { pageCount: r.pageCount }),
      warnings: r.warnings,
    };
  }
  return { ok: false, name: r.name, ext: r.ext, code: r.code, message: r.message };
}

/**
 * 判断 PDF 是否属于"没有文字层"（扫描件）。
 *
 * 纯函数，便于单测——真实扫描件样本不好造，但阈值逻辑必须被钉死。
 *
 * 两级判据：
 *   1. 整体密度：总字符数 / 页数 < MIN_CHARS_PER_PAGE → 扫描件
 *   2. 空白页比例：空白页占比 > BLANK_PAGE_RATIO → 扫描件
 *
 * 为什么用两级：只有第一级会漏掉"有一页是封面文字、其余全是图"的情况；
 * 只有第二级会漏掉"每页有页眉页脚但正文是图"的情况。
 *
 * 阈值取得保守（偏低）：宁可把真扫描件判成"能读但内容可疑"（靠警告提示），
 * 也不要把正常 PDF 误判成扫描件而拒绝解析。
 */
export const MIN_CHARS_PER_PAGE = 50;
export const BLANK_PAGE_RATIO = 0.5;

export function looksLikeScanned(
  pages: string[],
  opts: { minCharsPerPage?: number; blankRatio?: number } = {},
): boolean {
  const minChars = opts.minCharsPerPage ?? MIN_CHARS_PER_PAGE;
  const blankRatio = opts.blankRatio ?? BLANK_PAGE_RATIO;

  if (pages.length === 0) return false;

  const perPage = pages.map((p) => p.replace(/\s/g, '').length);
  const total = perPage.reduce((a, b) => a + b, 0);
  if (total / pages.length < minChars) return true;

  const blanks = perPage.filter((n) => n === 0).length;
  return blanks / pages.length > blankRatio;
}

/**
 * 猜测文本编码并解码。
 *
 * 为什么需要：中文 Windows 上 `记事本` 默认另存为 **GBK/GB18030**，
 * 用 UTF-8 读会得到一堆乱码。而乱码**不会报错**——它会一路传到 AI，
 * 变成"模型输出胡话"，排查时根本想不到是编码问题。
 *
 * 判断顺序：
 *   1. 有 UTF-8 BOM (EF BB BF) → UTF-8，砍掉 BOM
 *   2. 有 UTF-16 BOM (FF FE / FE FF) → UTF-16
 *   3. 否则按 UTF-8 试解码，出现替换字符 U+FFFD 则回退 GB18030
 *
 * 用 `fatal: true` 试解：GBK 中文字节序列几乎必然不是合法 UTF-8，
 * 所以"严格 UTF-8 解码成功"是很强的信号。
 */
export function decodeTextBuffer(buf: Buffer): { text: string; usedFallback: boolean } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), usedFallback: false };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), usedFallback: false };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE：Node 不原生支持，交换字节序后用 utf16le 解
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), usedFallback: false };
  }

  try {
    // TextDecoder 的 fatal 选项让非法序列直接抛错，而不是插入 U+FFFD
    const strict = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return { text: strict, usedFallback: false };
  } catch {
    const fallback = new TextDecoder('gb18030').decode(buf);
    return { text: fallback, usedFallback: true };
  }
}

/** 基本清洗：统一换行、去掉行尾空白、压掉过多空行。不做语义修改。 */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    // 三个以上连续换行压成两个（保留段落感，但去掉填满一屏的空白）
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fail(
  name: string,
  ext: string,
  bytes: number,
  code: ParseErrorCode,
  message: string,
): ParseFail {
  return { ok: false, name, ext, bytes, code, message };
}

/** 从 Buffer 解析 docx（Mammoth 的 extractRawText 只取正文文字） */
async function parseDocx(buf: Buffer): Promise<string> {
  const mammoth = (await import('mammoth')) as unknown as {
    extractRawText: (input: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  const r = await mammoth.extractRawText({ buffer: buf });
  return r.value ?? '';
}

/** 从 Buffer 解析 pdf，返回逐页文本 */
async function parsePdf(buf: Buffer): Promise<string[]> {
  const mod = (await import('pdf-parse')) as unknown as {
    PDFParse: new (opts: { data: Uint8Array }) => {
      getText: () => Promise<{ text: string; pages: Array<{ num: number; text: string }> }>;
      destroy: () => Promise<void>;
    };
  };
  const parser = new mod.PDFParse({ data: new Uint8Array(buf) });
  try {
    const r = await parser.getText();
    // pages 是权威的逐页文本；缺失时退化成整体文本的单页
    if (Array.isArray(r.pages) && r.pages.length > 0) {
      return r.pages.map((p) => p.text ?? '');
    }
    return [r.text ?? ''];
  } finally {
    // 不 destroy 会漏 worker 与内存——Electron 主进程长期运行必须清
    await parser.destroy().catch(() => undefined);
  }
}

/**
 * 解析一个文件。
 *
 * **不会抛异常**：所有失败都以 `{ok:false, code, message}` 返回。
 * 调用方（IPC handler）因此不必写 try/catch 兜底，
 * 也不会把库的英文异常原样丢给用户。
 *
 * @param filePath 绝对路径
 */
export async function parseFile(filePath: string): Promise<ParseResult> {
  const name = filePath.split(/[\\/]/).pop() ?? filePath;
  const ext = extname(filePath).toLowerCase();

  let bytes = 0;
  try {
    const st = await stat(filePath);
    bytes = st.size;
  } catch {
    return fail(name, ext, 0, 'READ_FAILED', '读不到这个文件，可能已被移动或删除。请重新选择。');
  }

  if (bytes === 0) {
    return fail(name, ext, 0, 'EMPTY_FILE', '这个文件是空的（0 字节）。请检查文件本身。');
  }
  if (bytes > MAX_FILE_BYTES) {
    const mb = (bytes / 1024 / 1024).toFixed(1);
    return fail(
      name,
      ext,
      bytes,
      'TOO_LARGE',
      `文件有 ${mb} MB，超过 50 MB 上限。请拆分后再试。`,
    );
  }
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(ext)) {
    return fail(
      name,
      ext,
      bytes,
      'UNSUPPORTED_TYPE',
      `不支持 ${ext || '无扩展名'} 格式。可用格式：${SUPPORTED_EXTENSIONS.join(' / ')}。`,
    );
  }

  // ---- 纯文本类 ----
  if (ext === '.txt' || ext === '.md' || ext === '.markdown') {
    let text: string;
    let usedFallback = false;
    try {
      const buf = await readFile(filePath);
      const d = decodeTextBuffer(buf);
      text = d.text;
      usedFallback = d.usedFallback;
    } catch {
      return fail(name, ext, bytes, 'READ_FAILED', '文件读取失败。请确认文件未被其他程序独占。');
    }

    const cleaned = cleanText(text);
    const warnings: ParseWarning[] = [];
    if (usedFallback) {
      warnings.push({
        code: 'ENCODING_FALLBACK',
        message: '文件不是 UTF-8 编码，已按 GB18030 解码。若出现乱码请另存为 UTF-8 后重试。',
      });
    }
    if (cleaned.length === 0) {
      return fail(name, ext, bytes, 'EMPTY_FILE', '文件没有可读文本内容。');
    }
    return {
      ok: true,
      name,
      ext,
      bytes,
      text: cleaned,
      charCount: cleaned.replace(/\s/g, '').length,
      warnings,
    };
  }

  // ---- docx ----
  if (ext === '.docx') {
    let text: string;
    try {
      const buf = await readFile(filePath);
      text = await parseDocx(buf);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // .doc（旧二进制格式）常见误区：改扩展名成 .docx 也当不了 docx
      return fail(
        name,
        ext,
        bytes,
        'PARSE_FAILED',
        `docx 解析失败：${msg}。若是 .doc 旧格式，请用 Word 另存为 .docx。`,
      );
    }
    const cleaned = cleanText(text);
    if (cleaned.length === 0) {
      return fail(
        name,
        ext,
        bytes,
        'PARSE_FAILED',
        '这个 docx 里没有可提取的文字。若正文全是图片（如扫描后贴进 Word），本软件无法识别——请用文字版文件。',
      );
    }
    return { ok: true, name, ext, bytes, text: cleaned, charCount: cleaned.replace(/\s/g, '').length, warnings: [] };
  }

  // ---- pdf ----
  let pages: string[];
  try {
    const buf = await readFile(filePath);
    pages = await parsePdf(buf);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|encrypt/i.test(msg)) {
      return fail(
        name,
        ext,
        bytes,
        'ENCRYPTED_PDF',
        '这个 PDF 有密码保护。请先在阅读器里去密后重试。',
      );
    }
    return fail(name, ext, bytes, 'PARSE_FAILED', `PDF 解析失败：${msg}`);
  }

  const joined = cleanText(pages.join('\n\n'));
  const charCount = joined.replace(/\s/g, '').length;

  // 扫描件判定必须在"成功"之前 —— 否则空文本会被当成一份空试卷
  if (looksLikeScanned(pages)) {
    return fail(
      name,
      ext,
      bytes,
      'SCANNED_PDF',
      `这个 PDF 共 ${pages.length} 页，几乎提取不到文字，应该是**扫描件或整页图片**。` +
        `本软件不做 OCR，无法识别图片里的字。` +
        `替代做法：① 用文字版 PDF / Word 文件；② 直接截取题目区域，用视觉模型评分（本项目支持）。`,
    );
  }

  if (charCount === 0) {
    return fail(
      name,
      ext,
      bytes,
      'PARSE_FAILED',
      `这个 PDF 共 ${pages.length} 页，但没有提取到任何文字。请改用文字版文件。`,
    );
  }

  const warnings: ParseWarning[] = [];
  const blanks = pages.filter((p) => p.replace(/\s/g, '').length === 0).length;
  if (blanks > 0) {
    warnings.push({
      code: 'PARTIAL_TEXT',
      message: `有 ${blanks} 页没有提取到文字（可能是图片页），请核对解析结果是否完整。`,
    });
  }
  if (charCount / pages.length < MIN_CHARS_PER_PAGE * 2) {
    warnings.push({
      code: 'LOW_TEXT_DENSITY',
      message: `平均每页仅 ${Math.round(charCount / pages.length)} 个字，可能只有页眉页脚是文字。请核对结果。`,
    });
  }

  return {
    ok: true,
    name,
    ext,
    bytes,
    text: joined,
    charCount,
    pageCount: pages.length,
    warnings,
  };
}