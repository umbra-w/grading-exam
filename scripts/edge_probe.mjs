// 对照实验：同样的打点逻辑，用系统 Edge（同为 Chromium）跑。
//
// 目的：区分"本机起不了 Chromium 系"和"本机起不了 Electron 这一份二进制"。
//   · Edge 也 0 打点  ⇒ 是更底层的问题（Chromium 在你这台机器上都起不来，
//                       那 ui:verify 成功过就与之矛盾，值得追）
//   · Edge 正常打点    ⇒ Electron 的那份二进制本身有问题（下载损坏/被杀软处理/
//                       缺 VC++ 运行库），换一份二进制就能救
//
// Edge 用 --headless=new + --remote-debugging-port 的方式不比 electron 亲切，
// 所以这里只做最小验证：能不能起来、能不能渲染出页面。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const LOG = process.env.GE_PROBE_LOG || 'edge-probe-log.txt';
const mark = (s) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()}  ${s}\n`); } catch {} };

const EDGE = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
mark(`edge probe start path=${EDGE} exists=${fs.existsSync(EDGE)}`);

const tmpProfile = `${process.env.TEMP}\\ge-edge-probe-${Date.now()}`;
const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${tmpProfile}`,
  '--dump-dom',
  'data:text/html,<h1 id=x>edge-probe-ok</h1>',
];
mark(`args=${args.join(' ')}`);

const child = spawn(EDGE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
let err = '';
child.stdout.on('data', (d) => { out += d.toString(); });
child.stderr.on('data', (d) => { err += d.toString(); });
child.on('error', (e) => mark(`spawn error: ${e.message}`));
child.on('exit', (code, sig) => {
  mark(`edge exit code=${code} signal=${sig}`);
  mark(`stdout contains marker = ${out.includes('edge-probe-ok')}`);
  mark(`stdout length=${out.length}`);
  if (err.trim()) mark(`stderr(first 400)=${err.slice(0, 400)}`);
  try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  mark(out.includes('edge-probe-ok') ? 'EDGE_OK' : 'EDGE_FAILED');
});

// 兜底超时
setTimeout(() => { mark('timeout 25s, killing'); child.kill(); }, 25000);