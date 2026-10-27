/// <reference types="vite/client" />

/**
 * 渲染层的全局类型声明。
 *
 * ⚠ 这里**刻意不重复声明 `window.gradingExam` 的形状**。
 *
 * 原先这里手抄了一份 `GradingExamBridge`，14 个方法、返回类型大量写成 `unknown`：
 *   · 它漏了 `onBrowserClosed` / `pickerState` / `parseFile` 等真实存在的方法
 *   · 返回类型是 `unknown`，所以 `r.result` / `r.diagnostic` 这类**字段名写错**
 *     在渲染层完全不报错，一路活到运行时（本轮真的踩到了）
 *
 * 真源是 `src/preload/index.ts` 导出的 `GradingExamApi`（由 api 对象 `typeof` 推出），
 * 它自己会 `declare global` 扩到 Window 上，所以这里什么都不用做。
 * 少一份手抄，就少一处会静默漂移的地方。
 */

import type {} from '../preload/index';

export {};