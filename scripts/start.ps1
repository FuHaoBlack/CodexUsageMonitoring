[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Show-CodexUsageError([string]$Message) {
    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($Message.Trim(), 0, 'Codex 用量显示', 16)
    } catch {
        Write-Error $Message.Trim()
    }
}

try {
    $node = Get-Command node.exe -ErrorAction Stop
    $versionText = (& $node.Source --version).Trim()
    if ($versionText -notmatch '^v?(\d+)(?:\.\d+){1,2}(?:[-+].*)?$' -or [int]$Matches[1] -lt 24) {
        throw 'Node.js 主版本低于 24。'
    }
} catch {
    Show-CodexUsageError '没有找到 Node.js 24 或版本不满足要求。当前用量显示辅助程序无法启动。'
    exit 3
}

$installRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = [IO.Path]::GetFullPath((Join-Path $installRoot 'src\launcher.mjs'))
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    Show-CodexUsageError '未找到用量显示辅助程序启动文件，请重新安装。'
    exit 4
}

& $node.Source $launcher
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    $errorFile = [IO.Path]::GetFullPath((Join-Path $installRoot 'logs\last-error.txt'))
    $message = if (Test-Path -LiteralPath $errorFile -PathType Leaf) {
        Get-Content -LiteralPath $errorFile -Raw
    } else {
        "Codex 用量显示辅助程序已退出，错误代码：$exitCode"
    }
    Show-CodexUsageError $message
}

exit $exitCode
