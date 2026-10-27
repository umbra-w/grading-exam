# ARCH — Grading_exam 架构

> 本文描述**当前代码的真实结构**。规划中的模块标 ⚠ 未实现/未验证。
> 最后核对：见 `package.json` 版本与 `src/` 实际文件树。

## 1. 形态

Electron 桌面应用，**单进程无后端**。所有数据落盘在本机 `userData`。

```
┌──────────────────────────── Electron ────────────────────────────┐
│  main (Node)                preload            renderer (React)   │
│  ─────────────────          ────────           ───────────────    │
│  · ipcMain 路由             · contextBridge    · 五个功能面板     │
│  · BrowserWindow (阅卷页)   · index: API 桥    · Zustand store    │
│  · CDP: webContents.debugger  · viewer: 注入阅卷页                │
│  · AI HTTP 调用 (fetch)       ─ 拾取上报          · 无 Node 权限  │
│  · 配置持久化                                                  │
└──────────────────────────────────────────────────────────────────┘
        │ Chrome DevTools Protocol
        ▼
   阅卷平台页面 (可能含跨域 iframe / OOPIF / Canvas)
```

**为什么 AI 调用放在 main**：渲染层不开 Node 权限
（`contextIsolation: true`, `nodeIntegration: false`），避免页面脚本污染；
key 也只经 IPC 传递，不落 window。

## 2. 目录（实际存在的文件）

```
src/
├─ shared/                    渲染层与主进程共用，唯一真源
│  ├─ types.ts                全部 IPC 契约与领域类型
│  ├─ locator.ts              ★ 抗改版选择器候选生成（Playwright 官方优先级）
│  └─ selector.ts             CSS 兜底选择器 + 结构指纹
├─ main/
│  ├─ main.ts                 应用入口、窗口、IPC 路由
│  ├─ store.ts                配置持久化（electron-store）
│  ├─ ai/
│  │  ├─ client.ts            callAI / gradeQuestion / gradeQuestionMulti
│  │  ├─ compat.ts            ★ 供应商兼容层（thinking 开关、字段映射）
│  │  ├─ ensemble.ts          ★ 多次运行分歧度（自一致性）
│  │  └─ prompts.ts           评分/解析/学情 提示词模板 + 版本指纹
│  └─ page/
│     ├─ browser.ts           阅卷浏览器窗口生命周期  ⚠ 未在真机验证
│     ├─ cdp.ts               底层 CDP：click / insertText / eval  ⚠ 未在真机验证
│     ├─ geometry.ts          ★ 坐标换算、错误分类、提交状态机（纯逻辑）
│     └─ picker.ts            ★ 拾取结果组装、漂移检测（纯逻辑）
├─ preload/
│  ├─ index.ts                contextBridge API（泛型派发器，见 §3.6）
│  └─ viewer.ts               注入阅卷页：拾取上报 + 视觉反馈
└─ renderer/                  React 面板
   ├─ App.tsx / store.ts / styles.css
   ├─ components/             Sidebar / LogBar / StatusBar
   └─ panels/                 Browser / Single / Paper / Analysis / Settings
                              + PlaceholderPanel（未实现面板的统一占位）

tests/                        6 个 vitest 套件（300 项）+ fixtures/ 回归夹具页
scripts/                      Python 轨：数据集校验/迁移、契约冻结、评测指标
preview/                      界面验证：假 IPC 桥 + Edge 无头截图断言
```

> ⚠ 规划中但**尚未创建**的模块：`main/page/gradingLoop.ts`（连续阅卷状态机）、
> `main/io/parse.ts`、`main/io/export.ts`。所属阶段见 [STATUS.md](STATUS.md)。
> 这些文件不要写在文档里当作已存在——本文件此前正是因此误导过读者。

## 3. 关键设计

### 3.1 拾取（picker.ts + locator.ts）

浏览器窗口每个 frame 注入 `viewer.ts`。点击时：

1. 由 `locator.ts` 生成**按韧性排序的候选列表**（Playwright 官方优先级：
   `role` > `label` > `testid` > `placeholder` > `text` > `id` > `attr` > `css`）
2. 记录 frame 自身在顶层视口内的偏移，逐级累加
3. 计算 `topX = Σ frameOffset.x + localX`
4. 上报 `PickResult { kind, mode, framePath, selector, candidates[],
   localX, localY, topX, topY, tag, inIframe, width, height }`

**为什么存候选列表而不是单个选择器**：平台改版时最优候选可能失效，但下一档
仍能命中。运行时从上往下试第一个能唯一命中的，等于自动获得多级降级能力。
更重要的是——排序正确性因此从"运行时问题"变成"纯函数问题"，可以被单测钉死。

### 3.2 CDP 层（cdp.ts）—— 三个硬约束

```ts
// 1) 受控组件：只改 DOM value，框架状态不同步 → 平台不认
await send('Input.insertText', { text })   // 受信任键盘输入，React/Vue 必响应
// 2) OOPIF：直接派发进 iframe 渲染进程的鼠标事件会被 Electron 静默丢弃
await send('Input.dispatchMouseEvent', { type:'mousePressed', x: topX, y: topY, ... })
// 3) Canvas 平台：无输入框 → 先 click 聚焦，再 insertText，再 click 提交
```

**全部鼠标事件在顶层 target 派发**，由浏览器合成器路由进 iframe——
这是 Puppeteer 的做法。第 2 条是最容易踩的：**不报错，只是没反应**。

### 3.3 连续阅卷状态机（planning）

```
loop for each paper:
  capture → AI score ─┬─ mode=standard → record, next
                      ├─ mode=steady   → 等人工确认 → fill
                      └─ mode=top      → fill → submit
  fill():  score===0 ? 跳过填分 : insertText + readback
  readback 为空 → warn(VALUE_MISMATCH)，不中断
  submit(): 未拾取提交按钮 → 跳过，记 info
```

**唯一允许中断的状态是：窗口关闭、用户停止、AI 连续失败 3 次。** 其它一律警告。

> 该状态机**尚未实现**（`auto:*` 通道明确返回 `{ok:false, error:'未实现'}`，
> 界面按钮保持 `disabled`）。上面是设计意图，不是现状。

### 3.4 AI 兼容层（ai/compat.ts）

- `thinking: { type: 'disabled' }`：国产推理模型默认开思考模式，
  `reasoning_content` 也吃 `max_tokens`，必须显式关闭
- `content` 为空 → 回退读 `reasoning_content`
- 保留 `finish_reason` 与原始响应片段用于诊断
- 请求前判断：入参含图片且模型不在视觉白名单 → 提前报错，别浪费一次往返
- `buildRequestBody` 支持逐次覆盖 `temperature` —— 多次运行需要不同温度采样，
  否则同一输入同一温度的请求会退化成完全相同，测不出任何分歧

### 3.5 多次运行分歧度（ai/ensemble.ts）

让模型自评 `confidence` 是**弱信号**（普遍过度自信、常吐固定值）。
同一输入独立跑多次，结果散不散才是可观测的不确定性。

三条红线（都有专门用例）：
1. 只有一次运行**绝不能**判"一致" → 返回 `insufficient` 并要求复核
2. **一致 ≠ 正确** → 一致但自评置信度低时仍要复核
3. 分歧度必须**归一化** → 100 分制题不能因分值大就被判不稳定

副产品 `commonMisses`：各次运行**共同未命中**的得分点。一致地漏掉同一个点
不是噪声，是系统性盲区，是改提示词/rubric 的直接线索。

### 3.6 IPC 契约与 preload 派发

- 通道声明只在 `src/shared/types.ts` 的 `IPC` 接口里，**唯一真源**
- `preload/index.ts` 用泛型派发器 `invoke<K extends keyof IPC>(channel, ...args)`，
  只对高频动作包便捷方法。**手写 26 个包装会让通道名散落三处**，
  改名漏一处就是"点了没反应"的静默 bug
- 契约与实现必须严格一一对应（对账命令见 [AGENTS.md](AGENTS.md) §7.3）

### 3.7 数据流

```
试卷文件 → 解析 → AI 解析 → 题目结构
答卷图片 → AI 视觉 → { 姓名, 考号, 答案[] }
客观题   → normalize 精确比对（零网络零 token）
主观题   → AI 评分 → { score, comment, hitPoints[], missedPoints[], confidence,
                       ensemble? } → 低置信度入复核队列
        → 汇总 → 导出 Excel/Markdown / 学情分析
```

**客观题与主观题的结果永远分开报告**：前者是确定性比对（99~99.5%），
后者是统计一致性（MAE / ±1 比例 / 加权 Kappa / ICC）。不做单一"准确率"。

## 4. 技术选型

| 层 | 选择 | 版本 | 理由 |
|---|---|---|---|
| 壳 | Electron | ^45.0.0 | 需要 CDP + 多窗口 + 本地文件 |
| 构建 | electron-vite / Vite | ^6.0.0 / ^8.3.5 | 三端统一，HMR |
| 语言 | TypeScript strict | ^5.7.2 | 契约多，必须静态校验 |
| UI | React | ^19.3.1 | 生态熟 |
| 状态 | Zustand | ^5.0.16 | 轻，无 boilerplate |
| 持久化 | electron-store | ^12.0.0 | JSON 落盘，零后端（ESM-only） |
| 解析 | mammoth / pdf-parse | ^1.13.0 / ^2.4.5 | docx 与文字版 pdf |
| 导出 | exceljs | ^4.4.0 | 无服务端 |
| 测试 | vitest + jsdom | ^5.0.5 / ^30.1.3 | 与 Vite 同源；纯逻辑可直测 |
| 打包 | electron-builder | ^26.15.3 | Windows x64 |

## 5. 分层原则：纯逻辑 / 薄绑定

这是本项目最重要的架构约束，因为**本机 Electron 启动即崩**（见
[BLOCKERS.md](BLOCKERS.md) B3，退出码 `0xC0000005`）。

| 类别 | 文件 | 可验证性 |
|---|---|---|
| **纯逻辑** | `geometry.ts` `picker.ts` `locator.ts` `ensemble.ts` `selector.ts` | ✅ vitest 直接覆盖 |
| **薄绑定** | `cdp.ts` `browser.ts` `main.ts` 的窗口部分 | ⚠ **必须上真机** |

**因此：新功能一律先把纯逻辑抽出来测，再接薄绑定。**
抽取时给薄绑定打 `⚠ 未验证` 标记，并写清依赖什么才能验证。

界面层面的验证走另一条路：`pnpm ui:verify` 用系统 Edge 无头渲染同一份
渲染层代码 + 假 IPC 桥，做元素断言与对比度检查。详见
[AGENTS.md](AGENTS.md) §5.1。