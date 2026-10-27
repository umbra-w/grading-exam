"""反假绿验证：注入真实故障，确认复核/修正的测试真的会红。

每个探针都**同时断言"注入本身生效了"**（AGENTS.md §7.4）——
本轮已经两次栽在"注入静默没生效，于是把假绿当成真绿"上。
"""
import pathlib
import shutil
import subprocess
import sys

sys.stdout.reconfigure(encoding='utf-8')

ROOT = pathlib.Path(__file__).resolve().parent.parent
REVIEW = ROOT / 'src/main/ai/review.ts'
PICKER = ROOT / 'src/main/page/picker.ts'
BAK = ROOT / '_probe_backup.tmp'


def run_tests(only):
    r = subprocess.run(
        ['node', 'node_modules/vitest/vitest.mjs', 'run', only],
        cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace',
    )
    out = (r.stdout or '') + (r.stderr or '')
    red = 'failed' in out and 'Test Files' in out
    return red, out


PROBES = [
    (
        '删掉"待处理条目永不清理"的保护（改成语义等价的宽松过滤）',
        REVIEW,
        "const pending = items.filter((x) => x.status === 'pending');",
        "const pending = items.filter((x) => x.status === 'pending' && false);",
        'tests/review.test.ts',
    ),
    (
        '让 warnings 不再触发复核（只增不减原则被破坏）',
        REVIEW,
        "if (policy.reviewOnWarnings && result.warnings.length > 0) {",
        "if (false && policy.reviewOnWarnings && result.warnings.length > 0) {",
        'tests/review.test.ts',
    ),
    (
        '修正评分点后不重算总分（总分与明细脱节）',
        REVIEW,
        'nextScore = clampScore(rounded, full, warnings);',
        'nextScore = before.score;',
        'tests/review.test.ts',
    ),
    (
        '把缺失分值当成 0 分（制造静默偏低的总分）',
        REVIEW,
        '        const v = table.get(p);\n        if (v === undefined) unknown.push(p);\n        else sum += v;',
        '        const v = table.get(p) ?? 0;\n        sum += v;',
        'tests/review.test.ts',
    ),
]

failures = 0
for name, path, old, new, test_file in PROBES:
    src = path.read_text(encoding='utf-8')
    if old not in src:
        print(f'  ✗ 注入失败（文本未匹配）：{name}')
        failures += 1
        continue

    shutil.copy2(path, BAK)
    try:
        path.write_text(src.replace(old, new, 1), encoding='utf-8')

        # ★ 断言注入本身生效了
        after = path.read_text(encoding='utf-8')
        if after == src:
            print(f'  ✗ 注入未生效（文件未变化）：{name}')
            failures += 1
            continue
        if old in after:
            print(f'  ✗ 注入未生效（旧文本仍在）：{name}')
            failures += 1
            continue

        red, out = run_tests(test_file)
        if red:
            line = [l for l in out.splitlines() if 'Tests ' in l]
            print(f'  ✓ 注入后确实报红：{name}')
            print(f'      {line[0].strip() if line else ""}')
        else:
            print(f'  ✗ 【假绿】注入后测试仍然通过：{name}')
            failures += 1
    finally:
        shutil.copy2(BAK, path)

    # 还原后必须字节一致
    if path.read_text(encoding='utf-8') != src:
        print(f'  ✗ 还原不完整：{name}')
        failures += 1

BAK.unlink(missing_ok=True)
print()
print('  结论:', '全部探针有效' if failures == 0 else f'{failures} 个探针有问题')
sys.exit(1 if failures else 0)