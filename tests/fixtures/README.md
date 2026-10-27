# 回归夹具页（tests/fixtures/）

对应 PLAN v2.0 §7 与 [BLOCKERS.md](../BLOCKERS.md) 的 B3/B4。

## 为什么需要它

真实阅卷平台随时改版，且我们尚未取得平台账号。这三个静态页面复现三种平台形态，
构成**唯一稳定的回归基线**：

1. 不做任何网络请求，离线可跑；
2. 结构固定，平台改版不影响它；
3. **普通 HTML，浏览器直接打开即可验证**——不需要 Electron（这对绕过 B3 环境阻塞很重要）。

## 三个页面

| 文件 | 形态 | 主要验证 |
|---|---|---|
| `plain-dom.html` | 同源、真实 `<input>`，React 风格受控组件 | 元素拾取；`Input.insertText` 能驱动受控组件 |
| `parent-iframe.html` + `child-frame.html` | 父页内嵌 iframe | 跨域/同源 iframe 内拾取；frame 偏移累加 |
| `canvas-only.html` | 仅有 `<canvas>`，无真实输入框 | 坐标拾取 + 键盘模拟（降级路径） |

## 关键说明：两个方法的取名含义

页面里的 `readScoreValue()` / `submitScore()` 的**名字刻意区分了两种读取方式**：

- `readScoreValue()`：读 `el.value`（**真实 DOM 值**）。
  React 受控组件即使值已显示在屏幕上，其 DOM `value` 也可能与组件状态不同步。
- `readReactState()`：读 `React` 内部状态（只存在框架层里）。

**判别方法**：
- 若 `readScoreValue()` 返回正确分数 → DOM 与状态同步 → 可能是非受控输入框。
- 若 `readScoreValue()` 为空但屏幕上有值 → 受控组件的典型表现。

这一列两栏是 P2-5（`Input.insertText`）能否通过的关键判据：
**必须两栏一致才算真通过。**

## 跨域说明：怎么真正造出跨域

浏览器把 `localhost:8000` 与 `127.0.0.1:8000` 视为**不同源**（host 字符串不同）。
两个都用会得到同源；一个用 `localhost`、一个用 `127.0.0.1` 即可得到跨域。

`child-frame.html` 里的注释也写了这一点。

## 建议启动方式

```powershell
# 在 tests/fixtures/ 目录下起一个静态服务
cd tests\fixtures
python -m http.server 8000
```

然后：

| 场景 | 访问地址 |
|---|---|
| 普通 DOM | `http://localhost:8000/plain-dom.html` |
| 同源 iframe | `http://localhost:8000/parent-iframe.html` |
| **跨域 iframe** | `http://127.0.0.1:8000/parent-iframe.html`（父页在 `127.0.0.1`，子页保持 `localhost`） |
| Canvas | `http://localhost:8000/canvas-only.html` |

> 若用 `file://` 直接打开，浏览器会把所有本地文件视为 opaque origin，
> 跨域行为与真实平台不一致，**不推荐**用于 iframe 场景。

## 与 E3 的关系

按 [PLAN.md](../PLAN.md) v2.0 §3 E3，平台自动化的**首次回归**在这三个页面上做；
取得真实平台账号后再补真实平台验证。在只有夹具页的情况下，能力声明只能是
「已验证 3 个静态页」，**不得写「支持主流阅卷平台」**（调研 §4.2 明令禁止）。