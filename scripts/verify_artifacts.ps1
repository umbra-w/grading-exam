# 校验打包产物（便携版 exe / 免安装 zip）。
#
# 用户明确要求：**不要安装程序，直接双击 exe 就能用。**
# 所以这个脚本除了验证产物本身，还要**反向断言"不应存在安装包"** ——
# 否则哪天有人把 nsis 加回 target，产物里多出 Setup.exe 而没人发现。
#
# 为什么做成脚本而不是写完就算：产品名/版权/图标/artifactName 都是从配置
# **派生**出来的，改一处就可能静默丢掉一个 —— 例如漏掉 win.icon 会静默回落成
# Electron 默认图标（打包照样成功、日志照样干净）。所以每次重新打包都该跑一遍。
#
# ⚠ 本脚本只验证**产物文件**。它不能证明：
#     · 双击 exe 真的能启动（本机 Electron 起不来，见 BLOCKERS.md B3）
#     · 便携版的数据真的落在 exe 旁边（那条链路由 scripts/check_portable_path.ts
#       单独验证：它跑真实环境变量下的决策逻辑）
#   不要因为这里全绿就以为"已验证可用"。
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$rel = Join-Path $root 'release'
$iconPath = Join-Path $root 'build\icon.ico'

if (-not (Test-Path $rel)) {
    # exit 3 = 不适用（同 check_package.py）。产物不入库，新机器上必然找不到。
    Write-Host '  - 不适用：release/ 不存在'
    Write-Host '    （需要时跑 `pnpm dist`；打包产物不入库）'
    exit 3
}
if (-not (Test-Path $iconPath)) {
    Write-Host '  FAIL 缺少 build/icon.ico（先跑 pnpm icon）'
    exit 1
}

$portable = Get-ChildItem $rel -Filter '*便携版*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
$zip = Get-ChildItem $rel -Filter '*.zip' -ErrorAction SilentlyContinue | Select-Object -First 1
$unpacked = Join-Path $rel 'win-unpacked\Grading_exam.exe'

if (-not $portable -and -not $zip) {
    Write-Host '  - 不适用：release/ 下没有便携版 exe 或 zip'
    Write-Host '    （需要时跑 `pnpm dist`）'
    exit 3
}

$allFail = @()

# ── 0. ★ 反向断言：用户不要安装程序，产物里就不该有安装包
$setups = @(Get-ChildItem $rel -Recurse -File -Filter '*Setup*' -ErrorAction SilentlyContinue)
if ($setups.Count -gt 0) {
    $names = ($setups | ForEach-Object { $_.Name }) -join ', '
    $allFail += "产物里出现了安装程序，但用户要求不要安装程序：$names"
    Write-Host "  FAIL 发现 $($setups.Count) 个安装包："
    $setups | ForEach-Object { Write-Host "    · $($_.Name)" }
}

# ── 图标字节指纹：从 icon.ico 取 256×256 那张 PNG 的头 200 字节
$iconBytes = [System.IO.File]::ReadAllBytes($iconPath)
$pngStart = -1
for ($i = 0; $i -lt $iconBytes.Length - 8; $i++) {
    if ($iconBytes[$i] -eq 0x89 -and $iconBytes[$i + 1] -eq 0x50 -and
        $iconBytes[$i + 2] -eq 0x4E -and $iconBytes[$i + 3] -eq 0x47) { $pngStart = $i; break }
}
if ($pngStart -lt 0) { $allFail += 'build/icon.ico 里没有 PNG 数据（图标格式异常）' }

function Test-IconEmbedded([string]$file) {
    if ($pngStart -lt 0) { return $false }
    $finger = $iconBytes[$pngStart..($pngStart + 200)]
    $b = [System.IO.File]::ReadAllBytes($file)
    for ($i = 0; $i -lt $b.Length - $finger.Length; $i++) {
        if ($b[$i] -eq $finger[0] -and $b[$i + 8] -eq $finger[8] -and $b[$i + 100] -eq $finger[100]) {
            $ok = $true
            for ($j = 0; $j -lt 60; $j++) { if ($b[$i + $j] -ne $finger[$j]) { $ok = $false; break } }
            if ($ok) { return $true }
        }
    }
    return $false
}

function Check-Exe([string]$exe, [string]$label) {
    $fail = @()
    Write-Host ''
    Write-Host "  === $label ==="
    $fi = Get-Item $exe
    Write-Host "  文件        $($fi.Name)"
    Write-Host "  体积        $([math]::Round($fi.Length / 1MB, 2)) MB"
    $v = $fi.VersionInfo
    Write-Host "  产品名      $($v.ProductName)"
    Write-Host "  版权        $($v.LegalCopyright)"
    if ($v.ProductName -ne 'Grading_exam') { $fail += "产品名是 '$($v.ProductName)'，期望 'Grading_exam'" }
    if ([string]::IsNullOrWhiteSpace($v.LegalCopyright)) { $fail += '版权信息为空' }
    # 太小说明 Electron 运行库/资源没打进去
    if ($fi.Length -lt 60MB) { $fail += "体积只有 $([math]::Round($fi.Length / 1MB, 2)) MB，资源可能没打进去" }
    if (Test-IconEmbedded $exe) { Write-Host '  图标        OK 已嵌入（字节级比对通过）' }
    else { $fail += '没找到我们的图标数据 —— win.icon 可能没生效' }
    $sig = Get-AuthenticodeSignature $exe
    Write-Host "  签名        $($sig.Status)"
    if ($sig.Status -ne 'Valid') {
        Write-Host '              ⚠ 未签名：Windows SmartScreen 会提示"未知发布者"'
        Write-Host '              （开源项目常见，但发布时应告知用户）'
    }
    # ★ 返回**单个字符串**而不是数组：调用处用 `+=` 接数组会生成嵌套数组，
    #   最后打印成 `System.Object[]` —— 校验失败却看不到原因。
    return ($fail -join '；')
}

if ($portable) {
    $r = Check-Exe $portable.FullName '单文件便携版（双击即用）'
    if ($r) { $allFail += $r }
}

if ($unpacked -and (Test-Path $unpacked)) {
    $r = Check-Exe $unpacked '解压目录版（zip 里的主 exe）'
    if ($r) { $allFail += $r }
} elseif ($zip) {
    # zip 存在但没解压目录：至少确认 zip 里含主 exe，避免"包是空的但看着通过"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $z = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $zip).Path)
    $hasMain = $z.Entries | Where-Object { $_.FullName -match 'Grading_exam\.exe$' }
    $count = $z.Entries.Count
    $z.Dispose()
    Write-Host ''
    Write-Host '  === 免安装 zip ==='
    Write-Host "  文件        $($zip.Name)"
    Write-Host "  体积        $([math]::Round($zip.Length / 1MB, 2)) MB"
    Write-Host "  条目        $count"
    if (-not $hasMain) { $allFail += 'zip 里没有 Grading_exam.exe' }
    else { Write-Host '  主程序      OK 含 Grading_exam.exe' }
    if ($count -lt 50) { $allFail += "zip 只有 $count 个条目，Electron 运行库可能没打进去" }
}

Write-Host ''
if ($allFail.Count) {
    Write-Host '  FAIL 产物校验未通过：'
    $allFail | ForEach-Object { Write-Host "    · $_" }
    exit 1
}
Write-Host '  OK 产物校验通过（无安装程序；注意：双击启动仍需真机验证）'