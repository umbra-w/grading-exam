"""证明 check_package.py 真的会红 —— 且是**点名原因地**红。

一个刚修好的校验器尤其需要这一步：它上一版因为匹配逻辑错而报了一堆假
"缺失"，现在改成通过之后，怎么知道它是真通过而不是又错了一次？

三个注入，每个针对一类真实翻车：
  ① 删掉 out/main/index.js      → 必须报"缺少应用文件"（真发生=启动即崩）
  ② 加进 src/main/main.ts       → 必须报"混入编译前源码"（真发生=泄露源码）
  ③ 加进 preview/dom-paper.html → 必须报"混入 preview"（真发生=把假 IPC 桥发给用户）

实现：解包真实 app.asar → 改动 → 重打包 → 指向临时包跑校验器。原产物不动。

★ 上一版这个探针自己写错了：它假设 cwd 是仓库根，但实际 cwd 是上级目录，
  于是它在错的位置找 app.asar 并报"缺少"。如果我信了那个输出，
  就会去"修"一个完全正常的校验器 —— 与 §7.4 里那条教训同形。
  所以这里开头就把解析出的路径打印出来，让基准问题一眼可见。

前置：先跑 `electron-builder --dir` 生成 release/win-unpacked。
"""
import pathlib
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

CWD = pathlib.Path.cwd()
REAL = CWD / 'release/win-unpacked/resources/app.asar'
CHECKER = CWD / 'scripts/check_package.py'
TMP = CWD / '_pkgprobe'

cli_candidates = list(CWD.glob('node_modules/.pnpm/@electron+asar@*/node_modules/@electron/asar/bin/asar.js'))
CLI = cli_candidates[0] if cli_candidates else None

print(f'  cwd       = {CWD}')
print(f'  app.asar  = {REAL.relative_to(CWD) if REAL.is_file() else "(不存在) " + str(REAL)}')
print(f'  asar CLI  = {CLI.relative_to(CWD) if CLI else "(未找到)"}')
print(f'  checker   = {CHECKER.relative_to(CWD) if CHECKER.is_file() else "(不存在)"}')

for label, ok in [('app.asar', REAL.is_file()), ('asar CLI', bool(CLI)),
                  ('check_package.py', CHECKER.is_file())]:
    if not ok:
        print(f'  ✗ 前置条件不满足：{label}')
        sys.exit(1)
print()


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True,
                          encoding='utf-8', errors='replace')


def check(asar_path: pathlib.Path):
    """用临时包跑校验器：复制其源码并把 ASAR 路径替换掉。"""
    src = CHECKER.read_text(encoding='utf-8')
    old = "ASAR = ROOT / 'release/win-unpacked/resources/app.asar'"
    assert old in src, '路径锚点不存在 —— 探针无效'
    patched = src.replace(old, f"ASAR = pathlib.Path(r'{asar_path}')", 1)
    assert patched != src, '替换未生效 —— 探针无效'   # ★ 断言注入真的生效了
    tmp_py = TMP / 'check_tmp.py'
    tmp_py.write_text(patched, encoding='utf-8')
    return run([sys.executable, str(tmp_py)])


if TMP.exists():
    shutil.rmtree(TMP)
TMP.mkdir(parents=True)

extracted = TMP / 'app'
r = run(['node', str(CLI), 'extract', str(REAL), str(extracted)])
if r.returncode != 0:
    print(f'  ✗ 解包失败：{(r.stderr or r.stdout)[:200]}')
    sys.exit(1)
print(f'  解包 → {extracted.relative_to(CWD)}')


def repack(name):
    out = TMP / name
    r2 = run(['node', str(CLI), 'pack', str(extracted), str(out)])
    if r2.returncode != 0:
        print(f'  ✗ 打包 {name} 失败：{(r2.stderr or r2.stdout)[:200]}')
        sys.exit(1)
    return out


def report(tag, res, keyword):
    hits = [l.strip() for l in (res.stdout or '').splitlines() if keyword in l]
    print(f'  {tag}  exit={res.returncode}（应非 0）')
    for l in hits:
        print(f'      {l}')
    return bool(hits)


# ── 基线：未改动的重打包必须通过
r_base = check(repack('base.asar'))
print(f'  基线（未改动的重打包）exit={r_base.returncode}（应为 0）')
if r_base.returncode != 0:
    print('  ✗ 基线就红了 —— 重打包本身有问题，注入实验无意义')
    print((r_base.stdout or '')[-800:])
    sys.exit(1)

results = []

main_entry = extracted / 'out/main/index.js'
saved = main_entry.read_bytes()
main_entry.unlink()
results.append(('①缺 main 入口', report('① 删掉 out/main/index.js',
                                        check(repack('missing.asar')), '缺少应用文件')))
main_entry.write_bytes(saved)

(src_dir := extracted / 'src/main').mkdir(parents=True, exist_ok=True)
(src_dir / 'main.ts').write_text('// injected', encoding='utf-8')
results.append(('②混入源码', report('② 混入 src/main/main.ts',
                                    check(repack('src.asar')), '编译前源码')))
shutil.rmtree(extracted / 'src')

(prev := extracted / 'preview').mkdir(parents=True, exist_ok=True)
(prev / 'dom-paper.html').write_text('<html></html>', encoding='utf-8')
results.append(('③混入 preview', report('③ 混入 preview/dom-paper.html',
                                        check(repack('preview.asar')), '混入')))
shutil.rmtree(prev)

shutil.rmtree(TMP, ignore_errors=True)

ok = [n for n, passed in results if passed]
print()
if len(ok) < 3:
    print(f'  ✗ 只有 {len(ok)}/3 个注入被点名拒绝（{ok}）—— 校验器不够具体')
    sys.exit(1)
print(f'  ✓ 3/3 个注入都被点名拒绝：{"、".join(ok)}')
print(f'  原产物未被改动：{REAL.is_file()}')