import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DATA_SUBDIR,
  ENV_DATA_DIR,
  ENV_PORTABLE_DIR,
  describeStoreLocation,
  resolveStoreDir,
  resolveStoreDirFromEnv,
} from '../src/main/store-path';

/**
 * 这些用例对应的都是**用户能直接感受到**的失败：
 *   · 便携模式下数据没落在程序目录 → "我拷到 U 盘里怎么没带过去"
 *   · 数据落进 portable 的临时解压目录 → "API key 每次打开都要重填"
 *   · userData 默认位置被误当成便携 → 换机即失联
 * 所以每条都写成"用户会怎么发现"，而不只是断言函数返回值。
 */
describe('resolveStoreDir', () => {
  it('没有环境变量时回落到默认位置（userData），cwd 必须是 undefined', () => {
    // ★ 这里刻意要求 undefined 而不是自己拼一个路径：
    //   拼路径就绕过了 electron-store 的默认行为，将来它改默认值我们不会跟着走。
    const r = resolveStoreDir({});
    expect(r.cwd).toBeUndefined();
    expect(r.source).toBe('default');
  });

  it('空串与纯空白都视为未设置（不能因为环境变量是空串就落到根目录）', () => {
    expect(resolveStoreDir({ explicitDir: '', portableDir: '' }).source).toBe('default');
    expect(resolveStoreDir({ explicitDir: '   ', portableDir: '  ' }).source).toBe('default');
    // 空串最容易出的问题是 path.join('', 'data') → 'data'（相对路径），
    // 那样数据会落在"启动时的工作目录"，随启动方式漂移。
    expect(resolveStoreDir({ portableDir: '  ' }).cwd).toBeUndefined();
  });

  it('便携模式下数据放在程序目录的子目录里，不和 exe 混在一起', () => {
    const r = resolveStoreDir({ portableDir: 'D:/Apps/Grading_exam' });
    expect(r.source).toBe('portable');
    // 单独子目录的理由：用户备份/删除数据时能一眼分辨，
    // 而且卸载（=删目录）时不会误删别的文件。
    expect(r.cwd).toBe(`D:/Apps/Grading_exam/${DEFAULT_DATA_SUBDIR}`);
  });

  it('便携目录末尾的斜杠不会造成双斜杠', () => {
    for (const tail of ['D:/Apps/Grading_exam/', 'D:/Apps/Grading_exam\\', 'D:/Apps/Grading_exam//']) {
      expect(resolveStoreDir({ portableDir: tail }).cwd).toBe('D:/Apps/Grading_exam/data');
    }
  });

  it('Windows 反斜杠路径也能正确处理', () => {
    const r = resolveStoreDir({ portableDir: 'C:\\Users\\admin\\Desktop\\Grading_exam' });
    expect(r.cwd).toBe('C:\\Users\\admin\\Desktop\\Grading_exam/data');
  });

  it('两者都给时显式指定优先（便于把数据集中到某个盘，或给测试用临时目录）', () => {
    const r = resolveStoreDir({
      explicitDir: 'E:/exam-data',
      portableDir: 'D:/Apps/Grading_exam',
    });
    expect(r.source).toBe('explicit');
    expect(r.cwd).toBe('E:/exam-data');
  });

  it('显式目录为空串时不能挡住便携目录（空值不算"用户指定了"）', () => {
    const r = resolveStoreDir({ explicitDir: '', portableDir: 'D:/Apps/Grading_exam' });
    expect(r.source).toBe('portable');
    expect(r.cwd).toBe('D:/Apps/Grading_exam/data');
  });

  it('可以自定义子目录名', () => {
    const r = resolveStoreDir({ portableDir: 'D:/App', dataSubDir: 'userdata' });
    expect(r.cwd).toBe('D:/App/userdata');
  });

  it('子目录名给成空白时回落到默认子目录（不能让 data 变成父目录本身）', () => {
    // 若空白被当成子目录名，cwd 会等于程序目录 → 配置文件直接躺在 exe 旁边。
    const r = resolveStoreDir({ portableDir: 'D:/App', dataSubDir: '   ' });
    expect(r.cwd).toBe(`D:/App/${DEFAULT_DATA_SUBDIR}`);
  });

  it('绝不去读 execPath / cwd 这类"看起来能拿到目录"的接口', () => {
    // 这条用行为固定设计意图：portable 模式下 execPath 指向**临时解压目录**，
    // 数据写进去会随临时目录被清理掉。所以本模块只认那两个明确信号，
    // 输入里没有 portableDir 时就老老实实回落到默认位置。
    const r = resolveStoreDir({ explicitDir: null, portableDir: null });
    expect(r.cwd).toBeUndefined();
  });
});

describe('resolveStoreDirFromEnv', () => {
  it('读 PORTABLE_EXECUTABLE_DIR 判定便携模式', () => {
    const r = resolveStoreDirFromEnv({ [ENV_PORTABLE_DIR]: 'D:/Portable' });
    expect(r.source).toBe('portable');
    expect(r.cwd).toBe('D:/Portable/data');
  });

  it('读 GRADING_EXAM_DATA_DIR 作为显式目录并优先', () => {
    const r = resolveStoreDirFromEnv({
      [ENV_DATA_DIR]: 'E:/data',
      [ENV_PORTABLE_DIR]: 'D:/Portable',
    });
    expect(r.source).toBe('explicit');
  });

  it('环境变量缺失/为 undefined 时不炸（真实 env 里键可能不存在）', () => {
    expect(resolveStoreDirFromEnv({}).source).toBe('default');
    expect(resolveStoreDirFromEnv({ [ENV_PORTABLE_DIR]: undefined }).source).toBe('default');
  });
});

describe('describeStoreLocation', () => {
  it('三种来源都要说出数据在哪 —— "数据在哪"必须能回答，不能含糊', () => {
    const portable = describeStoreLocation(resolveStoreDir({ portableDir: 'D:/Portable' }));
    expect(portable).toContain('D:/Portable/data');
    expect(portable).toContain('便携');

    const explicit = describeStoreLocation(resolveStoreDir({ explicitDir: 'E:/data' }));
    expect(explicit).toContain('E:/data');
    expect(explicit).toContain(ENV_DATA_DIR);

    const def = describeStoreLocation(resolveStoreDir({}));
    expect(def).toContain('不随程序目录移动');
  });
});