# Codex 官方快捷方式图标设计

## 目标

让 `Codex（用量显示）` 的开始菜单和桌面快捷方式使用当前官方 Codex AppX 的黑白图标，同时继续避免在快捷方式中保存带版本号的 `WindowsApps` 路径。

## 当前问题

安装器当前从 `app\Codex.exe` 提取关联图标。该文件不是 AppX 清单声明的主程序，也不是 Windows 为官方 Codex 条目选择图标的来源，因此生成的 `Codex.ico` 与官方图标不一致。

官方 AppX 清单以 `assets/Square44x44Logo.png` 为小图标基础资源，并提供带尺寸限定的 `targetsize-*_altform-unplated.png` 与 `targetsize-*_altform-lightunplated.png` 变体。

## 设计

安装器读取当前用户已注册的最新 `OpenAI.Codex` AppX 包和清单，从清单声明的 `Square44x44Logo` 推导同目录下的官方尺寸变体。

- Windows 应用主题为浅色时使用 `altform-lightunplated`，深色时使用 `altform-unplated`。
- 收集官方提供的 16 到 256 像素 PNG；不自行绘制、着色或替换品牌图形。
- 将 PNG 原始数据按 ICO 容器格式封装为多尺寸 `Codex.ico`，保持透明通道并避免缩放失真。
- 生成结果仍安装到 `%LOCALAPPDATA%\CodexUsageToolbar\assets\Codex.ico`。
- 开始菜单快捷方式和桌面快捷方式都引用该固定文件，不引用 AppX 版本目录。

桌面快捷方式仅在桌面上已存在 `Codex（用量显示）.lnk` 时同步更新；安装器不会擅自新增桌面入口。当前用户已有该快捷方式，因此重新安装后会更新其图标。

## 失败处理

- 找不到 AppX、清单图标声明或任何合格尺寸资源时，安装失败并保留原安装与快捷方式。
- PNG 尺寸、文件长度或 ICO 输出校验失败时，安装回滚。
- 所有路径继续经过精确子路径校验，禁止从 AppX 目录外读取候选资源。

## 验证

- 聚焦测试验证安装预览仍只引用固定 `Codex.ico`，且不出现版本化 `WindowsApps` 路径。
- 新增针对主题变体选择、官方尺寸文件筛选和 ICO 容器结构的聚焦测试。
- 实际安装后验证 ICO 包含多个尺寸，开始菜单与桌面快捷方式引用同一固定图标。
- 运行项目完整验证，并确认未改变启动器、CDP 和用量展示代码。

## 范围外

- 不修改 Codex 官方安装文件。
- 不在 Codex 运行时监听主题变化；切换系统主题后可重新运行安装器以同步官方变体。
- 不启动、关闭或重启 Codex。
