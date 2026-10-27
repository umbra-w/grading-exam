"""校验文档里声称的用例/套件计数是否与真实一致。

★ 为什么需要这个脚本：本轮我在 AGENTS.md、STATUS.md、README.md **各漏了一处**
  过时计数，每次都是"改完一处以为干净了，下一份又冒出来"。
  这不是粗心，是**手工维护派生值必然的结果** —— 文档里的 743/757 是
  vitest 输出的副本，改代码的人不会记得去改三份散文。

  所以：不指望人工同步，而是让"忘了同步"变成一条会红的检查。
  这与 §7.3 的 ipc:check 是同一个思路 —— 契约与实现的对账不能靠自觉。

  ⚠ 本脚本只检查**明确的数字声明**（"757 项"/"22 套件"这类）。
    它不去猜含糊表述（如"数百项"），也不假装能检查非数字的一致性。
"""
import json
import pathlib
import re
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path.cwd()

# ── 1. 拿真实的计数（唯一真源：vitest 自己的报告）
report = ROOT / '_doccount.json'
r = subprocess.run(
    ['node', 'node_modules/vitest/vitest.mjs', 'run', '--reporter=json',
     f'--outputFile={report.name}'],
    capture_output=True, text=True, encoding='utf-8', errors='replace',
)
if r.returncode != 0 or not report.is_file():
    print('  ✗ 无法取得 vitest 报告，不能据此判断文档是否正确')
    print((r.stderr or r.stdout or '')[-400:])
    sys.exit(1)

data = json.loads(report.read_text(encoding='utf-8'))
report.unlink()

real_tests = sum(len(f['assertionResults']) for f in data['testResults'])
real_suites = len(data['testResults'])

if real_tests == 0:
    print('  ✗ 真实用例数为 0 —— 报告解析有问题，不能据此判断')
    sys.exit(1)

print(f'  真实：{real_tests} 项 / {real_suites} 套件')

# ── 2. 扫文档里的数字声明
DOCS = ['README.md', 'STATUS.md', 'AGENTS.md', 'PLAN.md', 'ARCH.md']

# ★ 规则必须收紧，否则会假阳性。
#   第一版用 `(\d{3,})\s*(?:项|passed)` 抓"任何三位数 + 项"，结果把
#   "picker.ts 由 105 项单测覆盖"（模块级数字，本来就对）和
#   "一个'已通过 300 项单测'的状态"（历史背景）当成总计数报错。
#   而**会假阳性的检查比没有更坏** —— 它会逼人去改本来正确的文档，
#   改完还觉得自己在维护一致性。
#   所以只认下面几种**明确的总计数表述**，并且必须整行语义就是总数。
PATTERNS = [
    # "757 项全过" / "757 passed（22 套件）"
    (re.compile(r'(\d{3,})\s*项全过'), '总用例数'),
    (re.compile(r'\*\*(\d{3,})\s*passed\*\*'), '总用例数'),
    (re.compile(r'Tests\s+(\d{3,})\s+passed'), '总用例数'),
    # "✅ 757 项单测覆盖（22 套件）" —— 前面必须紧跟能力表里的 ✅
    (re.compile(r'✅\s*(\d{3,})\s*项单测覆盖'), '总用例数'),
    # "已覆盖 757 项（22 套件）"
    (re.compile(r'已覆盖\s*(\d{3,})\s*项'), '总用例数'),
    # "vitest（已覆盖 757 项）"
    (re.compile(r'vitest（已覆盖\s*(\d{3,})\s*项）'), '总用例数'),
    # "vitest：757 项"
    (re.compile(r'vitest：\s*(\d{3,})\s*项'), '总用例数'),
    # "已通过 757 项单测" —— **但不能匹配被引号括起来的引用**。
    # AGENTS.md 有句「一个"已通过 300 项单测"的状态是花了几十分钟挣来的」，
    # 那里的 300 是历史背景而非当前值；第一版把它判成不一致（假阳性）。
    (re.compile(r'(?<![「"“])已通过\s*(\d{3,})\s*项单测'), '总用例数'),
]
PAT_SUITES = re.compile(r'(\d{1,2})\s*套件')

fail = []
checked = 0
for name in DOCS:
    p = ROOT / name
    if not p.is_file():
        continue
    text = p.read_text(encoding='utf-8')
    for lineno, line in enumerate(text.splitlines(), 1):
        for pat, what in PATTERNS:
            for m in pat.finditer(line):
                checked += 1
                n = int(m.group(1))
                if n != real_tests:
                    fail.append((name, lineno, f'{what} {n}', line.strip()[:90]))
        for m in PAT_SUITES.finditer(line):
            checked += 1
            n = int(m.group(1))
            if n != real_suites:
                fail.append((name, lineno, f'套件数 {n}', line.strip()[:90]))

# ★ 自检：如果一条声明都没匹配到，说明规则写坏了 ——
#   那时"没有不一致"是"什么都没检查"，两者长得一模一样（§6.5）。
if checked == 0:
    print('  ✗ 一条总计数声明都没匹配到 —— 规则可能已失效，不能据此判断')
    sys.exit(2)

print(f'  检查了 {checked} 处总计数声明')
print()
if fail:
    print(f'  ✗ {len(fail)} 处文档计数与真实不一致（真实 {real_tests} 项 / {real_suites} 套件）：')
    for name, lineno, what, ctx in fail:
        print(f'    · {name}:{lineno}  {what}')
        print(f'        {ctx}')
    sys.exit(1)

print(f'  ✓ 文档计数与真实一致（{real_tests} 项 / {real_suites} 套件）')