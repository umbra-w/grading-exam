import { useEffect, useState, type JSX } from 'react';
import { useStore } from './store';
import type { PageKey } from './store';
import { Sidebar } from './components/Sidebar';
import { LogBar } from './components/LogBar';
import { StatusBar } from './components/StatusBar';
import { SettingsPanel } from './panels/SettingsPanel';
import { BrowserPanel } from './panels/BrowserPanel';
import { SinglePanel } from './panels/SinglePanel';
import { ReviewPanel } from './panels/ReviewPanel';
import { PaperPanel } from './panels/PaperPanel';
import { AnalysisPanel } from './panels/AnalysisPanel';

function CurrentPanel({ page }: { page: PageKey }): JSX.Element {
  switch (page) {
    case 'browser':
      return <BrowserPanel />;
    case 'single':
      return <SinglePanel />;
    case 'review':
      return <ReviewPanel />;
    case 'paper':
      return <PaperPanel />;
    case 'analysis':
      return <AnalysisPanel />;
    case 'settings':
      return <SettingsPanel />;
  }
}

export function App(): JSX.Element {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const appendLog = useStore((s) => s.appendLog);
  const setLogs = useStore((s) => s.setLogs);
  const setUsage = useStore((s) => s.setUsage);
  const setAppInfo = useStore((s) => s.setAppInfo);
  // 启动失败的原因。有值时整个界面让位给一张错误说明 ——
  // 与其给用户一个"能用但其实全坏"的界面，不如直接说清楚哪里坏了。
  const [bootError, setBootError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const disposers: Array<() => void> = [];

    void (async () => {
      // ★ 这段必须整体 try/catch。
      //   原来它是"裸"的 async IIFE：一旦 preload 没加载（window.gradingExam 为
      //   undefined）或某个 IPC handler 抛错，这里就变成一个**未处理的 rejection**
      //   —— React 不会做任何事，界面停在一片空白，用户只能看到窗口一闪。
      //   失败必须被说出来，这既是诊断需要，也是本项目的诚实纪律（AGENTS §1.2）。
      try {
        // 回放启动阶段的历史日志，再开始接收增量
        const history = await window.gradingExam.getLogHistory();
        const info = await window.gradingExam.getAppInfo();
        if (!alive) return;

        setLogs(history);
        setAppInfo(info);

        disposers.push(window.gradingExam.onLog(appendLog));
        disposers.push(window.gradingExam.onUsage(setUsage));
      } catch (e) {
        if (!alive) return;
        const err = e as Error;
        setBootError(
          `${err?.name ?? 'Error'}: ${err?.message ?? String(e)}\n\n` +
            '这通常意味着预加载脚本（preload）没有加载成功，或主进程的某个 IPC 处理器抛错。',
        );
      }
    })();

    return () => {
      alive = false;
      // 必须取消订阅：StrictMode 下会挂载两次，漏了就会出现双份日志
      for (const d of disposers) d();
    };
  }, [appendLog, setLogs, setUsage, setAppInfo]);

  /*
   * 双向同步页签与 URL hash。
   *
   * 为什么值得做（不是为了好看）：
   *   · 开发时能深链到某个面板（#settings），不必每次手点
   *   · 界面预览脚本需要逐个面板截图，没有它就只能靠鼠标
   *   · 切页签可被浏览器前进/后退，符合直觉
   */
  useEffect(() => {
    const applyHash = (): void => {
      const raw = (location.hash || '').replace(/^#\/?/, '').trim();
      if (raw && raw !== useStore.getState().page) setPage(raw as PageKey);
    };
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, [setPage]);

  useEffect(() => {
    if (location.hash.replace(/^#\/?/, '') !== page) {
      // 用 replaceState 而非直接赋 hash：后者会在历史里堆一堆中间态
      history.replaceState(null, '', `#${page}`);
    }
  }, [page]);

  // ★ 启动失败时，整屏显示原因，而不是留一个空白界面。
  //   空白界面最坏的地方在于：它看起来像"设计很简洁"，用户会以为自己点错了什么，
  //   于是去排查一个根本不存在的问题（AGENTS §6.4）。
  if (bootError) {
    return (
      <div className="app">
        <div style={{ padding: 32, font: '14px/1.7 system-ui, "Microsoft YaHei", sans-serif', color: 'var(--text)' }}>
          <h1 style={{ fontSize: 18, margin: '0 0 8px' }}>界面启动失败</h1>
          <p style={{ margin: '0 0 16px', color: 'var(--text-mid)' }}>
            软件已启动，但渲染层与主进程的通信没有建立。
          </p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)',
              padding: 12,
              fontSize: 12,
              color: 'var(--err-text)',
            }}
          >
            {bootError}
          </pre>
          <p style={{ marginTop: 16, color: 'var(--text-mid)' }}>
            启动日志（含更详细的原因）在数据目录的 <code>startup.log</code> 里，
            路径见下方状态栏或应用启动时打印的「配置存放于 …」。
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="app-body">
        <Sidebar />
        <div className="content">
          <CurrentPanel page={page} />
        </div>
      </div>
      <LogBar />
      <StatusBar />
    </div>
  );
}