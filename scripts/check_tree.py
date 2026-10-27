"""结构树前缀自洽性校验（可复用的一次性工具）。

规则两条，缺一不可：
  1. 同一父节点下，`└─` 只能出现在最后一个直接子节点上。
  2. 标了 `└─` 的条目**不能再有子节点** —— 树的竖线已经断了，
     后面的子节点会画在"父节点已经结束"的位置上。

前两版校验器都写错了，值得记下来，因为**错的校验器会让人去改正确的文档**：
  · 第一版 `last_at` 从不重置 → 同深度出现两项就必然误报
  · 第二版用 `entries.index(...)` 定位自身 → 重复条目命中错索引
  · 第三版漏了规则 2 → 把 `│  └─ io/` 后面紧跟的 `parse.ts`（其实是
    io/ 的**子节点**）算成了"同级，所以 io/ 不该是最后一个"

★ 这正说明 §6.5 的那条：验证器必须先验证自己。
  如果我当时直接"按校验器输出去改文档"，就会把正确的树改坏。
"""
import pathlib
import re
import sys

sys.stdout.reconfigure(encoding='utf-8')

p = pathlib.Path('AGENTS.md')
lines = p.read_text(encoding='utf-8').split('\n')

a = next(i for i, l in enumerate(lines) if l.strip() == 'src/')
b = next(i for i, l in enumerate(lines) if l.strip() == '```' and i > a)
tree = lines[a:b]

# depth = 前导槽位里"竖线"的个数（`│`）；分支符号本身不占深度
entries: list[tuple[int, str, str]] = []
for l in tree:
    m = re.match(r'^((?:(?:│| )  )*)([├└])─ (.*)$', l)
    if not m:
        if l.strip() and l.strip() != 'src/':
            print(f'  ! 无前缀行：{l!r}')
        continue
    depth = m.group(1).count('│')
    entries.append((depth, m.group(2), m.group(3).strip()[:50]))

bad = 0
for i, (depth, mark, name) in enumerate(entries):
    if mark != '└':
        continue
    nxt = entries[i + 1] if i + 1 < len(entries) else None

    # 规则 1：后面还有同深度的条目 → 它不是最后一个
    if nxt is not None and nxt[0] == depth:
        print(f'  ✗ 深度{depth} {name!r}：标为最后一个，后面还有同级 {nxt[2]!r}')
        bad += 1
    # 规则 2：后面还有更深的条目 → 它是父节点，不该标最后一个
    if nxt is not None and nxt[0] > depth:
        print(f'  ✗ 深度{depth} {name!r}：标为最后一个，却还有子节点 {nxt[2]!r}')
        bad += 1

if bad:
    print(f'\n  ✗ {bad} 处前缀不自洽')
    sys.exit(1)

print('  ✓ 结构树前缀自洽')
by_depth: dict[int, int] = {}
for d, _, _ in entries:
    by_depth[d] = by_depth.get(d, 0) + 1
print('    ' + '  '.join(f'深度{d}:{c}项' for d, c in sorted(by_depth.items())))