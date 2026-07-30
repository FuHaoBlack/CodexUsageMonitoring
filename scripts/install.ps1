[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$SourceRoot = (Join-Path $PSScriptRoot '..')
)

$ErrorActionPreference = 'Stop'

function Normalize-Path([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-ExactChildPath([string]$Parent, [string]$Leaf, [string]$Label) {
    if ([string]::IsNullOrWhiteSpace($Parent)) {
        throw "$Label 的父目录为空，已停止。"
    }

    $resolvedParent = Normalize-Path $Parent
    $candidate = [IO.Path]::GetFullPath((Join-Path $resolvedParent $Leaf))
    if ([IO.Path]::GetFileName($candidate) -cne $Leaf -or
        (Normalize-Path ([IO.Path]::GetDirectoryName($candidate))) -cne $resolvedParent) {
        throw "$Label 不是预期父目录下的精确目标，已停止。"
    }
    return $candidate
}

function Get-CodexIconPath {
    $package = Get-AppxPackage -Name OpenAI.Codex -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($null -eq $package -or [string]::IsNullOrWhiteSpace($package.InstallLocation)) {
        throw '未找到官方 Codex AppX 安装信息，无法创建带官方图标的快捷方式。'
    }

    $icon = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation 'app\Codex.exe'))
    if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) {
        throw '未找到官方 Codex AppX 的 app\Codex.exe，无法创建带官方图标的快捷方式。'
    }
    return $icon
}

$sourceRootPath = Normalize-Path $SourceRoot
$sourceSrcRoot = Get-ExactChildPath $sourceRootPath 'src' '源目录 src'
$sourceScriptsRoot = Get-ExactChildPath $sourceRootPath 'scripts' '源目录 scripts'
$sourceDirectories = @($sourceSrcRoot, $sourceScriptsRoot)
foreach ($sourceDirectory in $sourceDirectories) {
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
        throw "缺少必需源目录：$sourceDirectory"
    }
}

$sourceLauncher = Get-ExactChildPath $sourceSrcRoot 'launcher.mjs' '源启动模块'
$sourceStartScript = Get-ExactChildPath $sourceScriptsRoot 'start.ps1' '源启动脚本'
foreach ($sourceFile in @($sourceLauncher, $sourceStartScript)) {
    if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
        throw "缺少必需源文件：$sourceFile"
    }
}

$sourceFiles = @()
foreach ($sourceDirectory in $sourceDirectories) {
    $sourceFiles += @(Get-ChildItem -LiteralPath $sourceDirectory -Recurse -File)
}
if ($sourceFiles.Count -eq 0) {
    throw '没有可安装的源文件，已停止。'
}

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$appData = [Environment]::GetFolderPath('ApplicationData')
if ([string]::IsNullOrWhiteSpace($localAppData) -or [string]::IsNullOrWhiteSpace($appData)) {
    throw '无法解析当前用户的 LocalAppData 或 AppData，已停止。'
}

$installRoot = Get-ExactChildPath $localAppData 'CodexUsageToolbar' '安装目录'
$temporaryRoot = Get-ExactChildPath $localAppData ("CodexUsageToolbar.install-$([guid]::NewGuid().ToString('N'))") '临时安装目录'
$microsoftRoot = Get-ExactChildPath $appData 'Microsoft' '开始菜单 Microsoft 目录'
$windowsRoot = Get-ExactChildPath $microsoftRoot 'Windows' '开始菜单 Windows 目录'
$startMenuRoot = Get-ExactChildPath $windowsRoot 'Start Menu' '开始菜单目录'
$programsRoot = Get-ExactChildPath $startMenuRoot 'Programs' '开始菜单 Programs 目录'
$shortcutPath = Get-ExactChildPath $programsRoot 'Codex（用量显示）.lnk' '开始菜单快捷方式'

if ($WhatIfPreference) {
    [void]$PSCmdlet.ShouldProcess($temporaryRoot, '复制并验证临时安装目录')
    [void]$PSCmdlet.ShouldProcess($installRoot, '替换当前用户的 CodexUsageToolbar 安装目录')
    [void]$PSCmdlet.ShouldProcess($shortcutPath, '创建 Codex（用量显示）开始菜单快捷方式')
    return
}

$iconPath = Get-CodexIconPath
$powerShellTarget = 'C:\Program Files\PowerShell\7\pwsh.exe'
if (-not (Test-Path -LiteralPath $powerShellTarget -PathType Leaf)) {
    throw '未找到固定的 PowerShell 7 启动程序，无法创建快捷方式。'
}
if (-not (Test-Path -LiteralPath $programsRoot -PathType Container)) {
    throw '未找到当前用户开始菜单 Programs 目录，已停止安装。'
}

$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$backupRoot = $null
$backupShortcutPath = $null
$installedNewRoot = $false
$shortcutCreateAttempted = $false
$committed = $false

try {
    if (-not $PSCmdlet.ShouldProcess($temporaryRoot, '复制并验证临时安装目录')) { return }
    [IO.Directory]::CreateDirectory($temporaryRoot) | Out-Null
    foreach ($sourceDirectory in $sourceDirectories) {
        Copy-Item -LiteralPath $sourceDirectory -Destination $temporaryRoot -Recurse -Force
    }
    foreach ($sourceFile in $sourceFiles) {
        $relativePath = $sourceFile.FullName.Substring($sourceRootPath.Length).TrimStart('\', '/')
        $installedFile = [IO.Path]::GetFullPath((Join-Path $temporaryRoot $relativePath))
        if (-not (Test-Path -LiteralPath $installedFile -PathType Leaf)) {
            throw "临时安装校验失败，缺少文件：$relativePath"
        }
    }

    if (-not $PSCmdlet.ShouldProcess($installRoot, '替换当前用户的 CodexUsageToolbar 安装目录')) { return }
    if (Test-Path -LiteralPath $installRoot) {
        $backupRoot = Get-ExactChildPath $localAppData "CodexUsageToolbar.backup-$stamp" '备份目录'
        if (Test-Path -LiteralPath $backupRoot) {
            throw "本次安装的备份目录已存在：$backupRoot"
        }
        Move-Item -LiteralPath $installRoot -Destination $backupRoot -ErrorAction Stop
    }
    Move-Item -LiteralPath $temporaryRoot -Destination $installRoot -ErrorAction Stop
    $installedNewRoot = $true

    if (-not $PSCmdlet.ShouldProcess($shortcutPath, '创建 Codex（用量显示）开始菜单快捷方式')) {
        throw '已取消创建开始菜单快捷方式，已回滚本次安装。'
    }
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        $backupShortcutPath = Get-ExactChildPath $programsRoot "Codex（用量显示）.lnk.backup-$stamp" '快捷方式备份'
        if (Test-Path -LiteralPath $backupShortcutPath) {
            throw "本次安装的快捷方式备份已存在：$backupShortcutPath"
        }
        Move-Item -LiteralPath $shortcutPath -Destination $backupShortcutPath -ErrorAction Stop
    }

    $shellCom = $null
    $shortcutCom = $null
    $shortcutCreateAttempted = $true
    try {
        $shellCom = New-Object -ComObject WScript.Shell
        $shortcutCom = $shellCom.CreateShortcut($shortcutPath)
        $shortcutCom.TargetPath = $powerShellTarget
        $installedScriptsRoot = Get-ExactChildPath $installRoot 'scripts' '已安装脚本目录'
        $installedStartScript = Get-ExactChildPath $installedScriptsRoot 'start.ps1' '已安装启动脚本'
        $shortcutCom.Arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $installedStartScript + '"'
        $shortcutCom.WorkingDirectory = $installRoot
        $shortcutCom.IconLocation = "$iconPath,0"
        $shortcutCom.Save()
    } finally {
        try {
            if ($null -ne $shortcutCom) {
                [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcutCom)
            }
        } finally {
            try {
                if ($null -ne $shellCom) {
                    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellCom)
                }
            } finally {
                [GC]::Collect()
                [GC]::WaitForPendingFinalizers()
                [GC]::Collect()
            }
        }
    }

    $committed = $true
} catch {
    $originalError = $_
    if (-not $committed) {
        if ($shortcutCreateAttempted -and (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
            Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
        }
        if ($null -ne $backupShortcutPath -and (Test-Path -LiteralPath $backupShortcutPath) -and -not (Test-Path -LiteralPath $shortcutPath)) {
            Move-Item -LiteralPath $backupShortcutPath -Destination $shortcutPath -ErrorAction SilentlyContinue
        }
        if ($installedNewRoot -and (Test-Path -LiteralPath $installRoot -PathType Container)) {
            Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
        if ($null -ne $backupRoot -and (Test-Path -LiteralPath $backupRoot) -and -not (Test-Path -LiteralPath $installRoot)) {
            Move-Item -LiteralPath $backupRoot -Destination $installRoot -ErrorAction SilentlyContinue
        }
    }
    throw $originalError
} finally {
    if (Test-Path -LiteralPath $temporaryRoot -PathType Container) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if ($committed) {
    if ($null -ne $backupRoot -and (Test-Path -LiteralPath $backupRoot)) {
        try {
            Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction Stop
        } catch {
            Write-Warning "新安装已提交，保留本次精确安装备份：$backupRoot。原因：$($_.Exception.Message)"
        }
    }
    if ($null -ne $backupShortcutPath -and (Test-Path -LiteralPath $backupShortcutPath)) {
        try {
            Remove-Item -LiteralPath $backupShortcutPath -Force -ErrorAction Stop
        } catch {
            Write-Warning "新安装已提交，保留本次精确快捷方式备份：$backupShortcutPath。原因：$($_.Exception.Message)"
        }
    }
    Write-Host "安装完成：$installRoot"
    Write-Host "开始菜单快捷方式：$shortcutPath"
}
