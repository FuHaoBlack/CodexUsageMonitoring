Set-StrictMode -Version Latest

$script:CodexIconSizes = @(16, 20, 24, 30, 32, 36, 40, 44, 48, 60, 64, 72, 80, 96, 256)

function Get-CodexLogoAssetPaths {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$InstallLocation,

        [Parameter(Mandatory = $true)]
        [string]$Square44Logo,

        [Parameter(Mandatory = $true)]
        [bool]$UseLightTheme
    )

    if ([string]::IsNullOrWhiteSpace($InstallLocation) -or [string]::IsNullOrWhiteSpace($Square44Logo)) {
        throw '官方 Codex 图标路径信息为空，已停止。'
    }

    $installRoot = [IO.Path]::GetFullPath($InstallLocation).TrimEnd('\', '/')
    $declaredPath = [IO.Path]::GetFullPath((Join-Path $installRoot $Square44Logo))
    $installPrefix = $installRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $declaredPath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw '官方 Codex 图标声明越出 AppX 安装目录，已停止。'
    }

    $assetRoot = [IO.Path]::GetDirectoryName($declaredPath)
    if (-not (Test-Path -LiteralPath $assetRoot -PathType Container)) {
        throw '未找到官方 Codex 图标资源目录，已停止。'
    }

    $baseName = [IO.Path]::GetFileNameWithoutExtension($declaredPath)
    $variant = if ($UseLightTheme) { 'lightunplated' } else { 'unplated' }
    $namePattern = '^' + [regex]::Escape($baseName) + '\.targetsize-(\d+)_altform-' + [regex]::Escape($variant) + '\.png$'
    $allowedSizes = [Collections.Generic.HashSet[int]]::new([int[]]$script:CodexIconSizes)
    $assets = @(
        Get-ChildItem -LiteralPath $assetRoot -File -ErrorAction Stop |
            ForEach-Object {
                if ($_.Name -cmatch $namePattern) {
                    $size = [int]$Matches[1]
                    if ($allowedSizes.Contains($size)) {
                        [pscustomobject]@{ Size = $size; Path = $_.FullName }
                    }
                }
            } |
            Sort-Object Size
    )
    if ($assets.Count -eq 0) {
        throw "未找到官方 Codex 的 $variant 多尺寸图标资源，已停止。"
    }

    return @($assets | Select-Object -ExpandProperty Path)
}

function Get-PngDimension {
    param(
        [Parameter(Mandatory = $true)]
        [byte[]]$Bytes,

        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    [byte[]]$signature = @(137, 80, 78, 71, 13, 10, 26, 10)
    if ($Bytes.Length -lt 24) {
        throw "图标帧不是有效的 PNG：$Path"
    }
    for ($index = 0; $index -lt $signature.Length; $index += 1) {
        if ($Bytes[$index] -ne $signature[$index]) {
            throw "图标帧不是有效的 PNG：$Path"
        }
    }
    if ($Bytes[12] -ne 73 -or $Bytes[13] -ne 72 -or $Bytes[14] -ne 68 -or $Bytes[15] -ne 82) {
        throw "图标帧缺少 PNG IHDR：$Path"
    }

    $width = ([uint32]$Bytes[16] -shl 24) -bor ([uint32]$Bytes[17] -shl 16) -bor
        ([uint32]$Bytes[18] -shl 8) -bor [uint32]$Bytes[19]
    $height = ([uint32]$Bytes[20] -shl 24) -bor ([uint32]$Bytes[21] -shl 16) -bor
        ([uint32]$Bytes[22] -shl 8) -bor [uint32]$Bytes[23]
    if ($width -ne $height -or $width -notin $script:CodexIconSizes) {
        throw "官方 Codex PNG 图标尺寸无效：$Path"
    }
    return [int]$width
}

function Write-PngIcon {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$PngPaths,

        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    if ($PngPaths.Count -eq 0 -or [string]::IsNullOrWhiteSpace($Destination)) {
        throw '官方 Codex 图标帧或输出路径为空，已停止。'
    }

    $frames = @(
        foreach ($pngPath in $PngPaths) {
            if (-not (Test-Path -LiteralPath $pngPath -PathType Leaf)) {
                throw "官方 Codex 图标帧不存在：$pngPath"
            }
            $bytes = [IO.File]::ReadAllBytes($pngPath)
            $size = Get-PngDimension -Bytes $bytes -Path $pngPath
            [pscustomobject]@{ Size = $size; Bytes = $bytes; Path = $pngPath }
        }
    ) | Sort-Object Size

    $duplicate = $frames | Group-Object Size | Where-Object Count -gt 1 | Select-Object -First 1
    if ($null -ne $duplicate) {
        throw "官方 Codex 图标包含重复尺寸：$($duplicate.Name)"
    }

    $destinationPath = [IO.Path]::GetFullPath($Destination)
    $destinationRoot = [IO.Path]::GetDirectoryName($destinationPath)
    if (-not (Test-Path -LiteralPath $destinationRoot -PathType Container)) {
        throw "固定图标输出目录不存在：$destinationRoot"
    }
    $temporaryPath = "$destinationPath.tmp-$([guid]::NewGuid().ToString('N'))"
    $stream = $null
    $writer = $null
    try {
        $stream = [IO.File]::Open($temporaryPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $writer = [IO.BinaryWriter]::new($stream)
        $writer.Write([uint16]0)
        $writer.Write([uint16]1)
        $writer.Write([uint16]$frames.Count)

        [uint32]$dataOffset = 6 + (16 * $frames.Count)
        foreach ($frame in $frames) {
            $dimension = if ($frame.Size -eq 256) { 0 } else { $frame.Size }
            $writer.Write([byte]$dimension)
            $writer.Write([byte]$dimension)
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([uint16]1)
            $writer.Write([uint16]32)
            $writer.Write([uint32]$frame.Bytes.Length)
            $writer.Write($dataOffset)
            $dataOffset += [uint32]$frame.Bytes.Length
        }
        foreach ($frame in $frames) {
            $writer.Write([byte[]]$frame.Bytes)
        }
        $writer.Flush()
        $stream.Flush($true)
    } finally {
        if ($null -ne $writer) { $writer.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
    }

    try {
        if (-not (Test-Path -LiteralPath $temporaryPath -PathType Leaf) -or
            (Get-Item -LiteralPath $temporaryPath).Length -le (6 + 16 * $frames.Count)) {
            throw '固定多尺寸 Codex 图标生成失败。'
        }
        Move-Item -LiteralPath $temporaryPath -Destination $destinationPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}
