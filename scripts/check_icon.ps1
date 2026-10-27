# 用像素统计验证图标真的画对了。
#
# 模型不能看图像，所以"看起来不错"不是证据。这里检查四件可量化的事：
#   1. 圆角处必须透明（否则是实心方块，视觉上就是个方块）
#   2. 主体色必须落在设计令牌的靛蓝紫区间，而不是别的颜色
#   3. 白色勾必须存在且粗细合理（画错了会变成一条线或一坨）
#   4. 樱花粉是点缀：占比必须远小于主体色（界面约束是"一点点二次元"）
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$p = Join-Path (Split-Path -Parent $PSScriptRoot) 'build\icon.png'
$bmp = [System.Drawing.Bitmap]::FromFile($p)
$w = $bmp.Width; $h = $bmp.Height
Write-Host "  尺寸 ${w}×${h}"

$total = $w * $h
$transparent = 0; $indigo = 0; $whitePx = 0; $pink = 0; $other = 0

for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
        $c = $bmp.GetPixel($x, $y)
        if ($c.A -lt 16) { $transparent++; continue }
        $r = [int]$c.R; $g = [int]$c.G; $b = [int]$c.B
        # 靛蓝紫：蓝分量明显高于绿，且整体偏深
        if ($b - $g -gt 60 -and $b -gt 150 -and $r -lt 160) { $indigo++ }
        elseif ($r -gt 225 -and $g -gt 225 -and $b -gt 225) { $whitePx++ }
        # 樱花粉：#f472b6 → r 高、g 低、b 中高
        elseif ($r -gt 200 -and $g -lt 160 -and $b -gt 140) { $pink++ }
        else { $other++ }
    }
}
$bmp.Dispose()

function Share([int]$n) { return [math]::Round(100.0 * $n / $total, 2) }

Write-Host ("  透明        {0,7} px  {1,6}%" -f $transparent, (Share $transparent))
Write-Host ("  靛蓝紫主体  {0,7} px  {1,6}%" -f $indigo, (Share $indigo))
Write-Host ("  白色勾      {0,7} px  {1,6}%" -f $whitePx, (Share $whitePx))
Write-Host ("  樱花粉点缀  {0,7} px  {1,6}%" -f $pink, (Share $pink))
Write-Host ("  其它(过渡)  {0,7} px  {1,6}%" -f $other, (Share $other))

$fail = @()
# 1. 圆角：四角必须透明，但中心必须不透明
$bmp2 = [System.Drawing.Bitmap]::FromFile($p)
$cornerA = @(
    $bmp2.GetPixel(0, 0).A, $bmp2.GetPixel($w - 1, 0).A,
    $bmp2.GetPixel(0, $h - 1).A, $bmp2.GetPixel($w - 1, $h - 1).A
)
$centerA = $bmp2.GetPixel([int]($w / 2), [int]($h / 2)).A
$bmp2.Dispose()
if ($cornerA | Where-Object { $_ -gt 8 }) { $fail += "四角不透明（应是圆角）" }
if ($centerA -lt 200) { $fail += "中心透明（图形没画上）" }
Write-Host ("  四角 alpha: {0}  中心 alpha: {1}" -f ($cornerA -join ','), $centerA)

# 2. 主体色必须是靛蓝紫，不能是别的色系
if ((Share $indigo) -lt 40) { $fail += "靛蓝紫占比过低（" + (Share $indigo) + "%）—— 主色画错了？" }
# 3. 勾必须存在，且不是一根细线/一整块
$whiteShare = Share $whitePx
if ($whiteShare -lt 2) { $fail += "白色勾几乎没有（$whiteShare%）" }
if ($whiteShare -gt 12) { $fail += "白色过多（$whiteShare%）—— 勾画粗了或涂满了" }
# 4. 樱花粉必须是点缀
$pinkShare = Share $pink
# 阈值与界面口径对齐（界面实测 0.22%）。太宽的阈值等于没有约束。
if ($pinkShare -lt 0.05) { $fail += "樱花粉缺失（$pinkShare%）" }
if ($pinkShare -gt 1.0) { $fail += "樱花粉过多（$pinkShare%）—— 界面上只有 0.22%，图标不该更重" }

if ($fail.Count) {
    Write-Host "`n  ✗ 图标检查未通过："
    $fail | ForEach-Object { Write-Host "    · $_" }
    exit 1
}
Write-Host "`n  ✓ 图标通过：圆角透明、主色正确、勾清晰、粉是点缀"
exit 0