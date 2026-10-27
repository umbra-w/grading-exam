# AGENTS.md — 在本仓库工作前必读

> 面向 AI agent 与人类协作者。**先读完这一页再动代码。**
> 配套文档：[SPEC.md](SPEC.md)（做什么）· [ARCH.md](ARCH.md)（怎么分层）·
> [PLAN.md](PLAN.md)（v2.0 执行计划）· [CONTRACT.md](CONTRACT.md)（契约冻结）·
> [STATUS.md](STATUS.md)（当前进度）· [BLOCKERS.md](BLOCKERS.md)（阻塞与裁定）

---

## 1. 这个项目是什么

**Grading_exam**（原名 YJAI · 阅卷AI）—— Electron 桌面端的 AI 阅卷助手。

老师在自己**拥有账号的阅卷平台**上，由软件自动完成"看题目 → 评学生答案 →
把分数填进平台的输入框 → 提交"这一串操作。全部数据落本机，无后端。

**开源版定位**：移除了原软件的激活与授权机制，代码全部可审计、可自行构建。

### 1.1 三条不可逾越的边界（写在 SPEC §3.6，有禁语清单）

| 边界 | 含义 |
|---|---|
| **只服务本人账号** | 不得用于代他人阅卷、不得用于未授权平台 |
| **不声称"支持主流阅卷平台"** | 首个真实平台仍需约 0.5~1 天适配；平台各异，做不到通吃 |
| **客观题与主观题分开报告** | 客观题是确定性比对（99~99.5%），主观题是统计一致性（MAE/Kappa/ICC）。**永远不要合并成一个"准确率"数字** |

### 1.2 诚实原则（本项目的核心纪律）

> **宁可显示"这里没做完"，也不要让界面/文档看起来已经能用。**

这条纪律已经抓出一批真实问题，见 §6.4。具体表现：

- 未实现的按钮**保持 `disabled`** 并写明原因，不做成"点了没反应"
- 不伪造成功响应。`auto:*` 通道明确返回 `{ok:false, error:'未实现'}`
- 能力边界上不写"支持所有平台"这类话
- 指标未标定时就说未标定（`0.75` 的置信度阈值目前仍是**未经标定的经验值**）

---

## 2. 技术栈与版本（以 `package.json` 为准）

| 层 | 选择 | 版本 |
|---|---|---|
| 壳 | Electron | ^45.0.0 |
| 构建 | electron-vite | ^6.0.0 / Vite ^8.3.5 |
| UI | React | ^19.3.1 |
| 语言 | TypeScript strict | ^5.7.2 |
| 状态 | Zustand | ^5.0.16 |
| 持久化 | electron-store | ^12.0.0（**ESM-only**） |
| 解析 | mammoth / pdf-parse | ^1.13.0 / ^2.4.5 |
| 导出 | exceljs | ^4.4.0 |
| 测试 | vitest + jsdom | ^5.0.5 / ^30.1.3 |
| 打包 | electron-builder | ^26.15.3 |

**环境**：Node v24.11.0 · pnpm 11.25.0 · Python 3.14.0 · git 2.29.2（Windows）

> ⚠️ pnpm 是 corepack shim，**不在** `node_modules/pnpm`。
> 在 PowerShell 里调用要用 `cmd /c "pnpm ..."`。
> 需要联网时走代理 `http://127.0.0.1:7897`（见 workspace 级 AGENTS.md）。

---

## 3. 常用命令

```powershell
pnpm typecheck        # 双 project 类型检查（node + web），两侧都必须 exit=0
pnpm test             # vitest run
pnpm build            # typecheck + electron-vite 三端构建
pnpm dev              # 开发模式（本机 Electron 起不来，见 §5）

# Python 轨（评测与数据）
pnpm metrics:selftest     # 指标库自测
pnpm eval:selftest        # 评测流水线自测
pnpm validate:dataset     # 数据集契约校验
pnpm freeze:verify        # 契约冻结校验
pnpm ipc:check            # IPC 契约对账（命令 + 事件 + 订阅 + 是否真发送）
pnpm verify:all           # 上面这些 + typecheck + test 一条龙
pnpm fixtures             # 起夹具静态服务 127.0.0.1:8000

# 界面验证（Electron 起不来时的替代路径）
pnpm ui:verify            # 打包→起服务→逐面板截图→断言→对比度+像素统计+样式类存在性
```

### 3.1 Python 必须带的两个环境变量

```powershell
$env:PYTHONDONTWRITEBYTECODE=1   # 防止在源码旁生成 __pycache__（workspace 规则）
$env:PYTHONUTF8=1                # 防止中文输出触发 GBK UnicodeEncodeError
```

---

## 4. 代码结构与关键约定

```
src/
├─ shared/            ★ 渲染层与主进程共用，唯一真源
│  ├─ types.ts          全部 IPC 契约 + 领域类型（改通道先改这里）
│  ├─ locator.ts        抗改版选择器候选生成（Playwright 官方优先级）
│  └─ selector.ts       CSS 兜底选择器 + 结构指纹
├─ main/
│  ├─ main.ts           应用入口、窗口、IPC 路由（命令通道全部在此注册）
│  ├─ store.ts          配置持久化（electron-store）
│  ├─ ai/
│  │  ├─ client.ts         callAI / gradeQuestion / gradeQuestionMulti
│  │  ├─ compat.ts         供应商兼容层（thinking 开关、字段映射、视觉白名单）
│  │  ├─ ensemble.ts     ★ 多次运行分歧度（自一致性）
│  │  └─ prompts.ts        提示词模板 + 版本指纹
│  └─ page/
│     ├─ browser.ts        阅卷窗口生命周期（⚠ 未在真机验证）
│     ├─ cdp.ts            底层 CDP：click / insertText / eval（⚠ 未在真机验证）
│     ├─ geometry.ts     ★ 坐标换算、错误分类、提交状态机（纯逻辑）
│     └─ picker.ts         拾取结果组装、漂移检测（纯逻辑）
├─ preload/
│  ├─ index.ts           contextBridge API（泛型派发器，见 §4.2）
│  └─ viewer.ts          注入阅卷页：拾取上报 + 视觉反馈
└─ renderer/            React 面板 + styles.css
```

### 4.1 IPC 契约只有一处真源

所有命令通道在 [`src/shared/types.ts`](src/shared/types.ts) 的 `IPC` 接口里声明。
**主进程注册的通道必须与之严格一一对应**，改完要跑对账（见 §7.3）。

历史上出过 `io:parseFile` / `io:exportExcel` / `io:exportMarkdown`
**在契约里声明但从未实现**——渲染层一调就运行时炸。所以：

> 契约里不允许存在没有实现的通道，也不允许存在未进契约的实现。

### 4.2 preload 用泛型派发器，不要逐个手写

`src/preload/index.ts` 用 `invoke<K extends keyof IPC>(channel, ...args)` 转发，
类型由 `IPC[K]` 约束。**通道名只出现在 `types.ts` 一处**。

为什么：手写 26 个包装会把通道名在三处各写一遍，改名漏一处就是
"点了没反应"的静默 bug。只对高频动作用便捷方法包一层（`browserOpen` 等）。

### 4.3 自动化层的三个硬约束（CDP）

1. **受控组件必须用 `Input.insertText`** —— `el.value = x` 不会触发
   React/Vue 的状态更新，平台不认
2. **鼠标事件必须在顶层 target 派发** —— 直接派发进 OOPIF 的渲染进程会被
   Electron **静默丢弃**（不报错，只是没反应）
3. **顶层视口坐标 = `Σ frameOffset + localXY`** —— 跨域 iframe 逐级累加

### 4.4 纯逻辑与薄绑定分离（必须遵守）

`geometry.ts` / `picker.ts` / `locator.ts` / `ensemble.ts` 是**纯函数**，
因此能被 vitest 直接覆盖。`cdp.ts` / `browser.ts` 是薄绑定，无法本地验证。

> **新功能一律先把纯逻辑抽出来测，再接薄绑定。**
> 这不是偏好，是唯一可行的验证手段——本机 Electron 起不来（§5）。

抽取时给薄绑定函数打 `⚠ 未验证` 标记，并写清依赖什么才能验证。

---

## 5. ⚠️ 本机 Electron 启动阻塞（必读）

**症状**：`app.whenReady()` 阶段进程崩溃，退出码 `0xC0000005`（`-1073741819`）。
已试过 9 种 flag 组合（含 `--no-sandbox`、`--disable-gpu`、`--in-process-gpu`），
**全部失败**。详见 [BLOCKERS.md](BLOCKERS.md) B3。

**影响**：Phase 2 的窗口行为、CDP 操作、拾取全流程**都无法在本机验证**。

**应对策略**（不要试图绕过，按这个来）：

| 想验证什么 | 可行手段 |
|---|---|
| 纯逻辑正确性 | vitest（已覆盖 381 项） |
| 界面布局与配色 | `pnpm ui:verify`（Edge 无头渲染，见 §5.1） |
| 窗口/CDP/拾取行为 | **必须上真机**，本地做不到，不要假装能验 |

### 5.1 界面验证为什么用 Edge 而不是 Electron

用系统自带 Edge（Chromium）无头渲染**同一份渲染层代码**，配合
[`preview/preview-api.js`](preview/preview-api.js) 这一层假 IPC 让界面能水合。
它检查四件事，每件都对应一类真实翻车：

1. **每个面板的关键元素必须出现** —— React 抛错时页面静默变空白，
   而空白页截图**看起来很像"设计很简洁"**
2. **水合标志**（`PREVIEW_RENDER_OK`）—— 断言 React 真的挂载成功
3. **反向断言** —— 初始态不该出现"正在拾取"这类瞬时态
4. **对比度** —— 从 `styles.css` 解析设计令牌后算 WCAG 对比度

> 维护提醒：`preview-api.js` 的假数据**必须跟着 `AppSettings` 真实结构走**。
> 曾因顶层写 `exportDir`（真实是 `general.exportDir`）导致设置面板白屏。

---

## 6. 已踩过的坑（重犯一次就白学）

### 6.1 静默失败是最危险的一类 bug

这类 bug **不报错**，只是悄悄给出错误结果。已抓到并修复的：

| 缺陷 | 后果 |
|---|---|
| `asNumber('abc')` 返回 `0` | 非数字答案被**静默记为 0 分**（看起来完全正常） |
| `label=` 候选退化成 placeholder | 生成一个**永远匹配不到**的选择器，不报错只静默失效 |
| 界面写死「Phase 2 未实现」 | 通道其实早已实现，用户以为坏了 |

**排查手法**：假设"这段代码失败了会怎样"，如果答案是"看起来和成功一样"，
就必须加显式检查。

### 6.2 分数/指标必须归一化后才能跨题比较

`agreement` 曾用**绝对分差**判定：100 分制题上 60 vs 62（差 2%）
被误判为 major 分歧；而 10 分制题上 0.2 的差反而没事。

**规则**：任何阈值判定涉及不同满分值的，一律归一化。

### 6.3 「一致 ≠ 正确」

多次运行一致**不**代表结果正确——多次给出同一个错分是最危险的情况
（不是噪声，是系统性盲区）。所以：

- 只有一次运行时**绝不能**判"一致"，必须返回 `insufficient` 并要求复核
  （「没测过」不等于「测过且通过」）
- `commonMisses`（各次共同未命中的得分点）是改提示词的主要线索，
  单跑一次永远发现不了

### 6.4 文档/界面说了假话比功能没做更糟

本轮发现四处「界面在说谎」。**功能没做用户能看出来；界面说谎，用户会以为
自己坏了**，反而去排查一个不存在的问题。

**检查手法**：改完一个模块后，搜界面上所有提到该模块的文字，逐条问
「这句现在还成立吗」：

```powershell
Select-String -Path src\**\*.ts,src\**\*.tsx -Pattern '未实现|未接入|尚未|Phase \d'
```

### 6.5 验证器本身必须被验证

`verify_ui.py` 曾出现「截图不存在 → 跳过像素检查 → 报全部通过」。
那一刻**验证器在说谎**，而且说的是"全部通过"——比没有验证器更危险。

**规则**：验证器的每个"跳过"都要重新审视。**该有的产物不存在必须判失败**，
不能降级成跳过。

### 6.6 工具的默认解析基准要核实，不能想当然

Vite 的 `--outDir` 是相对 **root** 解析，不是相对当前工作目录。
`vite build preview --outDir preview/dist` 实际写到 `preview/preview/dist/`，
静态服务 404 —— **而构建日志显示"成功"**。

**教训**：命令行参数带相对路径时先确认解析基准。已改用带绝对路径的
[`preview/vite.config.mjs`](preview/vite.config.mjs) 消歧义。

### 6.7 中文脚本不要写成 `.cmd`

cmd.exe 按 OEM 代码页逐字节解析批处理文件，**UTF-8 中文注释会被拆成命令执行**
（实测报出 `'打包预览页' is not recognized`），脚本静默不干活。

**处置**：预览检查统一用 Python 实现（可直接指定 UTF-8）。

### 6.8 绝不能为了让校验器变绿而删真实数据

`MATH-CALC-0001` 曾出现 A=5.5 / B=6.0（差 0.5，低于 1.0 阈值）却带着
`score_arbitrated=6` 与一段声称"扣了 0.5"的理由——**理由与结果自相矛盾**。

**处置**：清空仲裁字段，**把争议原文完整保留在 `notes`**，标记待教师裁定。
没有为了让校验通过而删掉这条数据。

> 红灯往往指向真实的数据问题。删数据是最快的"修复"，也是唯一不可逆的。

### 6.9 环境细节

- `assets/` 与 `out/` 是构建产物，不入库
- **所有 Python 调用带 `PYTHONDONTWRITEBYTECODE=1`**，否则源码旁会生成 `__pycache__`
- 删除/移动文件前先确认解析出的绝对路径就是你想要的那个

---

## 7. 改完代码必须做的验证

### 7.1 改动类型 → 必须跑的检查

| 改了什么 | 必跑 |
|---|---|
| 任何 TS/TSX | `pnpm typecheck` + `pnpm test` |
| 纯逻辑模块 | 补/改对应 `tests/*.test.ts` |
| IPC 通道 | 契约对账（§7.3）+ 更新 `preload` |
| `styles.css` / 面板 | `pnpm ui:verify` |
| 提示词 `prompts.ts` | 更新 `PROMPT_VERSION`，考虑 `freeze:contract` |
| 数据集结构 | `pnpm validate:dataset` + 更新 CONTRACT.md |

### 7.2 收尾时的完整验证

```powershell
pnpm typecheck && pnpm test && pnpm build
pnpm metrics:selftest && pnpm eval:selftest && pnpm validate:dataset && pnpm freeze:verify
pnpm ui:verify          # 动了界面才需要
```

全绿之后删掉构建产物：`out/`、`node_modules/.vite`、`preview/dist`。

### 7.3 IPC 契约对账（改过通道必跑）

```powershell
pnpm ipc:check          # 等价于 python scripts/check_ipc.py --events
```

以前这里贴的是一段内联 Python。**已删掉**，原因很实际：那段脚本要在
PowerShell 里转义引号，实测每次都要写错一两轮才跑得起来。一个"跑起来很费劲"
的检查最终会被跳过，而**被跳过的检查等于不存在**。

脚本检查四件事，**每条都对应一类真实翻车**：

| 检查 | 抓什么 |
|---|---|
| 命令通道：契约 ↔ 实现 | 声明了没实现（运行时炸）/ 实现了没进契约（越界） |
| 事件通道：契约 ↔ preload 订阅 | 订阅了错名字，或契约里有却无人监听 |
| **事件是否真的被 `send`** | 声明了、也订阅了，但主进程从不发送——**不会报错的谎言** |
| `PLANNED_UNSENT` 白名单 | 区分「有意为之的未实现」与「忘了接的实现」 |

两侧都必须干净。已知的两个未发送事件（`evt:progress` / `evt:awaitConfirm`，
依赖 Phase 5）**必须在 `scripts/check_ipc.py` 的 `PLANNED_UNSENT` 里登记**，
否则判失败。新加幻影事件时，要么接上发送方，要么显式登记并写明依赖阶段。

---

### 7.4 新增坑（本轮踩到，三次同类）

#### 假桥与真实 API 的漂移（已用测试钉死）

`preview/preview-api.js` 是**普通 JS，不参与 `tsc`**，所以它和
`src/preload/index.ts` 的漂移**编译期完全发现不了**。已经栽过三次：

| 漂移 | 后果 |
|---|---|
| `exportDir` 写在顶层（真实是 `general.exportDir`） | 设置面板**白屏** |
| 漏 `onBrowserClosed` | 预览里面板**直接崩** |
| `pickerState` 漏 `open/url/kernel/pendingPick` | 面板显示**假的**窗口状态 |

现在有 `tests/preview-parity.test.ts`：源码级提取 + 集合比对，**已注入漂移验证过会真红**。
改了 preload API 就必须同步假桥，否则 `pnpm test` 立刻红。

#### 手抄的类型副本会静默失效

`src/renderer/env.d.ts` 曾手抄一份 `GradingExamBridge`，14 个方法、
返回类型大量写成 `unknown`。后果：**字段名写错在渲染层完全不报错**
（本轮把 `r.result` / `r.diagnostic` 写成错名，一路活到运行时）。

现在真源是 `src/preload/index.ts` 的 `GradingExamApi = Omit<typeof api, 'invoke'>`，
`env.d.ts` 只做 `import type {} from '../preload/index'`。
**不要在任何地方手抄这份类型。**

#### 样式类没有定义不会报错

写了 `className="segmented"` 而 CSS 里没有这个类，元素回退成浏览器默认样式：
按钮变灰白方块、并排字段竖着堆。截图仍然"有内容"、对比度也照样过。

`pnpm ui:verify` 现在会断言 **TSX 里静态 className 用到的每个类都在
`styles.css` 里有定义**（已注入缺失类验证过会红）。
动态拼接的类名不在此列——那部分不假装能检查。

#### 验证脚本自己会静默不生效

本轮我用 PowerShell 正则做替换来注入测试探针，`-replace` **没匹配上**，
于是"探针通过"变成了假象。我是靠额外加一句"替换是否生效"的断言才发现的。

**规则**：任何"注入故障看是否报错"的验证，必须同时断言**注入本身生效了**。
否则你验证的是"什么都没改变时一切正常"。

---

## 8. 工作方式

### 8.0 每次测试通过后必须提交（硬性流程）

> **验证全绿 → 立刻提交。一个通过验证的工作状态不允许悬在工作区里。**

流程固定为：

```
改代码 → 跑对应检查（§7.1）→ 全绿 → git commit → 继续下一步
                          ↘ 有红 → 修好再提交，不允许提交红灯状态
```

**为什么必须当场提交**：本项目的验证成本高（本机 Electron 起不来，
只能靠 vitest + Edge 无头渲染）。一个"已通过 300 项单测"的状态是**花了几十分钟
挣来的**，如果只留在工作区，任何后续改动都可能把它弄脏，而重新验证的成本要再付一次。
把它固定成提交，就等于把"已验证"这个事实**留在了可回溯的历史里**。

**提交前的最小检查**（按改动类型从 §7.1 取）：

```powershell
pnpm typecheck      # 任何 TS/TSX 改动都必须跑
pnpm test           # 同上
```

收尾或跨阶段时跑完整的 §7.2。

**提交信息要求**：说明**影响了什么**，并把验证结果写进去。见 §8.4。

**不要做的事**：
- 不要攒一大堆改动一次性提交（无法回溯哪一步引入了问题）
- 不要为了让 `git status` 干净而把未验证的改动也提交进去
- 不要跳过检查直接提交——那等于声称验证过

### 8.1 契约优先

`src/shared/types.ts` 是唯一真源。**先改契约，再改实现，最后改调用方。**
契约变更要同步 [CONTRACT.md](CONTRACT.md) 并在 §11 修订记录里加一条。

### 8.2 测试先行（针对纯逻辑）

纯逻辑模块**先写测试再写实现**。理由同 §4.4：这是唯一能在本机验证的手段。
已覆盖 381 项（`geometry` 66 / `ai` 60 / `ensemble` 51 / `locator` 45 /
`picker` 43 / `objective` 39 / `selector` 35 / `parse` 34 / `preview-parity` 9）。

### 8.3 写"为什么"，不是"是什么"

注释要记录**决策理由与取舍**，因为代码本身已经说明了"是什么"。
反面例子：`// 设置分数`。正面例子见本仓库任意文件——
例如 `ensemble.ts` 里解释"为什么下界不是 0"。

### 8.4 提交信息

用中文，说明**影响了什么**而不只是"改了哪些文件"：

```
feat(界面): 简洁 + 一点点二次元；修掉四处「界面在说谎」

- 主色改靛蓝偏紫，樱花粉点缀（实测像素占比 21.81% / 0.22%）
- 拾取按钮接上真实通道（此前全部 disabled 且标注"未实现"）
- 状态栏拾取状态此前写死，现订阅 evt:pick 真实反映
- 新增 pnpm ui:verify：Edge 无头渲染 + 断言 + 对比度检查
```

### 8.5 目录规则（workspace 级，见上级 AGENTS.md）

本项目所有文件都在
`C:\Users\admin\Desktop\_agent_workspace\Grading_exam\` 内。
临时/生成文件不要写到 `_agent_workspace` 根目录或桌面。

---

## 9. 当前进度与下一步

见 [STATUS.md](STATUS.md)。摘要：

| 阶段 | 状态 |
|---|---|
| Phase 0 地基 | ✅ |
| Phase 1 AI 层 | ✅ |
| Phase 2 自动化层（纯代码 + 界面） | ✅（CDP/窗口 ⚠ 未在真机验证） |
| Phase 3 界面壳 | ✅ |
| Phase 4 单题闭环 | 🟡 代码侧 ✅ / 界面侧 ✅ / 端到端 ⬜（待真机） |
| Phase 5~7 | ⬜ |

**仍需人工推进**（本机无法替代）：真实阅卷平台账号、教师标注资源（E2）、
能启动 Electron 的机器。