# Codex Official Shortcut Icon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `Codex（用量显示）` 使用当前官方 Codex AppX 的主题匹配、多尺寸黑白图标，同时保持快捷方式路径不受 Codex 版本更新影响。

**Architecture:** 安装器从 AppX 清单声明的 `Square44x44Logo` 推导官方 `targetsize` PNG 资源，主题选择与 ICO 容器写入放在独立 PowerShell 工具文件中。安装时把官方 PNG 原始数据封装进固定的 `%LOCALAPPDATA%\CodexUsageToolbar\assets\Codex.ico`；开始菜单和已有桌面快捷方式继续引用该固定文件。

**Tech Stack:** PowerShell 7、AppX 清单、Windows ICO PNG 帧格式、Node.js 24 内置测试运行器、Git。

## Global Constraints

- 不修改 Codex 官方安装文件。
- 不在快捷方式中保存带版本号的 `WindowsApps` 路径。
- 不引入 npm、NuGet 或其他第三方依赖。
- 不启动、关闭或重启 Codex。
- 找不到官方图标资源或生成校验失败时，安装必须回滚并保留原安装。
- 桌面快捷方式仍引用固定 `assets\Codex.ico`；替换该文件即可同步图标，不额外创建桌面入口。

---

## File Structure

- Create `scripts/icon-tools.ps1`: 选择官方主题资源、校验 PNG 尺寸并写入多帧 ICO。
- Create `tests/icon-tools.test.mjs`: 使用临时官方形态 PNG 样本验证主题选择、路径边界和 ICO 目录结构。
- Modify `scripts/install.ps1`: 读取 AppX 清单，调用图标工具生成固定图标，保留现有事务式安装回滚。
- Modify `tests/install-script.test.mjs`: 验证安装预览使用官方 AppX 资源生成固定 ICO，且不持久化版本路径。
- Modify `scripts/verify.ps1`: 将新增工具和测试纳入清单及安装副本比对。
- Modify `README.md`: 说明快捷方式使用安装时复制的官方多尺寸图标及主题同步方式。

### Task 1: 官方 PNG 选择与 ICO 封装工具

**Files:**
- Create: `scripts/icon-tools.ps1`
- Create: `tests/icon-tools.test.mjs`

**Interfaces:**
- Produces: `Get-CodexLogoAssetPaths -InstallLocation <string> -Square44Logo <string> -UseLightTheme <bool> -> string[]`
- Produces: `Write-PngIcon -PngPaths <string[]> -Destination <string> -> void`
- Consumes: AppX 安装根目录、清单相对图标路径和当前 Windows 应用主题。

- [ ] **Step 1: Write failing resource-selection tests**

测试先用 `System.Drawing.Bitmap(<size>, <size>).Save(..., Png)` 在 Node 临时目录生成有效的 16 与 256 像素透明 PNG，再按官方命名构造 `assets/Square44x44Logo.targetsize-16_altform-unplated.png`、`targetsize-256` 和对应的 `lightunplated` 文件。随后通过 PowerShell 7 点入工具文件并调用：

```powershell
. $env:ICON_TOOLS_PATH
$paths = Get-CodexLogoAssetPaths -InstallLocation $env:FAKE_APPX_ROOT -Square44Logo 'assets/Square44x44Logo.png' -UseLightTheme $true
$paths | ConvertTo-Json -Compress
```

断言浅色主题只返回 `lightunplated`，深色主题只返回 `unplated`，顺序为尺寸升序；传入 `..\outside.png` 必须失败并输出清晰中文原因。

- [ ] **Step 2: Run selection tests and verify RED**

Run: `node --test tests/icon-tools.test.mjs`

Expected: FAIL，因为 `scripts/icon-tools.ps1` 或目标函数尚不存在。

- [ ] **Step 3: Implement exact-path resource selection**

`Get-CodexLogoAssetPaths` 必须：

```powershell
$installRoot = [IO.Path]::GetFullPath($InstallLocation)
$declaredPath = [IO.Path]::GetFullPath((Join-Path $installRoot $Square44Logo))
$installPrefix = $installRoot.TrimEnd('\') + '\'
if (-not $declaredPath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw '官方 Codex 图标声明越出 AppX 安装目录，已停止。'
}
```

随后只枚举与清单基础名一致的 `targetsize-{16|20|24|30|32|36|40|44|48|60|64|72|80|96|256}_altform-{theme}.png`，至少需要一项，按数值尺寸排序。

- [ ] **Step 4: Write failing ICO-container test**

测试生成至少两个有效 PNG 帧，调用 `Write-PngIcon` 后读取二进制并断言：

```javascript
assert.equal(output.readUInt16LE(0), 0);
assert.equal(output.readUInt16LE(2), 1);
assert.equal(output.readUInt16LE(4), 2);
assert.equal(output.readUInt32LE(6 + 12), 6 + 16 * 2);
```

同时断言 256 像素目录宽高字段为 `0`、每个偏移和长度都落在文件边界内，非 PNG 输入必须失败。

- [ ] **Step 5: Implement PNG validation and ICO writing**

`Write-PngIcon` 读取每个 PNG 的签名和 IHDR 宽高，要求正方形且尺寸在允许集合中；按 ICO 规范写入 `ICONDIR`、每帧 16 字节 `ICONDIRENTRY` 和原始 PNG 字节：

```powershell
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$frames.Count)
# width/height: 256 写 0，其余写实际尺寸；planes=1，bitCount=32。
```

输出先写目标目录内的唯一临时文件，校验成功后再移动到 `$Destination`，异常时删除临时文件。

- [ ] **Step 6: Run focused tests and commit**

Run: `node --test tests/icon-tools.test.mjs`

Expected: PASS。

Commit:

```powershell
git add -- scripts/icon-tools.ps1 tests/icon-tools.test.mjs
git commit -m "实现官方多尺寸图标封装"
```

### Task 2: 安装器集成官方 AppX 图标

**Files:**
- Modify: `scripts/install.ps1`
- Modify: `tests/install-script.test.mjs`
- Modify: `scripts/verify.ps1`

**Interfaces:**
- Consumes: Task 1 的 `Get-CodexLogoAssetPaths` 与 `Write-PngIcon`。
- Produces: 安装后的固定 `assets/Codex.ico`，供开始菜单和已有桌面快捷方式共同读取。

- [ ] **Step 1: Extend install preview test and verify RED**

测试断言 `-WhatIf` 输出包含“从当前 Codex 官方 AppX 资源生成固定多尺寸图标”，并继续断言输出不含 `WindowsApps\OpenAI.Codex_`。

Run: `node --test tests/install-script.test.mjs`

Expected: FAIL，因为安装器仍使用可执行文件关联图标措辞与逻辑。

- [ ] **Step 2: Replace executable extraction with manifest-driven generation**

安装器点入工具文件：

```powershell
$iconToolsPath = Get-ExactChildPath $sourceScriptsRoot 'icon-tools.ps1' '官方图标工具'
. $iconToolsPath
```

`Get-CodexIconAssets` 获取最新 `OpenAI.Codex` 包及清单中的 `Square44x44Logo`，读取：

```powershell
$themeValue = Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name AppsUseLightTheme -ErrorAction SilentlyContinue
$appsUseLightTheme = $null -eq $themeValue -or [int]$themeValue -ne 0
```

并调用 `Get-CodexLogoAssetPaths`。复制源文件后调用 `Write-PngIcon -PngPaths $sourceIconPaths -Destination $temporaryIconPath`，移除 `System.Drawing.Icon.ExtractAssociatedIcon`。

- [ ] **Step 3: Keep transaction and fixed shortcut contract**

生成发生在替换原安装目录之前；任一资源或 ICO 校验失败都进入现有 `catch/finally` 回滚。快捷方式继续使用：

```powershell
$shortcutCom.IconLocation = "$installedIconPath,0"
```

不写入任何源 AppX 路径。若桌面已存在 `Codex（用量显示）.lnk`，先验证它的目标和参数仍指向本插件固定启动脚本，再用 COM 将 `IconLocation` 重写为同一个 `$installedIconPath,0` 并保存，以触发 Windows Shell 刷新；不存在时不创建，不匹配时不覆盖并输出明确中文提示。

- [ ] **Step 4: Update verification manifest and run focused tests**

将 `scripts/icon-tools.ps1`、`tests/icon-tools.test.mjs` 加入 `scripts/verify.ps1` 的预期文件；安装副本比对自然包含新增脚本。

Run: `node --test tests/icon-tools.test.mjs tests/install-script.test.mjs`

Expected: PASS。

- [ ] **Step 5: Commit installer integration**

```powershell
git add -- scripts/install.ps1 scripts/verify.ps1 tests/install-script.test.mjs
git commit -m "改用官方 Codex 图标资源"
```

### Task 3: 文档、实际安装与完整验证

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 2 生成的固定多尺寸 ICO。
- Produces: 可审计的安装说明和真实快捷方式验证证据。

- [ ] **Step 1: Update usage documentation**

说明安装器从当前官方 AppX 清单资源生成多尺寸固定图标；系统应用主题变化后重新安装可同步官方主题变体；不会修改官方 Codex 或在运行时引用版本目录。

- [ ] **Step 2: Run the full offline verification**

Run: `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoLogo -NoProfile -File .\scripts\verify.ps1`

Expected: 所有语法、测试和清单检查通过，失败 0 项。

- [ ] **Step 3: Install without launching Codex**

Run: `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoLogo -NoProfile -File .\scripts\install.ps1 -SourceRoot 'D:\自研软件\Codex用量监控插件' -Confirm:$false`

Expected: 安装完成；不启动、关闭或重启 Codex。

- [ ] **Step 4: Verify installed files and shortcuts**

Run: `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoLogo -NoProfile -File .\scripts\verify.ps1 -InstalledRoot "$env:LOCALAPPDATA\CodexUsageToolbar"`

另外解析 `Codex.ico`，确认多帧目录、官方 PNG 哈希对应关系，以及开始菜单与桌面 `Codex（用量显示）.lnk` 均指向固定图标文件。

- [ ] **Step 5: Commit documentation and push master**

```powershell
git add -- README.md
git commit -m "补充官方图标同步说明"
git push origin master
```

Expected: 本地 `master`、`origin/master` 和 GitHub 默认分支保持一致。
