"""校验生产包是否完整。

★ 这个脚本的前两版都是**假阳性**，值得记下来：
  ① 手工解析 asar 二进制头，偏移算错 → 读出 LICENSE 的内容当 JSON
     更糟的是：脚本报错时我的 `$_ -match` 过滤结果为空，
     于是打印出"✓ 无 preview/tests 混入" —— 报错被读成了通过。
  ② 用 `'/'` 拼路径过滤 → 实测 asar 清单用的是 `\\`（Windows 分隔符），
     于是每个依赖都"缺失"。

**结论：验证脚本必须断言自己的输入形态**（条目数非零、格式符合预期），
否则"没找到"和"没检查"长得一模一样 —— 这正是 AGENTS §6.5/§6.6 的坑。

改用 @electron/asar 官方 CLI 拿清单（不自己解析二进制），
并且断言：清单非空、路径分隔符符合预期、关键文件确实在其中。
"""
import json
import pathlib
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASAR = ROOT / 'release/win-unpacked/resources/app.asar'
CLI = ROOT / 'node_modules/.pnpm/@electron+asar@3.4.1/node_modules/@electron/asar/bin/asar.js'

if not ASAR.exists():
    # exit 3 = 不适用。打包产物不入库，新机器上这里必然找不到 ——
    # 报失败会让每个协作者看到一条"去跑打包"才能消掉的假红灯，
    # 久而久之这条检查就被跳过了（§7.3：被跳过的检查等于不存在）。
    print(f'  − 不适用：未找到 {ASAR}')
    print('    （打包产物不入库；需要时跑 `pnpm dist` 或 `electron-builder --dir`）')
    sys.exit(3)

r = subprocess.run(
    [sys.executable.replace('python.exe', 'node.exe') if False else 'node', str(CLI), 'list', str(ASAR)],
    capture_output=True, text=True, encoding='utf-8', errors='replace',
)
if r.returncode != 0:
    print(f'  ✗ asar list 失败：{r.stderr[:200]}')
    sys.exit(1)

lines = [l for l in (r.stdout or '').splitlines() if l.strip()]

# ★ 断言输入形态：不能是空的，也不能是错误输出
if len(lines) < 100:
    print(f'  ✗ 清单只有 {len(lines)} 条 —— 解析很可能失败了，不能据此下结论')
    sys.exit(1)
sep = '\\' if any('\\' in l for l in lines[:50]) else '/'
print(f'  清单 {len(lines)} 条，分隔符 {sep!r}')

def norm(p: str) -> str:
    """规范化路径：统一分隔符并去掉**两端**的斜杠。

    ★ 这里我错了三次，每次都是同一个形状 —— 只处理了一端的斜杠：
      ① 用 `'/'` 拼路径，而清单用 `\\` → 所有依赖都"缺失"
      ② 修成分隔符后仍用 `rstrip`，而清单条目带**前导** `\\`（`\\out\\main\\index.js`）
         → 所有应用文件都"缺失"
    三次都是靠"脚本自己说不通"（依赖不可能全缺、文件不可能全缺）才发现的。
    所以这里改成两端都去，并且下面显式验证 `norm()` 真的能对上已知存在的项。
    """
    return p.replace('/', sep).strip(sep)


def has(path: str) -> bool:
    return any(norm(l) == norm(path) for l in lines)


# ★ 验证器自检：拿一个**必然存在**的条目确认 norm()/has() 是通的。
#   如果这里失败，说明匹配逻辑有问题，那么后面所有"缺失"都不可信 ——
#   必须在报缺失之前就先报这个。
if not has('package.json'):
    print('  ✗ 校验器自检失败：连 package.json 都匹配不到，')
    print('    说明路径规范化有 bug，此时任何"缺失"结论都不可信。')
    print(f'    样例条目：{lines[0]!r}')
    sys.exit(2)


def count(sub: str) -> int:
    """统计含某子串的条目数。

    ★ 必须先把 sub 也规范化成清单用的分隔符！
      这里原来写的是 `sub.lower() in l.lower()`，而清单是 `\\out\\...`、
      我传进来的是 `'preview/'` —— 于是**永远匹配不到**，
      「排除项」检查从头到尾都在报一个假的 ✓（"无 preview/tests 混入"）。
      是 scripts/probe_package.py 注入 preview/ 后校验器**仍绿**才暴露的：
      一个"排除检查从不生效"的校验器，比没有校验器更危险 ——
      它会在真的把假 IPC 桥打进生产包时告诉你一切正常。
    """
    needle = norm(sub).lower()
    return sum(1 for l in lines if needle in norm(l).lower())

fail = []

# ── 1. 必须存在：应用自身代码
#      preload 必须是 .cjs：打包后的 package.json 带 "type": "module"，
#      名为 .js 的 CJS 产物会被 Node 当 ESM 解析，抛 require is not defined
#      → window.gradingExam 不存在 → 渲染层白屏（2026-10-26 实测的真因）
for f in ['out/main/index.js', 'out/preload/index.cjs', 'out/preload/viewer.cjs',
          'out/renderer/index.html', 'package.json']:
    if not has(f):
        fail.append(f'缺少应用文件 {f}')
print('  应用文件：' + ('✓ 齐全' if not fail else '见下'))

# ── 2. 必须存在：主进程外部依赖（这三个是 runtime require，不被 Vite 打包）
#      electron-store 走 electron-vite 的 external，exceljs/mammoth/pdf-parse 在 io 层动态加载
for dep in ['electron-store', 'exceljs', 'mammoth', 'pdf-parse']:
    n = count(dep)
    if n == 0:
        fail.append(f'缺少运行时依赖 {dep}')
    print(f'  {dep:<16}{"✓ " + str(n) + " 条" if n else "✗ 缺失"}')

# ── 3. 渲染层依赖应被打进 bundle（Vite 处理），不依赖 node_modules 存在
#      但 bundle 里必须真的含它们 —— 用文件大小间接确认，避免"看起来装上了"
bundle = sorted((ROOT / 'out/renderer/assets').glob('index-*.js'))
if not bundle:
    fail.append('缺少渲染层 bundle')
else:
    size = bundle[0].stat().st_size
    print(f'  渲染层 bundle   {size // 1024} KB（含 React/Zustand）')
    if size < 200_000:
        fail.append(f'渲染层 bundle 只有 {size} 字节 —— React 可能没打进去')

# ── 4. 绝不能进入生产包的东西
for bad in ['preview/', 'tests/', 'scripts/', '.map']:
    n = count(bad)
    if n:
        fail.append(f'生产包混入了 {bad}（{n} 条）')
print('  排除项：' + ('✓ 无 preview/tests/scripts/sourcemap' if not any(
    count(b) for b in ['preview/', 'tests/', 'scripts/']) else '见下'))

# ── 5. 源码不得裸进包（out/ 是编译产物，src/ 才是源码）
n_src = count('src/main/') + count('src/renderer/')
if n_src:
    fail.append(f'生产包混入了编译前源码 src/（{n_src} 条）')

print()
if fail:
    print('  ✗ 生产包校验未通过：')
    for f in fail:
        print(f'    · {f}')
    sys.exit(1)
print('  ✓ 生产包校验通过')