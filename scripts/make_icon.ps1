# 生成应用图标（build/icon.png 256×256 + build/icon.ico 多尺寸）。
#
# 为什么写脚本而不是随便找张图：图标必须与界面的设计令牌**同源**，
# 否则改配色时图标会变成唯一没跟着改的地方。颜色直接取自 styles.css：
#   --accent       #6366f1   靛蓝偏紫
#   --accent-deep  #4f46e5
#   --sakura       #f472b6   樱花粉（点缀，占比要小 —— 界面约束是"一点点"）
#
# 图形：圆角方块 + 一支笔触构成的勾。勾是"批改"最直接的符号，
# 且不需要文字，在任何尺寸下都认得出。
#
# ⚠ 本脚本依赖 Windows 的 System.Drawing（PowerShell 内 Add-Type）。
#    生成的是二进制产物，提交前应确认尺寸与配色符合预期。
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$buildDir = Join-Path $root 'build'
New-Item -ItemType Directory -Force -Path $buildDir | Out-Null

$accent     = [System.Drawing.ColorTranslator]::FromHtml('#6366f1')
$accentDeep = [System.Drawing.ColorTranslator]::FromHtml('#4f46e5')
$sakura     = [System.Drawing.ColorTranslator]::FromHtml('#f472b6')
$white      = [System.Drawing.Color]::White

function New-IconBitmap([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = [double]$size
    # ── 圆角方块底色（留 4% 边距，避免贴边被系统裁切）
    $pad    = $s * 0.04
    $box    = $s - 2 * $pad
    $radius = $s * 0.22
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc($pad,          $pad,          $d, $d, 180, 90)
    $path.AddArc($pad + $box - $d, $pad,        $d, $d, 270, 90)
    $path.AddArc($pad + $box - $d, $pad + $box - $d, $d, $d, 0, 90)
    $path.AddArc($pad,          $pad + $box - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.PointF(0, 0)),
        (New-Object System.Drawing.PointF($s, $s)),
        $accent, $accentDeep)
    $g.FillPath($brush, $path)

    # ── 勾：两段粗线，圆头圆角
    $pen = New-Object System.Drawing.Pen($white, ($s * 0.115))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap   = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawLines($pen, @(
        (New-Object System.Drawing.PointF(($s * 0.28), ($s * 0.53))),
        (New-Object System.Drawing.PointF(($s * 0.44), ($s * 0.69))),
        (New-Object System.Drawing.PointF(($s * 0.73), ($s * 0.33)))
    ))

    # ── 樱花粉小点（点缀，面积刻意很小）
    # 半径 0.04 而不是 0.085：0.085 实测占 2.21%，而界面本身的樱花粉只占
    # 0.22% —— 图标里这个点缀会显得比界面"更二次元"，与"一点点"的约束不符。
    # 图标面积小，视觉权重又比界面高，所以这里取与界面同一量级。
    $dotBrush = New-Object System.Drawing.SolidBrush($sakura)
    $dotR = $s * 0.04
    $g.FillEllipse($dotBrush, ($s * 0.72), ($s * 0.70), $dotR * 2, $dotR * 2)

    $dotBrush.Dispose(); $pen.Dispose(); $brush.Dispose(); $path.Dispose(); $g.Dispose()
    return $bmp
}

# ── PNG（256×256，electron-builder 在 Linux/macOS 与部分场景用这个）
$png = New-IconBitmap 256
$pngPath = Join-Path $buildDir 'icon.png'
$png.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$png.Dispose()
Write-Host ("  ✓ {0}" -f $pngPath)

# ── ICO：把多个尺寸塞进一个文件。
#    System.Drawing 不能直接存多尺寸 ICO，所以手工组装 ICO 容器：
#    6 字节头 + 每张 16 字节目录项 + 各尺寸 PNG 数据（PNG-in-ICO 是 Vista+ 标准，
#    Windows 10/11 与 electron-builder 都支持）。
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$blobs = @()
foreach ($sz in $sizes) {
    $b = New-IconBitmap $sz
    $ms = New-Object System.IO.MemoryStream
    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $blobs += , @{ size = $sz; bytes = $ms.ToArray() }
    $ms.Dispose(); $b.Dispose()
}

$icoPath = Join-Path $buildDir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)                 # reserved
$bw.Write([UInt16]1)                 # type = icon
$bw.Write([UInt16]$blobs.Count)      # count
$offset = 6 + 16 * $blobs.Count
foreach ($bl in $blobs) {
    $dim = if ($bl.size -ge 256) { 0 } else { $bl.size }   # 256 记作 0
    $bw.Write([Byte]$dim); $bw.Write([Byte]$dim)
    $bw.Write([Byte]0); $bw.Write([Byte]0)                  # 调色板数 / 保留
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)             # 色彩平面 / 位深
    $bw.Write([UInt32]$bl.bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $bl.bytes.Length
}
foreach ($bl in $blobs) { $bw.Write($bl.bytes) }
$bw.Flush(); $bw.Dispose(); $fs.Dispose()
Write-Host ("  ✓ {0}  ({1} 个尺寸: {2})" -f $icoPath, $blobs.Count, ($sizes -join '/'))