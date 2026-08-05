# Codex 用量监控插件

该插件为 Codex 桌面端顶部工具栏补充当前每周剩余额度与重置信息。它只观察 Codex 已自行发起的官方响应，不修改官方安装、设置、账户数据或 `app.asar`。

## 一键启动

安装后，从开始菜单运行 `Codex（用量显示）`。它会启动一份带本机回环 CDP 的 Codex，并在顶部显示用量；若 Codex 已在运行，辅助程序会停止并提示先正常关闭现有 Codex。插件不会自行关闭、重启或替换现有 Codex。

## 展示规则

宽窗口基础文案为：

```text
用量：每周 {剩余百分比}%（{每周重置时间} 重置）
```

当剩余重置次数大于 `0` 时，追加 `｜剩余重置次数：{次数}`；仅当 Codex 自己已提供重置券明细时，再追加 `（最近一次重置到期：{日期}）`。次数为 `0` 时，不显示任何重置次数、图标或到期日；次数暂缺时显示“未知”。

窄窗口使用：

```text
周 {剩余百分比}%｜↻（{次数}）
```

次数为 `0` 时缩略为 `周 {剩余百分比}%`；次数暂缺时显示 `↻（?）`。

## 不额外请求

插件绝不会主动请求 `/wham/usage` 或 `/wham/rate-limit-reset-credits`，也没有独立的额度刷新定时器。因此，最近一次重置到期日是可选信息：只有 Codex 自己请求并返回了重置券明细后才会出现。

## 版本兼容策略

顶部位置不绑定 Codex 版本号，也不查找 `Help` 文案、中文/英文菜单名、元素 ID 或 CSS 类名。插件只接受页面顶部唯一可见的标准 `role="menubar"`，向上寻找横向承载容器，再把只读文字插入整个菜单分支右侧；没有唯一可信菜单时不显示，也不会退回到聊天内容标题栏。

这能避免普通版本升级、样式哈希和界面语言变化造成的失效。如果 Codex 将菜单完全移出渲染页面、移除标准菜单语义或改成非顶部横向结构，插件会安全停止注入并等待适配，不影响 Codex 本身。

开始菜单快捷方式也不保存带版本号的 `WindowsApps` 路径：启动目标固定为插件安装目录中的 `scripts\start.ps1`，图标固定为 `assets\Codex.ico`。安装器只在安装当时读取当前 AppX 来提取图标；此后的 Codex 版本更新不会让快捷方式引用失效。

## 安装

在项目根目录使用 PowerShell 7 安装：

```powershell
& .\scripts\install.ps1
```

## 验证

在项目根目录使用 PowerShell 7 验证：

```powershell
& .\scripts\verify.ps1
```

如需校验实际安装副本：

```powershell
$installRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'CodexUsageToolbar'
& .\scripts\verify.ps1 -InstalledRoot $installRoot
```

## 卸载

确认不再需要该插件后，在项目根目录使用 PowerShell 7 卸载：

```powershell
& .\scripts\uninstall.ps1
```

## 真实验收边界与回退

离线验证不会证明已在真实 Codex 界面显示。真实验收必须在你允许的窗口中：先正常关闭 Codex，再从 `Codex（用量显示）` 启动，确认完整/缩略文案、导航恢复及随 Codex 退出的辅助进程。插件不会替你关闭或重启 Codex。

插件只显示启动后观察到的下一次 Codex 官方成功响应；启动前已经完成的请求不会被补抓，也不会为填充界面而主动重发。

如果 Microsoft Store 恰好在启动期间更新 Codex，Windows 可能强制关闭刚启动的旧版本；等待更新完成并正常关闭当前 Codex 后，再从 `Codex（用量显示）` 启动一次即可。插件不会绕过更新、强制结束进程或自动重启 Codex。

需要立即回退时，直接从原有官方 Codex 入口启动即可：官方应用保持未改动，且不会显示本插件工具栏。
