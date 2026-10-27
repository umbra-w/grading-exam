import { useEffect, type JSX } from 'react';
import { useStore } from './store';
import type { PageKey } from './store';
import { Sidebar } from './components/Sidebar';
import { LogBar } from './components/LogBar';
import { StatusBar } from './components/StatusBar';
import { SettingsPanel } from './panels/SettingsPanel';
import { BrowserPanel } from './panels/BrowserPanel';
import { SinglePanel } from './panels/SinglePanel';
import { PaperPanel } from './panels/PaperPanel';
import { AnalysisPanel } from './panels/AnalysisPanel';

function CurrentPanel({ page }: { page: PageKey }): JSX.Element {
  switch (page) {
    case 'browser':
      return <BrowserPanel />;
    case 'single':
      return <SinglePanel />;
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

  useEffect(() => {
    let alive = true;
    const disposers: Array<() => void> = [];

    void (async () => {
      // 回放启动阶段的历史日志，再开始接收增量
      const history = await window.gradingExam.getLogHistory();
      const info = await window.gradingExam.getAppInfo();
      if (!alive) return;

      setLogs(history);
      setAppInfo(info);

      disposers.push(window.gradingExam.onLog(appendLog));
      disposers.push(window.gradingExam.onUsage(setUsage));
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