"""
界面渲染验证 —— 一条命令跑完：截图 + DOM 断言 + 对比度 + 像素统计。

为什么统一到 Python 而不是留一个 .cmd 启动器：
  cmd.exe 按 OEM 代码页逐字节解析批处理文件，UTF-8 的中文注释会被
  拆成命令执行（实测报出 `'打包预览页' is not recognized`），
  导致脚本静默不干活。Python 可直接指定 UTF-8，这个问题不存在。
  另一个好处：断言与检查在同一处，不会出现"截图失败但仍报通过"。

设计原则（踩过的坑）：
  · **截图不存在必须判失败**，而不是跳过。之前 verify 只检查颜色就把
    "截图没生成"当成通过，等于验证器在说谎。
  · **每个面板都断言关键元素**。React 抛错时页面静默变空白，
    而空白页的截图看起来很像"设计很简洁"。
  · 假数据必须与真实类型结构一致（preview-api.js 曾因 exportDir 位置
    写错导致设置面板白屏），所以这里也检查水合标志。

用法：
    python verify_ui.py                 # 只做配色与对比度检查（不需要浏览器）
    python verify_ui.py --render        # 完整流程：打包→起服务→截图→断言
"""

from __future__ import annotations

import re
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zlib
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CSS = ROOT / "src" / "renderer" / "styles.css"
DIST = HERE / "dist"
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}/index.html"

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

# 每个面板「渲染成功」的证据。缺任意一项即判失败。
PANEL_EXPECT: dict[str, list[str]] = {
    "browser": ["阅卷平台", "元素拾取", "评分标准", "批阅模式与运行", "pick-slot", "mode-card"],
    "single": ["智能阅卷", "待实现清单", "empty-state", "Phase 4"],
    "paper": ["整卷阅卷", "待实现清单", "empty-state", "Phase 5"],
    "analysis": ["学情分析", "待实现清单", "empty-state", "Phase 6"],
    "settings": ["设置", "供应商", "导出目录", "自动"],
}

# 初始渲染时**不该**出现的瞬时态（例如"正在等待拾取"）。
# 反向断言同样重要：只查"该有的在"会漏掉"不该有的也在"。
PANEL_FORBID: dict[str, list[str]] = {
    "browser": ["picking"],
    "single": [],
    "paper": [],
    "analysis": [],
    "settings": [],
}


# ---------------------------------------------------------------- 颜色工具

def parse_css_vars(text: str) -> dict[str, str]:
    block = re.search(r":root\s*\{(.*?)\}", text, re.S)
    if not block:
        raise SystemExit("未在 styles.css 找到 :root 变量块")
    return {n: v.strip() for n, v in re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", block.group(1))}


def to_rgb(value: str) -> tuple[int, int, int]:
    v = value.strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{3})", v)
    if m:
        return tuple(int(c * 2, 16) for c in m.group(1))  # type: ignore[return-value]
    m = re.fullmatch(r"#([0-9a-fA-F]{6})", v)
    if m:
        h = m.group(1)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    raise ValueError(f"无法解析颜色: {value!r}")


def luminance(rgb: tuple[int, int, int]) -> float:
    def chan(c: int) -> float:
        s = c / 255
        return s / 12.92 if s <= 0.03928 else ((s + 0.055) / 1.055) ** 2.4

    r, g, b = (chan(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(fg: tuple[int, int, int], bg: tuple[int, int, int]) -> float:
    l1, l2 = luminance(fg), luminance(bg)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


# ------------------------------------------------------------------ PNG 解码

def decode_png(path: Path) -> tuple[int, int, list[tuple[int, int, int]]]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是 PNG")

    pos, width, height, idat = 8, 0, 0, bytearray()
    bit_depth = color_type = 0
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if ctype == b"IHDR":
            width = struct.unpack(">I", body[0:4])[0]
            height = struct.unpack(">I", body[4:8])[0]
            bit_depth, color_type = body[8], body[9]
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break
        pos += 12 + length

    if bit_depth != 8 or color_type not in (2, 6):
        raise ValueError(f"不支持的 PNG 格式 depth={bit_depth} colorType={color_type}")

    channels = 4 if color_type == 6 else 3
    stride = width * channels
    raw = zlib.decompress(bytes(idat))
    pixels: list[tuple[int, int, int]] = []
    prev = bytearray(stride)

    offset = 0
    for _ in range(height):
        ftype = raw[offset]
        offset += 1
        line = bytearray(raw[offset : offset + stride])
        offset += stride
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            if ftype == 1:
                line[i] = (line[i] + a) & 0xFF
            elif ftype == 2:
                line[i] = (line[i] + b) & 0xFF
            elif ftype == 3:
                line[i] = (line[i] + (a + b) // 2) & 0xFF
            elif ftype == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        prev = line
        for x in range(0, stride, channels):
            pixels.append((line[x], line[x + 1], line[x + 2]))

    return width, height, pixels


def hue_of(rgb: tuple[int, int, int]) -> float:
    r, g, b = (c / 255 for c in rgb)
    mx, mn = max(r, g, b), min(r, g, b)
    d = mx - mn
    if d == 0:
        return 0.0
    if mx == r:
        h = ((g - b) / d) % 6
    elif mx == g:
        h = (b - r) / d + 2
    else:
        h = (r - g) / d + 4
    return h * 60


# ---------------------------------------------------------------- 检查项

def check_contrast(v: dict[str, str]) -> list[str]:
    problems: list[str] = []
    pairs = [
        ("正文 / 页面底", "--text", "--bg", 4.5),
        ("正文 / 卡片底", "--text", "--panel", 4.5),
        ("次要文字 / 卡片底", "--text-mid", "--panel", 4.5),
        ("弱化文字 / 卡片底", "--text-dim", "--panel", 3.0),
        ("主色文字 / 主色淡底", "--accent-deep", "--accent-soft", 4.5),
        # 一律用 *-text：亮色(--ok/--warn)是给边框与图标用的，
        # 当文字色放在同色淡底上必然对比不足（实测 2.4:1 / 2.1:1）。
        ("粉色徽标 / 粉色淡底", "--sakura-text", "--sakura-soft", 4.5),
        ("成功文字 / 成功淡底", "--ok-text", "--ok-soft", 4.5),
        ("警告文字 / 警告淡底", "--warn-text", "--warn-soft", 4.5),
        ("错误文字 / 错误淡底", "--err-text", "--err-soft", 4.5),
        ("成功主色 / 卡片底", "--ok", "--panel", 3.0),
        ("警告主色 / 卡片底", "--warn", "--panel", 3.0),
        ("错误主色 / 卡片底", "--err", "--panel", 3.0),
    ]
    print("── 对比度（WCAG）")
    for label, fg_k, bg_k, floor in pairs:
        ratio = contrast(to_rgb(v[fg_k]), to_rgb(v[bg_k]))
        ok = ratio >= floor
        print(f"  {'✓' if ok else '✗'} {label:<18} {ratio:5.2f}:1  (要求 ≥ {floor})")
        if not ok:
            problems.append(f"{label} 对比度 {ratio:.2f} 低于 {floor}")
    return problems


def check_palette(v: dict[str, str]) -> list[str]:
    problems: list[str] = []
    print("\n── 主色取向（风格取向的核心，值得卡住）")
    accent, sakura = to_rgb(v["--accent"]), to_rgb(v["--sakura"])
    a_hue, s_hue = hue_of(accent), hue_of(sakura)
    print(f"  主色 --accent = {v['--accent']}  色相 {a_hue:.0f}°")
    print(f"  点缀 --sakura = {v['--sakura']}  色相 {s_hue:.0f}°")

    if 220 <= a_hue <= 265:
        print("  ✓ 主色落在靛蓝偏紫区间 220~265°")
    else:
        problems.append(f"主色色相 {a_hue:.0f}° 不在靛蓝偏紫区间 220~265")

    if 300 <= s_hue <= 345:
        print("  ✓ 点缀色落在粉系区间 300~345°")
    else:
        problems.append(f"点缀色色相 {s_hue:.0f}° 不在粉系区间 300~345")

    if luminance(sakura) > luminance(accent) * 0.98:
        print("  ! 点缀亮度接近或超过主色，注意不要喧宾夺主")
    else:
        print("  ✓ 点缀比主色收敛（主色仍占主导）")
    return problems


def check_screenshot(path: Path) -> list[str]:
    problems: list[str] = []
    print(f"\n── 截图统计（{path.name}）")
    try:
        w, h, pixels = decode_png(path)
    except Exception as exc:  # noqa: BLE001
        return [f"截图解码失败：{exc}"]

    total = len(pixels)
    print(f"  尺寸 {w}×{h}，共 {total} 像素")

    ratio = sum(1 for p in pixels if min(p) < 240) / total
    print(f"  非白像素占比 {ratio:.1%}")
    if ratio < 0.02:
        problems.append(f"非白像素仅 {ratio:.1%}，页面疑似空白")
    elif ratio > 0.9:
        print("  ! 几乎全页都有内容，检查是否缺少留白")
    else:
        print("  ✓ 页面有内容且留有空白")

    accent_like = sakura_like = 0
    for r, g, b in pixels:
        mx, mn = max(r, g, b), min(r, g, b)
        if mx == 0 or (mx - mn) / mx < 0.12:
            continue
        hue = hue_of((r, g, b))
        if 215 <= hue <= 270:
            accent_like += 1
        elif 300 <= hue <= 350:
            sakura_like += 1

    print(f"  靛蓝紫系像素 {accent_like} ({accent_like / total:.2%})")
    print(f"  粉系像素     {sakura_like} ({sakura_like / total:.2%})")
    if accent_like == 0:
        problems.append("画面中找不到靛蓝紫系像素，主色可能没生效")
    else:
        print("  ✓ 主色确实渲染到了画面上")

    # 「简洁 + 一点点二次元」的量化判据：点缀必须远少于主色
    if accent_like and sakura_like / accent_like > 0.5:
        problems.append(
            f"粉系像素是主色的 {sakura_like / accent_like:.0%}，超过 50%："
            f"点缀过量，与「一点点二次元」的取向不符"
        )
    elif accent_like:
        print(f"  ✓ 点缀占比为主色的 {sakura_like / accent_like:.0%}（收敛）")
    return problems


# ------------------------------------------------------------ 浏览器渲染

def find_browser() -> str | None:
    for c in EDGE_CANDIDATES:
        if Path(c).exists():
            return c
    return None


def free_port(preferred: int = PORT) -> int:
    """挑一个可用端口。端口被占时必须换，否则会连上前一个残留服务——
    那个服务可能指向旧的 dist，于是"验证通过"验证的是上一版界面。"""
    import socket

    for candidate in range(preferred, preferred + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", candidate))
                return candidate
            except OSError:
                continue
    raise RuntimeError(f"{preferred}~{preferred + 20} 内无可用端口")


def run_render(browser: str) -> list[str]:
    """打包 → 起服务 → 逐面板截图与 DOM 断言。返回问题列表。"""
    problems: list[str] = []
    print("\n── 渲染验证")

    # 1) 打包预览页。**必须走 --config**：`--outDir` 是相对 Vite 的 root 解析的，
#    命令行传 `--outDir preview/dist` 会落到 preview/preview/dist，
#    然后静态服务 404 —— 而构建日志显示成功，极易误判。
    r = subprocess.run(
        ["node", str(ROOT / "node_modules" / "vite" / "bin" / "vite.js"),
         "build", "--config", str(HERE / "vite.config.mjs")],
        cwd=ROOT, capture_output=True, text=True, shell=False,
    )
    if r.returncode != 0:
        return [f"预览打包失败：{(r.stderr or r.stdout).strip()[-300:]}"]
    if not (DIST / "index.html").exists():
        return [f"打包完成但 {DIST / 'index.html'} 不存在，输出路径配置有误"]
    print("  ✓ 预览页打包完成")

    # 2) 起静态服务。必须走 HTTP —— file:// 下 ES module 会被 CORS 拦掉，
    #    页面只会剩一个空壳（实测 DOM 仅 568 字节）。
    port = free_port()
    base = f"http://127.0.0.1:{port}/index.html"
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1",
         "--directory", str(DIST)],
        cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        for _ in range(30):
            try:
                with urllib.request.urlopen(base, timeout=1) as resp:
                    if resp.status == 200:
                        break
            except Exception:  # noqa: BLE001
                time.sleep(0.3)
        else:
            return ["静态服务未能在 9 秒内就绪"]

        print(f"  ✓ 静态服务就绪 {base}")

        flags = ["--headless=new", "--disable-gpu", "--no-sandbox",
                 "--hide-scrollbars", "--force-device-scale-factor=1",
                 "--window-size=1280,860", "--virtual-time-budget=5000"]

        for page, expect in PANEL_EXPECT.items():
            url = f"{base}#{page}"
            shot = HERE / f"shot-{page}.png"

            subprocess.run([browser, *flags, f"--screenshot={shot}", url],
                           capture_output=True, timeout=90)
            dom_run = subprocess.run([browser, *flags, "--dump-dom", url],
                                     capture_output=True, timeout=90)
            dom = dom_run.stdout.decode("utf-8", errors="replace")
            (HERE / f"dom-{page}.html").write_text(dom, encoding="utf-8")

            missing: list[str] = []

            # ① 截图必须真的生成 —— 之前"截图不存在却跳过"让验证说谎
            if not shot.exists() or shot.stat().st_size < 5000:
                missing.append(f"截图缺失或过小({shot.stat().st_size if shot.exists() else 0}B)")

            # ② 水合标志：React 抛错时会是 FAIL
            if "PREVIEW_RENDER_OK" not in dom:
                missing.append("未水合(React 可能抛错)")

            # ③ 该面板的关键元素
            missing += [k for k in expect if k not in dom]

            # ④ 反向断言：初始态不该有的瞬时类
            missing += [f"多余:{k}" for k in PANEL_FORBID.get(page, []) if k in dom]

            if missing:
                problems.append(f"{page} 面板：{'; '.join(missing)}")
                print(f"  ✗ {page:<9} {'; '.join(missing)}")
            else:
                print(f"  ✓ {page:<9} 截图 {shot.stat().st_size / 1024:6.1f} KB  "
                      f"DOM {len(dom.encode()) / 1024:5.1f} KB  关键元素齐备")
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server.kill()

    return problems


def main() -> int:
    v = parse_css_vars(CSS.read_text(encoding="utf-8"))
    print(f"从 {CSS.name} 读到 {len(v)} 个设计令牌")

    problems = check_contrast(v) + check_palette(v)

    if "--render" in sys.argv:
        browser = find_browser()
        if not browser:
            problems.append("未找到 Chromium 系浏览器（Edge/Chrome），无法渲染验证")
        else:
            print(f"\n使用浏览器：{browser}")
            problems += run_render(browser)
            shot = HERE / "shot-browser.png"
            if shot.exists():
                problems += check_screenshot(shot)
    else:
        shot = HERE / "shot-browser.png"
        if shot.exists():
            problems += check_screenshot(shot)
        else:
            print("\n（未加 --render，跳过渲染与像素统计）")

    print("\n" + "=" * 62)
    if problems:
        print(f"发现 {len(problems)} 个问题：")
        for p in problems:
            print(f"  · {p}")
        return 1
    print("全部检查通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())