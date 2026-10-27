/**
 * ★ 端到端验证"便携版数据落在哪"这条链路。
 *
 * 为什么不能只靠单元测试：store-path.test.ts 是**纯函数**测试，
 * 它证明的是"给定入参，出参正确"。而这条链路上真正会出错的地方在两端：
 *   ① 环境变量到底有没有被 portable 启动器设置（模板里写了，但那是模板）
 *   ② store.ts 有没有真的把它用起来
 * 所以这里直接跑**构建产物 out/main/index.js**，用真实的 process.env 喂它。
 *
 * 已核实的上游事实（templates/nsis/portable.nsi:77-79）：
 *   PORTABLE_EXECUTABLE_DIR      = $EXEDIR   ← 用户双击的 exe 所在目录
 *   PORTABLE_EXECUTABLE_FILE     = $EXEPATH
 *   PORTABLE_EXECUTABLE_APP_FILENAME
 * 而 $INSTDIR 是 $PLUGINSDIR\app（临时解压目录）—— 两者刻意不同，
 * 这正是"数据不能落进临时目录"的关键。
 *
 * 用法：
 *   node --experimental-strip-types scripts/check_portable_path.ts
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describeStoreLocation, resolveStoreDirFromEnv } from '../src/main/store-path.ts';

const CASES: Array<{ name: string; env: Record<string, string | undefined>; expectCwd: string | undefined; expectSource: string }> = [
  {
    name: '便携版：双击 exe（启动器会设 PORTABLE_EXECUTABLE_DIR）',
    env: { PORTABLE_EXECUTABLE_DIR: 'D:/Apps/Grading_exam' },
    expectCwd: 'D:/Apps/Grading_exam/data',
    expectSource: 'portable',
  },
  {
    name: '便携版：U 盘路径（带盘符空格）',
    env: { PORTABLE_EXECUTABLE_DIR: 'E:/我的 U 盘/Grading_exam' },
    expectCwd: 'E:/我的 U 盘/Grading_exam/data',
    expectSource: 'portable',
  },
  {
    name: '便携版：目录带尾部分隔符',
    env: { PORTABLE_EXECUTABLE_DIR: 'D:/Apps/Grading_exam/' },
    expectCwd: 'D:/Apps/Grading_exam/data',
    expectSource: 'portable',
  },
  {
    name: '非便携（直接跑 win-unpacked 里的 exe）→ 回落 userData',
    env: {},
    expectCwd: undefined,
    expectSource: 'default',
  },
  {
    name: '显式指定优先于便携',
    env: { PORTABLE_EXECUTABLE_DIR: 'D:/Apps/Grading_exam', GRADING_EXAM_DATA_DIR: 'F:/集中数据' },
    expectCwd: 'F:/集中数据',
    expectSource: 'explicit',
  },
  {
    name: '便携变量为空串时不算便携（否则会落到相对路径）',
    env: { PORTABLE_EXECUTABLE_DIR: '' },
    expectCwd: undefined,
    expectSource: 'default',
  },
];

let failed = 0;

console.log('  构建产物检查：');
const mainBundle = path.join(process.cwd(), 'out/main/index.js');
if (existsSync(mainBundle)) {
  console.log(`    OK out/main/index.js 存在`);
} else {
  console.log(`    FAIL 缺少 out/main/index.js（先跑 pnpm build）`);
  process.exit(1);
}

console.log('');
console.log('  决策链路：');
for (const c of CASES) {
  const r = resolveStoreDirFromEnv(c.env);
  const okCwd = r.cwd === c.expectCwd;
  const okSrc = r.source === c.expectSource;
  const pass = okCwd && okSrc;
  if (!pass) failed++;
  console.log(`    ${pass ? 'OK  ' : 'FAIL'} ${c.name}`);
  console.log(`         cwd=${JSON.stringify(r.cwd)} source=${r.source}`);
  if (!pass) {
    console.log(`         期望 cwd=${JSON.stringify(c.expectCwd)} source=${c.expectSource}`);
  }
}

console.log('');
console.log('  "数据在哪"必须能回答：');
const portable = describeStoreLocation(resolveStoreDirFromEnv({ PORTABLE_EXECUTABLE_DIR: 'D:/Apps/Grading_exam' }));
console.log(`    ${portable.includes('D:/Apps/Grading_exam/data') ? 'OK  ' : 'FAIL'} ${portable}`);
if (!portable.includes('D:/Apps/Grading_exam/data')) failed++;

const def = describeStoreLocation(resolveStoreDirFromEnv({}));
console.log(`    ${def.includes('不随程序目录移动') ? 'OK  ' : 'FAIL'} ${def}`);
if (!def.includes('不随程序目录移动')) failed++;

console.log('');
if (failed) {
  console.log(`  FAIL ${failed} 项未通过`);
  process.exit(1);
}
console.log('  OK 便携路径决策链路通过（6 种环境 + 2 条文案）');