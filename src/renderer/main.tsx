import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root 未找到');

// StrictMode 会让 effect 跑两次，这里刻意保留：
// 用于验证 onLog/onUsage 的取消订阅逻辑是否正确（重复注册会导致日志面板出现双份）。
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);