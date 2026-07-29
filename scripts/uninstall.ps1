[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()

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

function Test-ExactHelperCommandLine([string]$CommandLine, [string]$LauncherPath, [string]$StartScriptPath) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return $false }
    $boundary = '(?:^|[\s"''])(?:{0}|{1})(?=$|[\s"''])'
    $pattern = [string]::Format(
        $boundary,
        [regex]::Escape($LauncherPath),
        [regex]::Escape($StartScriptPath)
    )
    return [regex]::IsMatch($CommandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
}

$localAppData = [Environment]::GetFolderPath('LocalApplicationData')
$appData = [Environment]::GetFolderPath('ApplicationData')
if ([string]::IsNullOrWhiteSpace($localAppData) -or [string]::IsNullOrWhiteSpace($appData)) {
    throw '无法解析当前用户的 LocalAppData 或 AppData，已停止。'
}

$installRoot = Get-ExactChildPath $localAppData 'CodexUsageToolbar' '卸载目录'
$expectedParent = Normalize-Path $localAppData
if ((Normalize-Path ([IO.Path]::GetDirectoryName($installRoot))) -cne $expectedParent) {
    throw '卸载目标不在当前用户 LocalAppData 中，已停止。'
}

$microsoftRoot = Get-ExactChildPath $appData 'Microsoft' '开始菜单 Microsoft 目录'
$windowsRoot = Get-ExactChildPath $microsoftRoot 'Windows' '开始菜单 Windows 目录'
$startMenuRoot = Get-ExactChildPath $windowsRoot 'Start Menu' '开始菜单目录'
$programsRoot = Get-ExactChildPath $startMenuRoot 'Programs' '开始菜单 Programs 目录'
$shortcutPath = Get-ExactChildPath $programsRoot 'Codex（用量显示）.lnk' '开始菜单快捷方式'
$launcherPath = Get-ExactChildPath (Get-ExactChildPath $installRoot 'src' '已安装源目录') 'launcher.mjs' '已安装启动模块'
$startScriptPath = Get-ExactChildPath (Get-ExactChildPath $installRoot 'scripts' '已安装脚本目录') 'start.ps1' '已安装启动脚本'
$allowedNames = @('node.exe', 'node', 'pwsh.exe', 'pwsh', 'powershell.exe', 'powershell')

$allProcesses = $null
try {
    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
} catch {
    throw "无法枚举当前进程，已停止卸载：$($_.Exception.Message)"
}

$helperProcesses = @($allProcesses | Where-Object {
    $allowedNames -icontains $_.Name -and
    (Test-ExactHelperCommandLine $_.CommandLine $launcherPath $startScriptPath)
})

foreach ($process in $helperProcesses) {
    $target = "进程 $($process.ProcessId)（$($process.Name)）"
    if ($PSCmdlet.ShouldProcess($target, '停止 Codex 用量显示辅助进程')) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
    }
}

if ($PSCmdlet.ShouldProcess($shortcutPath, '删除 Codex（用量显示）开始菜单快捷方式')) {
    if (Test-Path -LiteralPath $shortcutPath -PathType Leaf) {
        Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction Stop
    }
}

if ($PSCmdlet.ShouldProcess($installRoot, '删除当前用户的 CodexUsageToolbar 安装目录')) {
    if (Test-Path -LiteralPath $installRoot -PathType Container) {
        Remove-Item -LiteralPath $installRoot -Recurse -Force -ErrorAction Stop
    }
}

if ($WhatIfPreference) {
    Write-Host 'WhatIf：未执行卸载，官方 Codex、其原始快捷方式和账户数据均未修改。'
} else {
    Write-Host '卸载完成：未修改官方 Codex、其原始快捷方式或任何账户数据。'
}
