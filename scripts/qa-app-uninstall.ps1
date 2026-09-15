param(
    [string[]]$InstallDir,
    [string[]]$TestRoot = @('D:\AutoLabelQA'),
    [switch]$KeepShortcuts
)
$ErrorActionPreference = 'Stop'

# 目的：安装类验收（QA）结束后必须把测试安装从本机清干净，否则会在桌面/开始菜单留下
# 用户不知来源的快捷方式，并在 HKCU 留下卸载登记项。本脚本是该收尾动作的唯一实现，
# 验收脚本与人工清理都走这里，避免各处各写一份删除逻辑。
#
# 安全边界：默认只处理位于 $TestRoot 之下的安装目录（即"测试安装位置"）。
# 用户正式安装的目录不会被误删——要处理它必须显式传 -InstallDir。

$appName = '自动标注小助手'
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) "$appName.lnk"
$startLink = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$appName.lnk"
$uninstallKeyRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)

function Get-AppUninstallRecord {
    $records = @()
    foreach ($keyRoot in $uninstallKeyRoots) {
        foreach ($key in @(Get-ChildItem $keyRoot -ErrorAction SilentlyContinue)) {
            $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
            if ($props -and $props.DisplayName -eq $appName) {
                $records += [PSCustomObject]@{
                    KeyPath         = $key.PSPath
                    UninstallString = $props.UninstallString
                    InstallLocation = $props.InstallLocation
                }
            }
        }
    }
    return $records
}

function Resolve-InstallDirFromRecord($record) {
    if ($record.InstallLocation -and (Test-Path -LiteralPath $record.InstallLocation)) {
        return $record.InstallLocation
    }
    # NSIS 常不写 InstallLocation，此时从 UninstallString 反推（形如 "D:\...\Uninstall X.exe" /currentuser）。
    if ($record.UninstallString) {
        $exe = ($record.UninstallString -replace '^\s*"', '' -replace '".*$', '').Trim()
        if ($exe) { return (Split-Path $exe -Parent) }
    }
    return $null
}

function Test-IsTestInstall([string]$dir) {
    if (-not $dir) { return $false }
    $full = [IO.Path]::GetFullPath($dir)
    foreach ($root in $TestRoot) {
        if (-not $root) { continue }
        $prefix = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
        if ($full.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    }
    return $false
}

function Uninstall-TestInstall([string]$dir) {
    $uninstaller = Get-ChildItem -LiteralPath $dir -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $uninstaller) {
        Write-Output "  未找到卸载器，改为直接结束进程并删除目录。"
    } else {
        # 卸载器会锁定自身所在目录的文件，先结束该目录内的进程。
        $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })
        if ($running.Count -gt 0) {
            Write-Output "  结束占用进程 $($running.Count) 个：$($running.Id -join ', ')"
            $running | Stop-Process -Force
            Start-Sleep -Seconds 2
        }
        Write-Output "  执行静默卸载：$($uninstaller.Name)"
        # /currentuser 与安装登记项的 UninstallString 保持一致，避免触发提权弹窗。
        Start-Process -FilePath $uninstaller.FullName -ArgumentList @('/S', '/currentuser') | Out-Null
        # NSIS 卸载器会把自身复制到临时目录再运行，父进程随即退出，因此不能等退出码，
        # 只能轮询安装目录是否消失。
        $deadline = (Get-Date).AddSeconds(180)
        while ((Get-Date) -lt $deadline -and (Test-Path -LiteralPath $dir)) {
            Start-Sleep -Milliseconds 500
        }
    }
    # 兜底：卸载器残留（缺卸载器、被中途打断）时直接删除目录。
    if (Test-Path -LiteralPath $dir) {
        $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($dir, [StringComparison]::OrdinalIgnoreCase) })
        if ($running.Count -gt 0) { $running | Stop-Process -Force; Start-Sleep -Seconds 2 }
        Remove-Item -LiteralPath $dir -Recurse -Force
    }
}

function Remove-ShortcutLeftovers([string[]]$ownedDirs) {
    foreach ($link in @($desktopLink, $startLink)) {
        if (-not (Test-Path -LiteralPath $link)) { continue }
        # 不依赖 COM（沙箱会拦截 WScript.Shell 实例化）：.lnk 内的路径以 UTF-16 明文存储，直接读字节流比对。
        $text = [Text.Encoding]::Unicode.GetString([IO.File]::ReadAllBytes($link)).ToLowerInvariant()
        $owned = $false
        foreach ($dir in $ownedDirs) {
            if ($dir -and $text.Contains($dir.ToLowerInvariant())) { $owned = $true; break }
        }
        # 只删指向本次已卸载安装的快捷方式；指向其他（正式）安装的必须保留。
        if ($owned) {
            Remove-Item -LiteralPath $link -Force
            Write-Output "  已删除快捷方式：$link"
        } else {
            Write-Output "  跳过快捷方式（指向的是非本次卸载的安装）：$link"
        }
    }
}

# --- 1. 发现目标 ---
$targets = @()
foreach ($dir in @($InstallDir)) {
    if ($dir) { $targets += [PSCustomObject]@{ Dir = $dir } }
}
foreach ($record in @(Get-AppUninstallRecord)) {
    $dir = Resolve-InstallDirFromRecord $record
    if ($dir) { $targets += [PSCustomObject]@{ Dir = $dir } }
}
# 兜底发现：登记项丢失但程序目录仍在的孤儿安装（扫描测试根目录的一层子目录）。
foreach ($root in $TestRoot) {
    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
    foreach ($child in @(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
        if (Test-Path -LiteralPath (Join-Path $child.FullName "$appName.exe")) { $targets += [PSCustomObject]@{ Dir = $child.FullName } }
    }
}

$targets = @($targets | Where-Object { $_.Dir } | Select-Object -ExpandProperty Dir -Unique)
if ($targets.Count -eq 0) {
    Write-Output '未发现本机上的安装记录，仅检查快捷方式残留。'
}

# --- 2. 卸载 ---
$processed = @()
foreach ($dir in $targets) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    if (-not (Test-IsTestInstall $dir)) {
        Write-Output "跳过非测试位置安装：$dir（如需处理请显式传 -InstallDir）"
        continue
    }
    Write-Output "卸载测试安装：$dir"
    Uninstall-TestInstall $dir
    $processed += $dir
    Write-Output "  安装目录已移除：$(-not (Test-Path -LiteralPath $dir))"
}

# --- 3. 清理快捷方式与注册表残留 ---
if (-not $KeepShortcuts) { Remove-ShortcutLeftovers $processed }
foreach ($record in @(Get-AppUninstallRecord)) {
    $dir = Resolve-InstallDirFromRecord $record
    # 只清「本次确实处理过」或「安装目录已不存在」的登记项；指向非测试位置且仍然存在的正式安装
    # 必须保留登记项，否则会破坏用户将来对该安装的正常卸载。
    $isOrphan = (-not $dir) -or (-not (Test-Path -LiteralPath $dir))
    if ($isOrphan -or ($dir -and ($processed -contains $dir))) {
        Remove-Item -LiteralPath $record.KeyPath -Recurse -Force
        Write-Output "  已删除卸载登记项：$($record.KeyPath)"
    }
}

# --- 4. 收尾核验 ---
$remaining = @($processed | Where-Object { Test-Path -LiteralPath $_ })
Write-Output ''
Write-Output "安装目录残留：$(if ($remaining.Count -eq 0) { '无' } else { $remaining -join ', ' })"
Write-Output "桌面快捷方式残留：$(if (Test-Path -LiteralPath $desktopLink) { $desktopLink } else { '无' })"
Write-Output "开始菜单快捷方式残留：$(if (Test-Path -LiteralPath $startLink) { $startLink } else { '无' })"
Write-Output "卸载登记项残留：$(if (@(Get-AppUninstallRecord).Count -eq 0) { '无' } else { '仍有' })"
Write-Output '提示：用户数据（应用数据目录 D:\AutoLabelQA\migrated 下的项目库）不在清理范围内。'
