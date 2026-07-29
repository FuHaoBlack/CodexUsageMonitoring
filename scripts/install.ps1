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

    $icon = [IO.Path]::GetFullPath((Join-Path $package.InstallLocation 'Codex.exe'))
    if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) {
        throw '未找到官方 Codex.exe，无法创建带官方图标的快捷方式。'
    }
    return $icon
}

$sourceRootPath = Normalize-Path $SourceRoot
$sourceDirectories = @('src', 'scripts')
foreach ($directory in $sourceDirectories) {
    $sourceDirectory = Get-ExactChildPath $sourceRootPath $directory "源目录 $directory"
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
        throw "缺少必需源目录：$directory"
    }
}

$requiredSourceFiles = @(
    'src\launcher.mjs',
    'scripts\start.ps1'
)
foreach ($relativePath in $requiredSourceFiles) {
    $sourceFile = [IO.Path]::GetFullPath((Join-Path $sourceRootPath $relativePath))
    if (-not (Test-Path -LiteralPath $sourceFile -PathType Leaf)) {
        throw "缺少必需源文件：$relativePath"
    }
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

$sourceFiles = Get-ChildItem -LiteralPath $sourceRootPath -Recurse -File |
    Where-Object {
        $_.FullName.StartsWith((Get-ExactChildPath $sourceRootPath 'src' '源目录 src'), [StringComparison]::OrdinalIgnoreCase) -or
        $_.FullName.StartsWith((Get-ExactChildPath $sourceRootPath 'scripts' '源目录 scripts'), [StringComparison]::OrdinalIgnoreCase)
    }
if ($sourceFiles.Count -eq 0) {
    throw '没有可安装的源文件，已停止。'
}

if ($WhatIfPreference) {
    [void]$PSCmdlet.ShouldProcess($temporaryRoot, '复制并验证临时安装目录')
    [void]$PSCmdlet.ShouldProcess($installRoot, '替换当前用户的 CodexUsageToolbar 安装目录')
    [void]$PSCmdlet.ShouldProcess($shortcutPath, '创建 Codex（用量显示）开始菜单快捷方式')
    return
}

$iconPath = Get-CodexIconPath
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$backupRoot = $null
$backupShortcutPath = $null
$installedNewRoot = $false
$shortcutAttempted = $false

try {
    if (-not $PSCmdlet.ShouldProcess($temporaryRoot, '复制并验证临时安装目录')) { return }
    New-Item -ItemType Directory -LiteralPath $temporaryRoot -Force | Out-Null
    foreach ($directory in $sourceDirectories) {
        Copy-Item -LiteralPath (Get-ExactChildPath $sourceRootPath $directory "源目录 $directory") -Destination $temporaryRoot -Recurse -Force
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
    $shortcutParent = [IO.Path]::GetDirectoryName($shortcutPath)
    if (-not (Test-Path -LiteralPath $shortcutParent -PathType Container)) {
        New-Item -ItemType Directory -LiteralPath $shortcutParent -Force | Out-Null
    }
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        $backupShortcutPath = Get-ExactChildPath $programsRoot "Codex（用量显示）.lnk.backup-$stamp" '快捷方式备份'
        if (Test-Path -LiteralPath $backupShortcutPath) {
            throw "本次安装的快捷方式备份已存在：$backupShortcutPath"
        }
        Move-Item -LiteralPath $shortcutPath -Destination $backupShortcutPath -ErrorAction Stop
    }
    $shortcutAttempted = $true
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = 'C:\Program Files\PowerShell\7\pwsh.exe'
    $installedScriptsRoot = Get-ExactChildPath $installRoot 'scripts' '已安装脚本目录'
    $installedStartScript = Get-ExactChildPath $installedScriptsRoot 'start.ps1' '已安装启动脚本'
    $shortcut.Arguments = '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $installedStartScript + '"'
    $shortcut.WorkingDirectory = $installRoot
    $shortcut.IconLocation = "$iconPath,0"
    $shortcut.Save()

    if ($null -ne $backupRoot -and (Test-Path -LiteralPath $backupRoot)) {
        Remove-Item -LiteralPath $backupRoot -Recurse -Force
    }
    if ($null -ne $backupShortcutPath -and (Test-Path -LiteralPath $backupShortcutPath)) {
        Remove-Item -LiteralPath $backupShortcutPath -Force
    }
    Write-Host "安装完成：$installRoot"
    Write-Host "开始菜单快捷方式：$shortcutPath"
} catch {
    $originalError = $_
    if ($installedNewRoot -and (Test-Path -LiteralPath $installRoot)) {
        Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $backupRoot -and (Test-Path -LiteralPath $backupRoot) -and -not (Test-Path -LiteralPath $installRoot)) {
        Move-Item -LiteralPath $backupRoot -Destination $installRoot -ErrorAction SilentlyContinue
    }
    if ($shortcutAttempted -and (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
        Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $backupShortcutPath -and (Test-Path -LiteralPath $backupShortcutPath) -and -not (Test-Path -LiteralPath $shortcutPath)) {
        Move-Item -LiteralPath $backupShortcutPath -Destination $shortcutPath -ErrorAction SilentlyContinue
    }
    throw $originalError
} finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
