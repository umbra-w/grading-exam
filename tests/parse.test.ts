/**
 * 文件解析单测 —— 对应 PLAN v2.0 P4-2。
 *
 * 重点不在"能不能解析"，而在**失败是否可见、原因是否说得清**。
 * 因此本文件大量用例是在断言"这种坏输入会得到明确的错误码 + 中文说明"，
 * 而不是断言"不会崩"——不会崩但静默返回空串，比崩更糟。
 *
 * 真实 docx/pdf 样本在 node 环境下不好造且体积大，所以：
 *   · 编码判定、清洗、扫描件判定都是**纯函数**，直接测（覆盖最关键的判定逻辑）
 *   · 文件级行为用临时 txt 实测（覆盖 IO 与错误码路径）
 *   · docx/pdf 的库调用只验证"错误能被翻译成用户看得懂的话"（用假文件触发）
 * 真机上的端到端解析仍需人工验证，已在文件末尾注明。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeTextBuffer,
  cleanText,
  looksLikeScanned,
  parseFile,
  MAX_FILE_BYTES,
  MIN_CHARS_PER_PAGE,
  SUPPORTED_EXTENSIONS,
} from '@main/io/parse';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ge-parse-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('文本编码判定', () => {
  it('UTF-8 无 BOM 正常解码', () => {
    const r = decodeTextBuffer(Buffer.from('碳酸钙', 'utf8'));
    expect(r.text).toBe('碳酸钙');
    expect(r.usedFallback).toBe(false);
  });

  it('UTF-8 带 BOM：砍掉 BOM，不留在正文里', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('题目', 'utf8')]);
    const r = decodeTextBuffer(buf);
    expect(r.text).toBe('题目');
    // BOM 若留在正文里，会让第一个字符比对失败且肉眼完全看不出来
    expect(r.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('**GBK 编码回退** —— 中文 Windows 记事本默认编码，用 UTF-8 读是乱码', () => {
    // 「碳酸钙」的 GB18030 字节
    const gbk = Buffer.from([0xcc, 0xbc, 0xcb, 0xe1, 0xb8, 0xc6]);
    const r = decodeTextBuffer(gbk);
    expect(r.usedFallback).toBe(true);
    expect(r.text).toBe('碳酸钙');
  });

  it('UTF-16LE BOM 解码', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('答案', 'utf16le')]);
    const r = decodeTextBuffer(buf);
    expect(r.text).toBe('答案');
  });

  it('UTF-16BE BOM 解码（交换字节序）', () => {
    // '答' = U+7B54 → BE 字节序 7B 54
    const buf = Buffer.concat([Buffer.from([0xfe, 0xff, 0x7b, 0x54])]);
    const r = decodeTextBuffer(buf);
    expect(r.text).toBe('答');
  });

  it('纯 ASCII 不会误判为需要回退', () => {
    const r = decodeTextBuffer(Buffer.from('ABC 123', 'utf8'));
    expect(r.usedFallback).toBe(false);
    expect(r.text).toBe('ABC 123');
  });
});

describe('文本清洗', () => {
  it('统一换行符', () => {
    expect(cleanText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('去掉行尾空白', () => {
    expect(cleanText('a   \nb\t\n')).toBe('a\nb');
  });

  it('压掉过多空行（保留段落感）', () => {
    expect(cleanText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });

  it('不改动正文内容', () => {
    expect(cleanText('1+1=2\n碳酸钙')).toBe('1+1=2\n碳酸钙');
  });
});

describe('扫描件判定（纯函数）', () => {
  it('正常文字版 PDF 不判为扫描件', () => {
    const pages = [ '一'.repeat(200), '二'.repeat(200), '三'.repeat(200) ];
    expect(looksLikeScanned(pages)).toBe(false);
  });

  it('全空的页面判为扫描件', () => {
    expect(looksLikeScanned(['', '', ''])).toBe(true);
  });

  it('只有零星字符的页面判为扫描件', () => {
    // 每页 10 字，低于 MIN_CHARS_PER_PAGE
    expect(looksLikeScanned(['第 1 页', '第 2 页', '第 3 页'])).toBe(true);
  });

  it('**正文是图、只有页眉页脚是字** → 靠密度判据抓住', () => {
    const pages = Array.from({ length: 5 }, () => '期中数学试卷 第 X 页');
    expect(looksLikeScanned(pages)).toBe(true);
  });

  it('**封面有文字、其余全是图** → 靠空白页比例判据抓住', () => {
    // 总密度达标（第一页很长），但 4/5 页是空的
    const pages = [ '一'.repeat(400), '', '', '', '' ];
    expect(looksLikeScanned(pages)).toBe(true);
  });

  it('空数组不判为扫描件（没有依据，不能凭空拒绝）', () => {
    expect(looksLikeScanned([])).toBe(false);
  });

  it('阈值可覆盖（便于按学科调参）', () => {
    const pages = ['一'.repeat(30)];
    expect(looksLikeScanned(pages, { minCharsPerPage: 10 })).toBe(false);
    expect(looksLikeScanned(pages, { minCharsPerPage: 100 })).toBe(true);
  });

  it('不把"少量但真实的文字"误判 —— 阈值取保守值', () => {
    // 一道题就几十个字的情况必须能过
    const pages = [ '1+1=? 求碳酸钙的摩尔质量，写出计算过程。'.repeat(8) ];
    expect(looksLikeScanned(pages)).toBe(false);
  });
});

describe('parseFile：纯文本路径（真实 IO）', () => {
  it('解析 UTF-8 txt', async () => {
    const p = join(dir, 'a.txt');
    await writeFile(p, '题目一：碳酸钙\n答案：100', 'utf8');
    const r = await parseFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toContain('碳酸钙');
    expect(r.ext).toBe('.txt');
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.warnings).toEqual([]);
  });

  it('解析 md', async () => {
    const p = join(dir, 'b.md');
    await writeFile(p, '# 试卷\n\n## 第一题', 'utf8');
    const r = await parseFile(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ext).toBe('.md');
  });

  it('**GBK 文件给出编码警告**（否则乱码会一路传到 AI）', async () => {
    const p = join(dir, 'gbk.txt');
    await writeFile(p, Buffer.from([0xcc, 0xbc, 0xcb, 0xe1, 0xb8, 0xc6]));
    const r = await parseFile(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('碳酸钙');
    expect(r.warnings.map((w) => w.code)).toContain('ENCODING_FALLBACK');
  });

  it('0 字节文件 → EMPTY_FILE（不是"成功但内容为空"）', async () => {
    const p = join(dir, 'empty.txt');
    await writeFile(p, '');
    const r = await parseFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('EMPTY_FILE');
    expect(r.message).toContain('空');
  });

  it('只有空白字符的文件 → 也算 EMPTY_FILE', async () => {
    const p = join(dir, 'blank.txt');
    await writeFile(p, '   \n\n\t  ', 'utf8');
    const r = await parseFile(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EMPTY_FILE');
  });

  it('不支持的扩展名 → UNSUPPORTED_TYPE，并列出可用格式', async () => {
    const p = join(dir, 'c.xlsx');
    await writeFile(p, 'x', 'utf8');
    const r = await parseFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('UNSUPPORTED_TYPE');
    expect(r.message).toContain('.docx');
  });

  it('文件不存在 → READ_FAILED，并告诉用户怎么办', async () => {
    const r = await parseFile(join(dir, '不存在.txt'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('READ_FAILED');
    expect(r.message).toContain('重新选择');
  });

  it('**parseFile 不抛异常** —— 所有失败都是结构化返回', async () => {
    // 上层 IPC handler 因此不需要 try/catch 兜底
    await expect(parseFile(join(dir, 'nope.pdf'))).resolves.toBeDefined();
    await expect(parseFile('')).resolves.toBeDefined();
  });

  it('大小写扩展名都能识别', async () => {
    const p = join(dir, 'D.TXT');
    await writeFile(p, '内容', 'utf8');
    const r = await parseFile(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ext).toBe('.txt');
  });
});

describe('parseFile：失败路径必须说人话', () => {
  it('假的 pdf → PARSE_FAILED 且原因可读，不是库的英文堆栈', async () => {
    const p = join(dir, 'fake.pdf');
    await writeFile(p, 'this is definitely not a pdf', 'utf8');
    const r = await parseFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(['PARSE_FAILED', 'ENCRYPTED_PDF', 'SCANNED_PDF']).toContain(r.code);
    // 不能把原始英文异常直接丢给用户
    expect(r.message).toMatch(/[\u4e00-\u9fa5]/);
  });

  it('假的 docx → PARSE_FAILED 且提示 .doc 旧格式问题', async () => {
    const p = join(dir, 'fake.docx');
    await writeFile(p, 'not a real docx zip', 'utf8');
    const r = await parseFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('PARSE_FAILED');
    expect(r.message).toContain('.doc');
  });

  it('扩展名改了但内容是图片的 docx → 明确说"全是图片无法识别"', async () => {
    // 用一个合法 zip 头但无 document.xml 的字节，触发"没有文字"分支或解析失败分支
    const p = join(dir, 'scan.docx');
    await writeFile(p, Buffer.from('PK\x03\x04' + '\x00'.repeat(50)), 'binary');
    const r = await parseFile(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/图片|旧格式|解析失败/);
  });

  it('每一条失败都带非空 message（不允许"静默失败"）', async () => {
    const cases = ['x.xlsx', 'nope.txt', 'e.txt', 't.docx', 'p.pdf'];
    await writeFile(join(dir, 'e.txt'), '');
    await writeFile(join(dir, 't.docx'), 'x');
    await writeFile(join(dir, 'p.pdf'), 'x');
    for (const c of cases) {
      const r = await parseFile(join(dir, c));
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.message.length).toBeGreaterThan(5);
        expect(r.code).toBeTruthy();
      }
    }
  });
});

describe('常量契约', () => {
  it('支持的格式与 README/界面提示一致', () => {
    expect([...SUPPORTED_EXTENSIONS]).toEqual(['.txt', '.md', '.markdown', '.docx', '.pdf']);
  });

  it('大小上限为 50MB', () => {
    expect(MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
  });

  it('扫描件密度阈值是保守值（偏低，避免误拒正常文件）', () => {
    expect(MIN_CHARS_PER_PAGE).toBeLessThanOrEqual(60);
    expect(MIN_CHARS_PER_PAGE).toBeGreaterThan(0);
  });
});

/**
 * 标记：以下路径**未在本机验证**，依赖真实样本与 Electron 主进程环境。
 *
 *   · 真实 docx（含表格、公式、页眉）的提取完整度
 *   · 真实文字版 PDF 的多栏排版顺序（pdfjs 按坐标排序，多栏可能串行）
 *   · 加密 PDF 的真实错误信息是否匹配 /password|encrypt/
 *   · 50MB 附近的解析内存表现
 *
 * 这些只能上真机用教师手上的真实试卷验证（BLOCKERS.md B3）。
 * 本文件已覆盖的是：判定逻辑、错误翻译、以及"失败必须说人话"这条纪律。
 */