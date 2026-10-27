# STATUS — Grading_exam 进度与环境须知

> 配套文档：[SPEC.md](SPEC.md)（做什么）、[ARCH.md](ARCH.md)（怎么分层）、[PLAN.md](PLAN.md)（v2.0 执行计划）、[CONTRACT.md](CONTRACT.md)（契约冻结）、[BLOCKERS.md](BLOCKERS.md)（阻塞与裁定）
> 最近更新：2026-10-23

---

## 0. 本轮：Phase 4 起步 + 仓库初始化

**仓库已初始化并两次提交；Phase 4 的代码侧完成。**

### 0.1 仓库状态

```
84af65f  feat(P4): 客观题零网络比对 + 文件解析导出；修掉三处「契约里有但不生效」
8c9e90e  chore: 初始化仓库 —— Grading_exam 首个提交
```

分支 `main`，无远端。**纪律：验证全绿即提交**（AGENTS.md §8.0）。

新增 [AGENTS.md](AGENTS.md)：项目边界、已踩过的坑、验证流程、提交纪律。
[ARCH.md](ARCH.md) 按实际代码重写——此前写着 Electron ^31 / React 18（实际 45/19），
且列了 `gradingLoop.ts`、`io/parse.ts`、`io/export.ts` 三个**并不存在**的文件。
文档说假话和界面说假话一样有害，已按真实文件树核对。

### 0.2 Phase 4 已完成的部分（代码侧）

| 任务 | 状态 | 证据 |
|---|---|---|
| P4-2 文件解析（docx/pdf/txt/md） | ✅ | `main/io/parse.ts` + 34 项单测 |
| P4-6 评分输出结构 | ✅ | `GradingDetail` 补 `confidence`/`reviewRequested` |
| 客观题零网络比对 | ✅ | `shared/objective.ts` + 39 项单测 |
| 导出 Excel / Markdown | ✅ | `main/io/export.ts`（P5-7/P6 前置） |
| P4-1 评分标准录入界面 | ⬜ 下一步 | — |
| P4-4 答案输入（文本/截图/剪贴板） | ⬜ 下一步 | — |
| P4-5 姓名考号识别（可选） | ⬜ 下一步 | — |

**客观题为什么单独一层**：判对错是字符串比对问题，不是理解问题。
交给大模型白花 token、引入非确定性（同一答卷两次跑不一样）、
还会污染因果关系（模型答错时你分不清是题难还是比对错）。
所以客观题走本地路径（**零网络零 token**），主观题才走 AI，两条路径代码隔离。

判错代价不对称这一条决定了实现取向：
- 误判「对」→ 成绩虚高且**无人会发现**
- 误判「错」→ 学生申诉，能被发现

所以不确定的一律判错并附原因，绝不悄悄猜。三道关键防线都有专门用例：
**空标准答案不得给分**（否则整题所有学生全对）、空答案与做错分开统计、
学生写选项内容而非字母时判 `suspect` 且**不给分**。

### 0.3 本轮修掉的「契约里有但不生效」

这类缺陷的共同点：**契约声明了、但实现没接**，于是既不报错也不生效。

| 缺陷 | 后果 |
|---|---|
| `evt:browserClosed` 在契约里、preload 也订阅了，但**主进程从不发送** | 用户手动关掉阅卷窗口后，界面永远显示「窗口已打开」，点拾取却报「请先打开窗口」 |
| `GradingDetail` **没有 `confidence` 字段**（只有 `GradeResult` 有） | 结果一落库置信度就丢，分层阈值与复核队列全部失去依据，且不报错 |
| 预览假桥 `pickerState` 缺 `open/url/kernel/pendingPick` | 面板读到 `undefined`，显示假的窗口状态 |
| 预览假桥与真实 preload **会悄悄漂移**（第三次同类问题） | 改了真代码，预览坏掉而 `tsc` 抓不到（假桥是普通 JS，不参与类型检查） |

最后一条值得单说：预览是本机唯一能看到界面的途径，而它靠一份手写假桥。
假桥漏方法 → 预览崩 → 我们会误以为"界面没问题"。
已新增 `tests/preview-parity.test.ts`：**源码级提取 + 集合比对**，
并**验证过它真的会红**（故意抽掉方法后确实报错）——否则就是又一个假绿。

---

### 0.4 上一轮：界面落地

#### 0.4.1 风格取向（设计决策）

取向刻意收在**工具感**这一侧——这是老师要用来批量批卷的生产力工具，
不是消遣应用。二次元的味道只从三处渗透，不铺满：

| 手法 | 具体做法 |
|---|---|
| 主色偏移 | 不用纯商务蓝，改用**靛蓝偏紫** `#6366f1`（色相 239°），樱花粉 `#f472b6` 点缀 |
| 造型语汇 | 大圆角（8/11/14px）、弥散低透明投影、按钮悬停"弹一下"、按下"压回去" |
| 微观装饰 | 侧栏右下极淡粉光晕、选中态渐变竖条、标题渐隐下划线、卡片角的极小装饰点 |

**刻意没做的**（避免变成"太二次元"）：萌系吉祥物、对话框气泡、亮粉/亮青撞色、
大面积渐变背景、拟人化文案、音效。分隔线仍然保留——信息密度高的工具去掉分隔会难读。

**量化判据**（不是凭感觉）：截图统计显示**靛蓝紫系像素 21.81% / 粉系 0.22%**，
点缀仅为主色的 1%。"一点点"是有数字支撑的。

### 0.4.2 修掉「界面在说谎」

这类问题的共同点：**界面在描述一个已经不存在的事实**。
比功能缺失更糟——功能没做用户能看出来，界面说谎会让用户以为坏了。

| 位置 | 问题 | 修法 |
|---|---|---|
| 侧栏导航 | 「浏览器阅卷」标着"未实现"，但 `browser:*`/`picker:*` 通道**早已实现** | 改为"拾取与窗口已可用"；真未实现的仍明确标注 |
| 拾取按钮 | 三个按钮全部 `disabled`，点了只写"Phase 2 未实现"日志 | 接上真实通道；再点同一项 = 取消 |
| 底部状态栏 | 三项拾取状态是**写死的**「未拾取」灰标，无论实际如何都不变 | 订阅 `evt:pick` + 启动读一次，真实反映 |
| 设置页 | 写死「Phase 1 未实现：ai:test 通道尚未接上」 | 接上 `ai:test`，显示真实连接结果 |

### 0.4.3 界面新增能力

- **拾取槽卡片**：三项目标各自显示坐标、标签、选择器，已拾取转绿
- **批阅模式改卡片式单选**：三种模式的风险差异直接写在卡片上，不藏在下拉里；
  顶尖模式带「慎用」角标
- **坐标模式**：Canvas 平台没有 DOM 可拾取，支持手输屏幕坐标
- **`#hash` 深链**：`#settings` 直达某面板，开发与自动化都需要
- **空态设计**：未实现的面板给图标 + 说明 + 待实现清单，而不是空白页
- **异步加载失败可见**：设置读取失败时显示原因，不再永久停在"读取设置中…"

### 0.4.4 界面验证（可重跑）

本机 Electron 启动即崩（§3），但"改了 CSS 却没看过一眼"等于没做。
改用系统自带 Edge（Chromium）无头渲染**同一份渲染层代码**，配合
[preview/preview-api.js](preview/preview-api.js) 这一层假 IPC 让界面能水合。

```bash
pnpm ui:verify     # 打包 → 起服务 → 逐面板截图 → 断言 → 对比度 + 像素统计
```

它检查四件事，每件都对应一类真实翻车：

1. **每个面板的关键元素必须出现** —— React 抛错时页面静默变空白，
   而空白页截图很像"设计很简洁"，肉眼看不出来
2. **水合标志**（`PREVIEW_RENDER_OK`）—— 断言 React 真的挂载成功
3. **反向断言** —— 初始态不该出现"正在拾取"这类瞬时态
4. **对比度** —— 从 `styles.css` 解析设计令牌后算 WCAG 对比度

实测：5 个面板全绿（截图 93~114 KB，DOM 4.7~7.5 KB）；12 项对比度全部达标。

> 待清理：`preview/` 下的截图与 DOM dump 是产物（已在 `.gitignore`），
> 源码（假桥、检查脚本、vite 配置）应入库——它们是"改了 CSS 能验证"的凭据。

### 0.4.5 由界面验证发现并修复的真实缺陷

| 缺陷 | 后果 | 修法 |
|---|---|---|
| 成功色/警告色当文字用在同色淡底上 | 对比度仅 **2.4:1 / 2.1:1**，卡在"能看见但费劲" | 拆出 `--ok-text`/`--warn-text` 等文字专用深色 |
| `--ok`/`--warn` 本身太亮 | 用于边框与图标时仅 2.5:1 / 2.2:1，虚得几乎看不见 | 加深到 `#047857` / `#b45309` |
| 预览桩数据结构写错 | 顶层写 `exportDir`，真实结构是 `general.exportDir` → **设置面板白屏** | 对齐真实 `AppSettings`，并去掉 `as AppSettings` 断言 |
| `settings:save` 契约写完整对象 | 实现收的是 `Partial`，类型对不上、契约在撒谎 | 契约改 `Partial<AppSettings>` |
| `app:info` 契约字段名写 `app` | 实现返回 `version`，两处真源不一致 | `AppInfo` 统一到 `shared` 作唯一真源 |
| Vite `--outDir` 相对 root 解析 | 产物落到 `preview/preview/dist`，服务 404 而构建日志显示成功 | 改用绝对路径的 `preview/vite.config.mjs` |
| `.cmd` 里的中文注释被 cmd.exe 当命令执行 | 脚本静默不干活（截图根本没生成） | 预览检查统一用 Python 实现，删掉 .cmd |
| 验证脚本把"截图不存在"当通过 | 验证器在说谎——明明没截图却报"全部通过" | 截图缺失即判失败 |

---

## 1. 当前阶段与进展

**Phase 0 地基 ✅ · Phase 1 AI ✅ · Phase 2 自动化（纯代码 + 界面）✅ · Phase 3 界面壳 ✅**
**GUI 启动仍受环境限制（见 §3），故窗口行为未在真实 Electron 中验证。**

### 1.1 进展一览

| 项目 | 状态 | 证据 |
|---|---|---|
| 建仓与依赖安装 | ✅ | `pnpm install` 成功 |
| 类型契约冻结 | ✅ | `src/shared/types.ts`，双侧 `tsc` exit=0 |
| main + preload + renderer 装配 | ✅ | `electron-vite build` 三端全过 |
| 配置持久化 | ✅ | `src/main/store.ts`（electron-store） |
| IPC 骨架 | ✅ | **命令通道 29/29，事件通道 6/6，零缺口** |
| 界面 | ✅ | 5 面板全部真实渲染通过（§0.4.4） |
| AI 兼容层 | ✅ | `src/main/ai/compat.ts` + 60 项单测 |
| 抗改版定位 | ✅ | `src/shared/locator.ts` + 45 项单测 |
| 多次运行分歧度 | ✅ | `src/main/ai/ensemble.ts` + 51 项单测 |
| 自动化层纯逻辑 | ✅ | `geometry.ts` 66 项 / `picker.ts` 43 项 |
| **客观题零网络比对** | ✅ | `shared/objective.ts` + 39 项单测 |
| **文件解析** | ✅ | `main/io/parse.ts` + 34 项单测 |
| **导出 Excel / Markdown** | ✅ | `main/io/export.ts` |
| **假桥一致性防漂移** | ✅ | `tests/preview-parity.test.ts` + 8 项（已验证会真红） |
| CDP 与窗口编排 | ⚠ 薄绑定，**未验证** | 依赖真机（见 §3） |
| 单元测试总数 | ✅ | **381 项全过（9 套件）** |
| 评测指标库 | ✅ | 33 项自测 / 流水线 12 项自测 |
| **Electron GUI 启动验证** | ❌ **受环境阻塞** | 见 §3 |

**Phase 4 界面侧、Phase 5~7、评测轨 E2~E4：未开始。**

### 1.2 契约与数据

契约冲突已全部裁定并冻结（[CONTRACT.md](CONTRACT.md) `contract_v1`）：

| 编号 | 裁定 | 哈希 |
|---|---|---|
| C1 | 采纳契约枚举 `选择/判断/填空/简答/计算/论述` | — |
| C2 | `full_score` 条件必填（有标注则必有） | — |
| C3 | 严格 `>` 阈值 + 按题型粒度分层 | 见 `freeze_manifest.json` |

标注数据集已按 §5 完成迁移，校验器报 **0 错误 0 警告**（已标注 1 / 待标注 4）。

### 1.3 抗改版定位（对齐 Playwright 官方优先级）

依据 [Locators | Playwright](https://playwright.dev/dotnet/docs/locators)：
优先**用户可见属性**（role / label / text）与显式契约（testid），CSS 为最后手段。

| 产物 | 状态 | 验证 |
|---|---|---|
| [src/shared/locator.ts](src/shared/locator.ts) | ✅ 候选生成 + 韧性评分 | **45 项单测** |
| [tests/locator.test.ts](tests/locator.test.ts) | ✅ | 排序正确性被钉死 |
| `PickResult.candidates` | ✅ 已接入契约 | 拾取时一并持久化 |

**关键改动**：原实现只生成**一个**选择器，排序错了只能等平台改版才发现。
现改为生成**按韧性排序的候选列表**，运行时从上往下试第一个能唯一命中的——
等于自动获得多级降级能力。**排序正确性从运行时问题变成了纯函数问题。**

评分维度刻意分开：
- `kind` 决定基准分（role 100 > label 92 > testid 88 > placeholder 80 > text 70 > id 60 > attr 50 > css 30）
- `depth` 路径深度每层 −6（仅真实元素传入）

### 1.4 多次运行分歧度（自一致性）

依据 [Towards Reliable LLM Grading Through Self-Consistency and Selective Human Review](https://www.mdpi.com/2504-4990/8/3/74)、
[Confidence Estimation and Calibration in LLMs（综述）](https://arxiv.org/abs/2311.08298)。

| 产物 | 状态 | 验证 |
|---|---|---|
| [src/main/ai/ensemble.ts](src/main/ai/ensemble.ts) | ✅ 统计 + 判定 | **51 项单测** |
| [tests/ensemble.test.ts](tests/ensemble.test.ts) | ✅ | 边界已覆盖 |
| `gradeQuestionMulti()` | ✅ 已接入 client | 不同温度采样 |
| `ai:gradeMulti` 通道 | ✅ 已接入主进程 | 契约对账通过 |

**为什么需要它**：让模型自评 `confidence` 是**弱信号**（普遍过度自信、常吐固定值）。
同一输入独立跑多次，结果散不散才是可观测的不确定性。

**三条设计红线**（都有专门用例）：
1. **只有一次运行绝不能判"一致"** → 返回 `insufficient` 并要求复核。
   「没测过」不等于「测过且通过」，这是最典型的安全误判。
2. **一致 ≠ 正确** → 多次一致但自评置信度低时，警告"多次给出同一个错分比随机波动更危险"。
3. **分歧度必须归一化** → 100 分制题不能因为分值大就被判为不稳定。

**成本控制**：不是所有题都跑多次。正确用法是**先单次、可疑才多次**
（边界分 / 低质量图 / 得分点不自洽），这类约占 20~30%。
多两次 API 调用（几厘钱）vs 人工复核（几分钟），成本差两个数量级。

**最有价值的副产品**：`commonMisses` —— 各次运行**共同未命中**的得分点。
一致地漏掉同一个点不是噪声，是**系统性盲区**，是改提示词/rubric 的直接线索。
单跑一次永远发现不了。

> **标定（可靠性曲线 / ECE）按用户决定暂缓**——它需要实测数据才能算，
> 等数据集到位再补。当前 `0.75` 阈值仍是未经标定的经验值，这一点不掩饰。

### 1.5 评测轨与文档

| 产物 | 状态 | 验证 |
|---|---|---|
| [scripts/eval/metrics.py](scripts/eval/metrics.py) | ✅ | `pnpm metrics:selftest` → 33 项 |
| [scripts/eval/run_eval.py](scripts/eval/run_eval.py) | ✅ | `pnpm eval:selftest` → 12 项 |
| [scripts/freeze.py](scripts/freeze.py) | ✅ | `freeze:verify` 通过 |

[SPEC.md](SPEC.md) 已按 S-1~S-9 重写（v2）：新增 §3 分级验收（客观/主观分开）、
**F6 运行时纪律六条**、§3.6 能力边界声明、§11 修订记录。

### 1.6 由测试发现并修复的真实缺陷（机制层）

| 缺陷 | 后果 | 修法 |
|---|---|---|
| `asNumber('abc')` 返回 **0** | 非数字答案被**静默记为 0 分**（看起来完全正常，最危险） | 要求清洗后必须含数字 + 回归用例 |
| **按钮的可访问名取不到** | `role=button` 拿不到 name → 评分扣 40 → 退化到脆弱的 CSS 路径。**丢掉最有价值的候选** | 可访问名补上自身文本（按钮文本是最稳的定位依据） |
| **`label=` 会退化成 placeholder** | 生成一个**永远匹配不到**的选择器——不报错，只静默失效 | 新增 `labelText()` 只认真正标签 |
| `agreement` 用**绝对分差**判定 | 100 分制题上 60 vs 62 被判 major 分歧（明明只差 2%） | 改为归一化极差 |
| id 哈希惩罚过轻（−25） | 形如 `#a1b2c3d4e5f60718` 的 id 竟比稳定的 class 分还高 | 提到 −40 |
| `cssEscapeIdent` 未定义 | 拾取直接抛异常 | 修正引用 |
| `scoreCandidate` 深度默认扣分 | 不同 kind 之间**分数不可比**，排序正确性无法断言 | 分离「定位方式」与「路径深度」两个维度 |
| `io:parseFile` / `io:exportExcel` / `io:exportMarkdown` 在契约里但**从未实现** | 渲染层调用会运行时炸 | 从契约移除；补上 5 个已实现但未声明的通道 |

## 2. 已验证命令

```powershell
cd C:\Users\admin\Desktop\_agent_workspace\Grading_exam

pnpm typecheck                 # 双 project 类型检查，两侧 exit=0
pnpm build                     # electron-vite 三端构建
pnpm test                      # vitest：300 项全过
pnpm metrics:selftest          # 指标库：33 项全过
pnpm eval:selftest             # 评测流水线：12 项全过
pnpm validate:dataset          # 数据集契约校验
pnpm freeze:show / freeze:verify
pnpm fixtures                  # 起夹具静态服务（127.0.0.1:8000）

# 界面验证（Electron 起不来时的替代路径，见 §0.4）
pnpm ui:verify                 # 打包→起服务→逐面板截图→断言→对比度+像素统计
```

实测结果（本轮末）：`tsc` 双侧 `exit=0`；`electron-vite build` 三端全过；
`vitest` **300 passed**（ensemble 51 / geometry 66 / ai 60 / locator 45 / picker 43 / selector 35）；
`metrics selftest` 33 项；`eval --selftest` 12 项；
数据集校验 **0 错误 0 警告**；IPC 契约对账 **命令通道 26/26，零缺口**；
`ui:verify` **5 个面板全绿 + 12 项对比度达标**。

---

## 3. ⚠️ 本机 Electron 启动阻塞（重要，后续调试必读）

**现象**：`electron.exe --version` 在加 `--no-sandbox` 后正常（exit=0），但任何创建应用运行时的脚本都会在 `app.whenReady()` 触发瞬间崩溃，退出码 `-1073741819`（即 `0xC0000005`，访问违例），无任何 stdout/stderr。

**已排除**：不是项目代码问题。最小复现脚本不建窗口、只 `require('electron')` + `app.whenReady()`，同样崩溃。

**已实测无效的参数组合**（9 组，全部 `0xC0000005`）：

```
--no-sandbox
--no-sandbox --disable-gpu
--no-sandbox --disable-gpu-compositing
--no-sandbox --use-gl=swiftshader
--no-sandbox --disable-features=Vulkan
--no-sandbox --disable-gpu --disable-features=Vulkan,VizDisplayCompositor
--no-sandbox --in-process-gpu
--no-sandbox --single-process
--no-sandbox --disable-gpu --no-zygote
```

**已确定有效的部分**：`--no-sandbox` 是**必需**的（不加就连 `--version` 都崩）。

**两个宿主环境坑**：

| 坑 | 现象 | 处置 |
|---|---|---|
| `NODE_OPTIONS=--require worker-events.cjs`（DSH 注入） | Electron 透传给内部 Node，报 `Cannot find module 'worker-events.cjs'` | 跑 Electron 前清空该变量：`cmd /c "set NODE_OPTIONS=&& electron.exe …"` |
| Chromium 沙箱不可用 | 不加 `--no-sandbox` 直接 `0xC0000005` | 一律带 `--no-sandbox` |

**结论**：本机当前**无法验证 GUI**。这不影响判断代码是否正确（构建与类型检查已全绿），但意味着：
- 无法验证渲染层在真实窗口中的视觉效果与交互；
- 无法验证 `scripts/smoke-main.cjs` 的自检项（桥接、React 渲染、IPC 往返）；
- **无法验证 Phase 2 的窗口级行为**：CDP 附加、跨 frame 坐标换算的实测值、
  `Input.insertText` 对真实受控组件的效果、截图裁剪的实际区域。

**应对方式（本轮已执行）**：把 Phase 2 拆成「纯逻辑」与「薄绑定」两部分。
坐标累加、回读判定、错误分类、幂等提交、像素比换算、frame 路径解析、
结构漂移检测全部抽到 [geometry.ts](src/main/page/geometry.ts) 与
[picker.ts](src/main/page/picker.ts)，由 **105 项单测**覆盖；
[cdp.ts](src/main/page/cdp.ts) 与 [browser.ts](src/main/page/browser.ts)
只保留必要绑定，且在每个推测行为处标了 `⚠ 未验证`，待真机逐条确认。

**建议的排查方向**（按成本排序）：
1. 换一台有正常桌面会话的 Windows 机器跑 `pnpm dev`；
2. 降级 Electron 到 LTS 线（如 `^38`）试，排除 45.0.0 在本机的兼容问题；
3. 检查是否有企业级 Code Integrity / EDR 策略拦截 Electron 的 JIT 或未签名二进制；
4. 用 `electron --enable-logging --v=1` 抓 Chromium 初始化日志（当前连日志都没产出，说明崩在极早期）。

**已备好的验证脚本**：`scripts/smoke-main.cjs`（Golden Path 自检）。
代码正确时，它会输出 6 项 PASS。共享主进程 `pnpm dev` 则在有桌面的机器上直接跑。

**真机首跑检查清单**（Phase 2 专用，来自代码里的 `⚠ 未验证` 标记）：

| # | 待确认事项 | 若不成立的处置 |
|---|---|---|
| 1 | `Page.createIsolatedWorld` 里能否读到页面 DOM | 改为不传 worldName，用主世界上下文 |
| 2 | `Runtime.evaluate` 在主世界能否调到 `__gradingExamViewer.__gradingExamPageStartPick` | 改用 ipcRenderer 到具体 frame 下发 |
| 3 | `captureBeyondViewport: false` 下 `clip` 的坐标语义 | 降级为整页截图后本地裁剪 |
| 4 | 嵌套 iframe 的 `readIframeRect` 取到的偏移是否正确 | 用 `parent-iframe.html` 夹具页逐层对数 |
| 5 | `webContents.debugger.attach` 在已附加时的异常文案 | 已有 `isAttached()` 兜底，确认即可 |

夹具页 [tests/fixtures/](tests/fixtures/) 三个页面正是为此准备的：
`plain-dom.html` 验受控组件填分，`parent-iframe.html` + `child-frame.html`
验跨域坐标累加，`canvas-only.html` 验坐标模式与键盘模拟。

---

## 4. 下一步（按依赖顺序）

### 4.1 仍需人工推进（本机无法替代）

| 优先级 | 任务 | 阻塞对象 |
|---|---|---|
| **P0** | 启动 E2 教师资源协调（3 名教师双评 + 仲裁） | 阻塞 E3/E4，外部依赖最慢 |
| **P0** | 为 1500 道题补 `rubric` 条目（当前仅 1/5 行有） | 阻塞 E3 |
| P1 | 解决 §3 的 Electron 启动阻塞（换机器 / 降版本 / 查 EDR） | 阻塞一切 GUI 验证 |
| P2 | 取得真实阅卷平台账号，做首次真实适配 | 阻塞能力声明（§3.6 禁止未验证表述） |
| P2 | 裁定 `MATH-CALC-0001` 的扣分口径矛盾（争议原文已存 `notes`） | 阻塞该样本进统计 |

### 4.2 下一步可纯代码推进

| 优先级 | 任务 | 说明 | 状态 |
|---|---|---|---|
| ~~P4~~ | ~~单题批改闭环~~ | AI 层 + IPC + 渲染层 | ✅ **已完成**（3 个提交） |
| **P5** | 连续阅卷状态机 `auto:*` | 当前是显式「未实现」桩；`geometry.ts` 已有幂等提交与断点续跑逻辑可复用 | ⬅ 下一步 |
| P5-2 | 客观题零网络断言 | 已有本地比对实现，待补「零网络」的代码级断言 | ⬅ 下一步 |
| P5-3 | 代码级隔离（客观题不走 AI 通道） | 防止后续改动把客观题又接回 AI | ⬅ 下一步 |
| P6 | 整卷阅卷（逐题复用单题闭环） | 评测轨指标已就绪；`PaperReport` + 导出通道已实现 | 待 P5 |
| P7 | 打包（electron-builder） | 导出已就绪，缺 UI 入口与打包配置 | 待 P6 |
| E1 | `rubric_freeze_v1` / `prompt_freeze_v1` | 需 rubric 定稿；当前 `contract_v1` 已冻结 | 依赖人工 |

**P4 具体交付**（本轮）：
- 客观题本地比对 `shared/objective.ts`（39 项单测，零网络零 token）
- 文件解析 `main/io/parse.ts`（34 项单测，失败必可见）
- 导出 `main/io/export.ts`（xlsx / Markdown，纯函数层可测）
- 单题批改界面 `renderer/panels/SinglePanel.tsx`（三张卡，两条评分路径分明）
- 假桥一致性 `tests/preview-parity.test.ts`（9 项，已验真会红）
- IPC 对账 `scripts/check_ipc.py`（含幻影事件检测）

---

## 5. 目录约定（AGENTS.md 规则）

所有文件限定在：

```
C:\Users\admin\Desktop\_agent_workspace\Grading_exam\           ← 产品轨
C:\Users\admin\Desktop\_agent_workspace\Grading_exam_research\ ← 评测轨（调研与数据集）
```

- 不得在 `_agent_workspace` 根目录或 Desktop 下直接创建文件；
- Python 脚本一律以 `PYTHONDONTWRITEBYTECODE=1` 运行，避免在工作区之外生成 `__pycache__`；
- 数据集与答卷原图含个人信息，已在 `.gitignore` 中排除 `data/raw/`、`data/derived/`。

---

## 6. 经验教训（避免后人重犯）

### 6.1 CSV 迁移曾静默丢数据

原始 `标注模板_测试集.csv` **表头 19 列但有 20 个字段**——第 20 列（`待标注`）
没有列名。`csv.DictReader` 会把它塞进 `restkey=None` 并被静默丢弃，
而我第一版迁移脚本用 `csv.DictWriter` 再写出时，直接触发了
`ValueError: dict contains fields not in fieldnames: None`。

**修法**：不掩盖异常，而是把那列**升格为显式 `status` 列**（`待标注`/`已标注`/空），
并在 CONTRACT.md §7 声明为**附加性、不破坏既有结果**的变更；
迁移脚本改为**写出后重新读取并断言字段零丢失**，并从备份恢复了一次。

**教训**：表头列数与数据字段数不一致时，宁可报错也不要"猜测"。
任何迁移脚本都必须自带「读回校验」。

### 6.2 校验器的字段启发式会产生假阳性

校验器曾对 4 行待标注数据报「已开始标注但缺满分」。真正原因是
`score_teacher_a` 列在待标注行里存的是**题目满分占位符**（6/10/8/15，
恰好等于 `full_score`），不是教师打分。

**修法**：一旦存在显式 `status` 列，就**以它为准**，不再用字段启发式猜。
启发式只在无显式状态时兜底。

**教训**：用"字段是否有值"推断状态，会在占位符、默认值、模板残留上翻车。
宁可要求一个显式状态字段。

### 6.3 绝不能为了让校验器变绿而删真实数据

`MATH-CALC-0001` 曾出现 A=5.5 / B=6.0（差 0.5，低于 1.0 阈值）却带着
`score_arbitrated=6` 与一段声称"扣了 0.5"的理由——**理由与结果自相矛盾**。

**处置**：清空仲裁字段，**把争议原文完整保留在 `notes`**，标记待教师裁定。
没有为了让校验通过而删除这条数据。

**教训**：红灯往往指向真实的数据问题。删数据是最快的"修复"，也是唯一不可逆的。

### 6.4 界面说了假话比功能没做更糟

本轮发现四处「界面在说谎」：侧栏标"未实现"但通道早已实现、拾取按钮全 `disabled`、
状态栏的拾取状态是**写死的**、设置页写死"ai:test 未接上"。

**为什么比功能缺失更糟**：功能没做，用户能看出来；界面说谎，用户会以为自己坏了
或操作错了，反而去排查一个不存在的问题。

**检查手法**：改完一个模块后，回头搜界面里所有提到该模块的文字，逐条问
「这句现在还成立吗」。本轮的四处都是这样搜出来的。

### 6.5 验证器本身必须被验证

`verify_ui.py` 曾出现「截图不存在 → 跳过像素检查 → 报全部通过」。
那一刻验证器在说谎，而且说了"全部通过"——比没有验证器更危险。

**规则**：验证器的每个"跳过"都要重新审视。**该有的产物不存在必须判失败**，
不能降级成跳过。同理，`preview/shot-*.png` 曾因为 `.cmd` 中文注释被 cmd.exe
拆成命令而根本没生成，如果当时是跳过逻辑，我就会带着"已验证"的错觉交付。

### 6.6 中文脚本不要写 .cmd

cmd.exe 按 OEM 代码页逐字节解析批处理文件，UTF-8 中文注释会被拆成命令执行
（实测报出 `'打包预览页' is not recognized`），脚本静默不干活。

**处置**：预览检查统一用 Python 实现（可直接指定 UTF-8），删掉那个 .cmd。

### 6.7 工具的默认解析基准要核实，不能想当然

Vite 的 `--outDir` 是相对 **root** 解析的，不是相对当前工作目录。
`vite build preview --outDir preview/dist` 实际写到 `preview/preview/dist/`，
而静态服务在 `preview/dist/` 找不到文件返回 404——**构建日志却显示"成功"**。

**教训**：命令行参数里带相对路径时，先确认解析基准。本项目其他构建命令
（`electron-vite build`）此前一直正常，是因为它的 root 配置恰好让相对路径成立；
换一个 root 就翻车了。已改用带绝对路径的 `preview/vite.config.mjs` 消歧义。