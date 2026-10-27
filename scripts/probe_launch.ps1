# 实测 exe 的启动行为（第二版）。
#
# ★ 第一版的缺陷：我用 `$p.HasExited` 判断"是否存活"，于是
#   **单文件便携版被判成"已退出"** —— 而 portable 的启动器逻辑是
#   "解压 → ExecWait 子进程 → 自己退出"（见 portable.nsi:86-90），
#   所以父进程退出是**正常的**，真正的应用在子进程里。我把正常当成崩溃了。
#   同时 `$p.ExitCode` 读出来是空，因为 Start-Process -PassThru 的进程对象
#   在重定向输出时不一定能拿到 ExitCode。
#
# 这一版改按**进程 + 窗口**来判断，这也是用户视角的"打开了吗"：
#   ① 启动前记录同名进程
#   ② 启动后等一段时间，看有没有**新出现**的同名进程
#   ③ 新进程有没有 MainWindowTitle（有标题 = 窗口真的建出来了）
$ErrorActionPreference = 'Continue'

function Probe-Exe([string]$exe, [string]$label) {
    Write-Host ''
    Write-Host "=== $label ==="
    if (-not (Test-Path $exe)) { Write-Host "  文件不存在：$exe"; return }
    $fi = Get-Item $exe
    Write-Host "  路径   $($fi.FullName)"

    $before = @(Get-Process -Name 'Grading_exam' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $out = Join-Path $env:TEMP 'ge_out.txt'
    $err = Join-Path $env:TEMP 'ge_err.txt'
    Remove-Item $out, $err -Force -ErrorAction SilentlyContinue

    $sw = [Diagnostics.Stopwatch]::StartNew()
    Start-Process -FilePath $exe -WorkingDirectory $fi.DirectoryName `
        -RedirectStandardOutput $out -RedirectStandardError $err -ErrorAction SilentlyContinue | Out-Null

    # portable 要解压 100+MB，给足时间
    $new = @()
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        $new = @(Get-Process -Name 'Grading_exam' -ErrorAction SilentlyContinue |
            Where-Object { $before -notcontains $_.Id })
        if ($new.Count -gt 0 -and ($new | Where-Object { $_.MainWindowHandle -ne 0 })) { break }
    }
    $sw.Stop()
    Write-Host "  观察 $([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒后："

    if ($new.Count -eq 0) {
        Write-Host '  ✗ 没有任何 Grading_exam 进程存活 —— 应用没起来'
    } else {
        Write-Host "  进程数 $($new.Count)"
        foreach ($pr in $new) {
            $title = $pr.MainWindowTitle
            $hwnd = $pr.MainWindowHandle
            Write-Host "    PID=$($pr.Id)  内存=$([math]::Round($pr.WorkingSet64/1MB,1))MB  窗口句柄=$hwnd  标题='$title'"
        }
        $withWin = @($new | Where-Object { $_.MainWindowHandle -ne 0 })
        if ($withWin.Count -gt 0) {
            Write-Host '  ✓ 有可见窗口 —— exe 能打开'
        } else {
            Write-Host '  △ 进程活着但没有窗口 —— 启动到中途卡住/窗口未创建'
        }
    }

    foreach ($f in @($out, $err)) {
        if (Test-Path $f) {
            $c = Get-Content $f -Raw -ErrorAction SilentlyContinue
            if ($c -and $c.Trim()) {
                Write-Host "  --- $(Split-Path $f -Leaf) ---"
                $c.Trim() -split "`n" | Select-Object -First 25 | ForEach-Object { Write-Host "    $_" }
            }
        }
    }

    # 清理
    foreach ($pr in $new) { taskkill /PID $pr.Id /T /F 2>&1 | Out-Null }
    Write-Host '  （已清理进程）'
}

Probe-Exe 'release\win-unpacked\Grading_exam.exe' '① 解压目录版（最接近"直接跑应用"）'
Probe-Exe 'release\Grading_exam-0.1.0-便携版.exe' '② 单文件便携版'