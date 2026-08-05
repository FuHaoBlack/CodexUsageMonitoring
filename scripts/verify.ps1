[CmdletBinding()]
param(
    [string]$InstalledRoot
)

$ErrorActionPreference = 'Stop'

function Add-VerificationFailure([string]$Message) {
    $script:failures.Add($Message)
    Write-Host "失败：$Message" -ForegroundColor Red
}

function Invoke-NodeCheck([string]$Label, [string[]]$Arguments) {
    try {
        & $script:nodePath @Arguments
        if ($LASTEXITCODE -ne 0) {
            Add-VerificationFailure "$Label（Node 退出代码：$LASTEXITCODE）"
            return $false
        }
        return $true
    } catch {
        Add-VerificationFailure "$Label（$($_.Exception.Message)）"
        return $false
    }
}

function Get-RelativeProjectPath([string]$Path) {
    return [IO.Path]::GetRelativePath($script:projectRoot, $Path).Replace('\', '/')
}

function Get-TrackedContentFiles([string]$Root) {
    return @(
        Get-ChildItem -LiteralPath (Join-Path $Root 'src') -Recurse -File -ErrorAction Stop
        Get-ChildItem -LiteralPath (Join-Path $Root 'scripts') -Recurse -File -ErrorAction Stop
        Get-ChildItem -LiteralPath (Join-Path $Root 'tests') -Recurse -File -ErrorAction Stop
    ) | Sort-Object FullName
}

$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:projectRoot = $projectRoot
$failures = [System.Collections.Generic.List[string]]::new()
$syntaxChecked = 0
$testsRun = 0
$manifestEntries = 0
$installedCompared = 0

if ($PSVersionTable.PSVersion.Major -lt 7) {
    Add-VerificationFailure "需要 PowerShell 7 或更高版本，当前为 $($PSVersionTable.PSVersion)"
}

$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
}
if ($null -eq $nodeCommand) {
    Add-VerificationFailure '未找到 Node.js。'
} else {
    $script:nodePath = $nodeCommand.Source
    try {
        $nodeVersion = (& $script:nodePath --version).Trim()
        if ($nodeVersion -notmatch '^v?(\d+)(?:\.\d+){1,2}(?:[-+].*)?$') {
            Add-VerificationFailure "无法识别 Node.js 版本：$nodeVersion"
        } elseif ([int]$Matches[1] -lt 24) {
            Add-VerificationFailure "需要 Node.js 24 或更高版本，当前为 $nodeVersion"
        }
    } catch {
        Add-VerificationFailure "无法读取 Node.js 版本：$($_.Exception.Message)"
    }
}

$expectedFiles = @(
    'README.md',
    'src/cdp-session.mjs',
    'src/inject.js',
    'src/injection-controller.mjs',
    'src/launcher.mjs',
    'src/logger.mjs',
    'src/usage-observer.mjs',
    'src/usage-state.mjs',
    'src/windows-codex.mjs',
    'scripts/icon-tools.ps1',
    'scripts/install.ps1',
    'scripts/start.ps1',
    'scripts/uninstall.ps1',
    'scripts/verify.ps1',
    'tests/cdp-session.test.mjs',
    'tests/icon-tools.test.mjs',
    'tests/injection-contract.test.mjs',
    'tests/install-script.test.mjs',
    'tests/logger.test.mjs',
    'tests/source-policy.test.mjs',
    'tests/usage-observer.test.mjs',
    'tests/usage-state.test.mjs',
    'tests/windows-codex.test.mjs'
)

foreach ($relativePath in $expectedFiles) {
    $candidate = Join-Path $projectRoot $relativePath
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        Add-VerificationFailure "缺少预期文件：$relativePath"
    }
}

try {
    $forbiddenDirectories = @(Get-ChildItem -LiteralPath $projectRoot -Recurse -Directory -Force -ErrorAction Stop |
        Where-Object { $_.Name -ieq 'node_modules' })
    foreach ($directory in $forbiddenDirectories) {
        Add-VerificationFailure "发现禁止的依赖目录：$(Get-RelativeProjectPath $directory.FullName)"
    }
} catch {
    Add-VerificationFailure "无法枚举依赖目录：$($_.Exception.Message)"
}

try {
    $forbiddenFiles = @(Get-ChildItem -LiteralPath $projectRoot -Recurse -File -Force -ErrorAction Stop |
        Where-Object {
            $_.Name -ieq 'package-lock.json' -or
            $_.Extension -iin @('.asar', '.node', '.dll', '.exe', '.tgz')
        })
    foreach ($file in $forbiddenFiles) {
        Add-VerificationFailure "发现禁止的第三方运行时或锁文件：$(Get-RelativeProjectPath $file.FullName)"
    }
} catch {
    Add-VerificationFailure "无法枚举第三方运行时或锁文件：$($_.Exception.Message)"
}

if ($null -ne $script:nodePath) {
    try {
        $syntaxFiles = @(
            Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -Recurse -File -ErrorAction Stop
            Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests') -Recurse -File -ErrorAction Stop
        ) | Where-Object { $_.Extension -ieq '.mjs' -or $_.Name -ieq 'inject.js' } |
            Sort-Object FullName
    } catch {
        $syntaxFiles = @()
        Add-VerificationFailure "无法枚举语法检查文件：$($_.Exception.Message)"
    }
    foreach ($file in $syntaxFiles) {
        if (Invoke-NodeCheck "语法检查失败：$(Get-RelativeProjectPath $file.FullName)" @('--check', $file.FullName)) {
            $syntaxChecked += 1
        }
    }

    try {
        $testFiles = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'tests') -Filter '*.test.mjs' -File -ErrorAction Stop |
            Sort-Object FullName |
            Select-Object -ExpandProperty FullName)
        if ($testFiles.Count -eq 0) {
            Add-VerificationFailure '未找到任何聚焦测试文件。'
        } elseif (Invoke-NodeCheck '聚焦测试失败' (@('--test') + $testFiles)) {
            $testsRun = $testFiles.Count
        }
    } catch {
        Add-VerificationFailure "无法枚举聚焦测试文件：$($_.Exception.Message)"
    }

    [void](Invoke-NodeCheck 'Codex AppX 发现失败' @((Join-Path $projectRoot 'src/windows-codex.mjs'), '--discover-only'))
}

try {
    $contentFiles = Get-TrackedContentFiles $projectRoot
    $manifestRoot = Join-Path $projectRoot 'outputs'
    $manifestPath = Join-Path $manifestRoot 'verification-manifest.sha256'
    New-Item -ItemType Directory -Path $manifestRoot -Force | Out-Null
    $manifestLines = foreach ($file in $contentFiles) {
        $hash = (Get-FileHash -Path $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        $manifestEntries += 1
        "$hash *$(Get-RelativeProjectPath $file.FullName)"
    }
    [IO.File]::WriteAllLines($manifestPath, [string[]]$manifestLines, [Text.UTF8Encoding]::new($false))
} catch {
    Add-VerificationFailure "无法写入验证清单：$($_.Exception.Message)"
}

if (-not [string]::IsNullOrWhiteSpace($InstalledRoot)) {
    try {
        $installedRootPath = [IO.Path]::GetFullPath($InstalledRoot)
        if (-not (Test-Path -LiteralPath $installedRootPath -PathType Container)) {
            throw "安装目录不存在：$installedRootPath"
        }
        $installedIconPath = Join-Path $installedRootPath 'assets\Codex.ico'
        if (-not (Test-Path -LiteralPath $installedIconPath -PathType Leaf)) {
            Add-VerificationFailure '已安装副本缺少固定快捷方式图标：assets/Codex.ico'
        } elseif ((Get-Item -LiteralPath $installedIconPath).Length -le 0) {
            Add-VerificationFailure '已安装固定快捷方式图标为空：assets/Codex.ico'
        }
        $sourceFiles = @(
            Get-ChildItem -LiteralPath (Join-Path $projectRoot 'src') -Recurse -File -ErrorAction Stop
            Get-ChildItem -LiteralPath (Join-Path $projectRoot 'scripts') -Recurse -File -ErrorAction Stop
        )
        $installedFiles = @(
            Get-ChildItem -LiteralPath (Join-Path $installedRootPath 'src') -Recurse -File -ErrorAction Stop
            Get-ChildItem -LiteralPath (Join-Path $installedRootPath 'scripts') -Recurse -File -ErrorAction Stop
        )
        $sourceFileMap = @{}
        foreach ($sourceFile in $sourceFiles) {
            $sourceFileMap[(Get-RelativeProjectPath $sourceFile.FullName)] = $sourceFile
        }
        $installedFileMap = @{}
        foreach ($installedFile in $installedFiles) {
            $relativePath = [IO.Path]::GetRelativePath($installedRootPath, $installedFile.FullName).Replace('\', '/')
            $installedFileMap[$relativePath] = $installedFile
        }
        foreach ($relativePath in $sourceFileMap.Keys) {
            if (-not $installedFileMap.ContainsKey($relativePath)) {
                Add-VerificationFailure "已安装文件缺失：$relativePath"
            }
        }
        foreach ($relativePath in $installedFileMap.Keys) {
            if (-not $sourceFileMap.ContainsKey($relativePath)) {
                Add-VerificationFailure "已安装副本含有额外文件：$relativePath"
            }
        }
        foreach ($sourceFile in $sourceFiles) {
            $relativePath = Get-RelativeProjectPath $sourceFile.FullName
            if (-not $installedFileMap.ContainsKey($relativePath)) {
                continue
            }
            $installedFile = $installedFileMap[$relativePath]
            $sourceHash = (Get-FileHash -Path $sourceFile.FullName -Algorithm SHA256).Hash
            $installedHash = (Get-FileHash -Path $installedFile.FullName -Algorithm SHA256).Hash
            if ($sourceHash -cne $installedHash) {
                Add-VerificationFailure "已安装文件哈希不一致：$relativePath"
                continue
            }
            $installedCompared += 1
        }
    } catch {
        Add-VerificationFailure "已安装文件比对失败：$($_.Exception.Message)"
    }
}

$summary = "验证完成：语法通过 $syntaxChecked 个；测试文件通过 $testsRun 个；清单 $manifestEntries 项；已安装文件比对 $installedCompared 项；失败 $($failures.Count) 项。"
if ($failures.Count -eq 0) {
    Write-Host $summary -ForegroundColor Green
    exit 0
}

Write-Host $summary -ForegroundColor Red
Write-Host '失败明细：' -ForegroundColor Red
foreach ($failure in $failures) {
    Write-Host "- $failure" -ForegroundColor Red
}
exit 1
