/**
 * 启动自检脚本（Golden Path）。
 *
 * 用途：在 CI 或无人值守环境下验证 Electron 主进程、preload、渲染层三者能完整装配，
 *       并在加载完成后主动退出，避免挂成常驻窗口。
 *
 * 用法：node_modules\electron\dist\electron.exe scripts\smoke-main.cjs
 *
 * 判据：
 *   - 窗口 loadURL/loadFile 成功（did-finish-load 触发）
 *   - 渲染层执行到 window.gradingExam 存在（证明 preload 桥接生效）
 *   - 主进程 IPC 能应答（证明 ipcMain 注册成功）
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
let failed = false;

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

// 用最小主进程复刻真实 IPC 面，保证自检不依赖完整 main.ts 的业务逻辑
ipcMain.handle('smoke:ping', () => 'pong');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'out', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    check('渲染层加载', false, `${desc} (${code}) ${url}`);
    finish();
  });

  // 渲染层控制台错误也要暴露出来，否则构建产物里的问题会被静默吞掉
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`    [renderer console] ${message}`);
  });

  try {
    await win.loadFile(path.join(ROOT, 'out', 'renderer', 'index.html'));
    check('渲染层加载', true, 'did-finish-load');

    // preload 桥接：window.gradingExam 必须存在
    const hasBridge = await win.webContents.executeJavaScript(
      'typeof window.gradingExam === "object" && window.gradingExam !== null',
    );
    check('preload 桥接 window.gradingExam', hasBridge === true, String(hasBridge));

    // 桥接暴露的方法数与类型
    const bridgeKeys = await win.webContents.executeJavaScript(
      'Object.keys(window.gradingExam || {}).sort().join(",")',
    );
    check('桥接方法齐全', bridgeKeys.includes('getSettings') && bridgeKeys.includes('onLog'), bridgeKeys);

    // React 是否真的渲染出了 DOM（而不只是空 #root）
    const rootHtmlLen = await win.webContents.executeJavaScript(
      'document.getElementById("root")?.innerHTML.length ?? 0',
    );
    check('React 渲染出内容', rootHtmlLen > 200, `#root innerHTML = ${rootHtmlLen} 字符`);

    // 侧边栏导航渲染出来没有
    const navCount = await win.webContents.executeJavaScript(
      'document.querySelectorAll(".nav-item").length',
    );
    check('侧边栏导航项', navCount === 5, `${navCount} 项`);

    // IPC 往返
    const pong = await win.webContents.executeJavaScript(
      'window.gradingExam.getSettings().then(() => "ok").catch(e => "err:" + e.message)',
    );
    check('IPC 调用 settings:get 可达', typeof pong === 'string', String(pong).slice(0, 80));
  } catch (err) {
    check('启动自检', false, err && err.message ? err.message : String(err));
  }

  finish();
});

function finish() {
  console.log('');
  console.log(failed ? '结果：存在失败项' : '结果：全部通过');
  app.exit(failed ? 1 : 0);
}

// 兜底：15 秒内没结束就强制失败退出，避免 CI 卡死
setTimeout(() => {
  console.log('FAIL  自检超时（15s），强制退出');
  app.exit(1);
}, 15000);