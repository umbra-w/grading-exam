/**
 * ★ 便携版专用：数据落盘位置的决策（纯逻辑，可被 vitest 覆盖）。
 *
 * 为什么必须在这里想清楚，而不是随手写个 `path.join(exeDir, 'data')`：
 *
 * 1. **portable exe 每次运行会把自己解压到临时目录。**
 *    electron-builder 因此提供了 `PORTABLE_EXECUTABLE_DIR` —— 它指向
 *    **用户双击的那个 exe 所在的目录**（不是我运行的临时目录）。
 *    如果直接写 `app.getPath('userData')`，数据会落到 `%APPDATA%`，
 *    下次换台机器/换个 U 盘就跑；如果误用 `process.cwd()` 或
 *    `path.dirname(process.execPath)`，数据会被写进临时目录，
 *    **退出即丢**——用户表现为"我填的 API key 每次打开都要重填"。
 *
 * 2. **"便携"的语义是：整个目录拷走就能带着数据走。**
 *    所以数据必须落在 exe 所在目录内，且单独放一个子目录，
 *    避免和 exe 混在一起（用户想备份/删除数据时一目了然）。
 *
 * 3. 但这是**有代价的**：便携 exe 若被解压到系统临时目录运行，
 *    那个目录随时会被系统清理，数据同生共死。所以：
 *      · 便携模式下若有压缩包版（解压后再运行），数据是稳的；
 *      · 单文件便携 exe 直接双击，数据跟 exe 所在目录绑定。
 *    这个取舍必须写进界面提示，不能让用户自己踩。
 *
 * 抽出纯函数的意义：以上判断全都能用 vitest 覆盖，不需要真的打包一遍。
 */

/** 环境变量名。用 `GRADING_EXAM_` 前缀避免和系统变量撞名。 */
export const ENV_DATA_DIR = 'GRADING_EXAM_DATA_DIR';
export const ENV_PORTABLE_DIR = 'PORTABLE_EXECUTABLE_DIR';

export interface ResolveStoreDirInput {
  /** 显式指定的数据目录（最高优先级）。为空/空白则忽略。 */
  explicitDir?: string | null;
  /** 便携模式下的程序所在目录（electron-builder 注入）。为空则不是便携模式。 */
  portableDir?: string | null;
  /** 便携模式下数据子目录名。 */
  dataSubDir?: string;
}

export interface ResolveStoreDirResult {
  /** 应当传给 electron-store 的 `cwd`；`undefined` 表示用默认位置（userData）。 */
  cwd: string | undefined;
  /** 决策来源，用于日志和界面提示（"数据在哪"必须能回答）。 */
  source: 'explicit' | 'portable' | 'default';
}

export const DEFAULT_DATA_SUBDIR = 'data';

/**
 * 决定配置/记录落在哪个目录。
 *
 * 优先级：
 *   1. `GRADING_EXAM_DATA_DIR` —— 显式指定。便于测试、便于把数据集中到某个盘。
 *   2. `PORTABLE_EXECUTABLE_DIR` —— 便携模式，数据放 exe 旁边。
 *   3. 都不满足 —— 返回 undefined，由 electron-store 用默认的 userData。
 *
 * ★ 刻意不做的事：不去猜 `process.cwd()`、不去读 `path.dirname(process.execPath)`。
 * 前者随启动方式变化（从资源管理器双击和从命令行启动不一样），
 * 后者在 portable 模式下指向**临时解压目录**——正是会丢数据的那一个。
 * 这两个"看起来能拿到目录"的接口都是陷阱，所以只认上面两个明确信号。
 */
export function resolveStoreDir(input: ResolveStoreDirInput = {}): ResolveStoreDirResult {
  const explicit = (input.explicitDir ?? '').trim();
  if (explicit) {
    return { cwd: explicit, source: 'explicit' };
  }

  const portable = (input.portableDir ?? '').trim();
  if (portable) {
    const sub = (input.dataSubDir ?? DEFAULT_DATA_SUBDIR).trim() || DEFAULT_DATA_SUBDIR;
    // 用正斜杠拼接以避免 Windows 反斜杠在 JSON/日志里的转义噪音；
    // electron-store 与 Node 都接受正斜杠。
    const base = portable.replace(/[\\/]+$/, '');
    return { cwd: `${base}/${sub}`, source: 'portable' };
  }

  return { cwd: undefined, source: 'default' };
}

/** 从环境变量取值并决策。薄绑定（读 env 是副作用），逻辑全在 resolveStoreDir 里。 */
export function resolveStoreDirFromEnv(env: Record<string, string | undefined>): ResolveStoreDirResult {
  return resolveStoreDir({
    explicitDir: env[ENV_DATA_DIR],
    portableDir: env[ENV_PORTABLE_DIR],
  });
}

/** 给界面用的一句话说明：数据到底在哪。不允许含糊其辞。 */
export function describeStoreLocation(r: ResolveStoreDirResult): string {
  switch (r.source) {
    case 'explicit':
      return `数据目录由环境变量 ${ENV_DATA_DIR} 指定：${r.cwd}`;
    case 'portable':
      return `便携模式：数据保存在程序目录下（${r.cwd}），整个目录拷走即可带走全部数据`;
    default:
      return '数据保存在系统用户数据目录（%APPDATA%\\grading-exam），不随程序目录移动';
  }
}