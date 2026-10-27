// 最小 Electron 探针：逐步打点，看"到底卡在哪一步"。
//
// ★ 为什么必须做这个：BLOCKERS B3 一直写着"app.whenReady() 阶段崩溃，
//   试过 9 种 flag 全失败"。但那个结论**从来没有被对照实验检验过** ——
//   它是在本应用上试出来的，无法区分两种完全不同的原因：
//     (a) 本机环境起不了任何 Electron（GPU/沙箱/杀软/驱动）
//     (b) 本应用自己的代码在启动早期炸了
//   两者的修法毫无关系。所以先跑一个"什么都没有"的 Electron：
//   它能起来 ⇒ 问题在应用代码里，而且是可修的；
//   它也起不来 ⇒ 问题在环境，那才是真正的阻塞。
//
// 打点用同步写文件（不用 console）—— Electron 崩溃时 stdout 往往一起没了。
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';

const LOG = process.env.GE_PROBE_LOG || 'probe-log.txt';
function mark(step) {
  try {
    fs.appendFileSync(LOG, `${new Date().toISOString()}  ${step}\n`);
  } catch { /* 打点本身不能把探针搞死 */ }
}

mark(`probe start argv=${JSON.stringify(process.argv.slice(1))}`);
mark(`electron=${process.versions.electron} chrome=${process.versions.chrome} node=${process.versions.node}`);
mark(`isPackaged=${app.isPackaged} resourcesPath=${process.resourcesPath}`);

process.on('uncaughtException', (e) => mark(`uncaughtException: ${e && e.stack}`));
process.on('unhandledRejection', (e) => mark(`unhandledRejection: ${e}`));

mark('before app.whenReady()');

app.whenReady().then(() => {
  mark('whenReady fired');
  try {
    const w = new BrowserWindow({ width: 600, height: 400, show: true });
    mark('BrowserWindow constructed');
    w.loadURL('data:text/html,<h1>probe ok</h1>');
    mark('loadURL called');
    w.webContents.on('did-finish-load', () => mark('did-finish-load'));
    setTimeout(() => {
      mark(`after 3s: visible=${w.isVisible()} title=${w.getTitle()}`);
      mark('PROBE_OK exiting');
      app.exit(0);
    }, 3000);
  } catch (e) {
    mark(`window phase threw: ${e && e.stack}`);
    app.exit(9);
  }
}).catch((e) => mark(`whenReady rejected: ${e && e.stack}`));

mark('module eval done');