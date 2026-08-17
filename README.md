# Codex 用量监控插件

本仓库按运行平台隔离：

- [Windows 版](windows/README.md)：AppX、PowerShell、Win32 生命周期和开始菜单入口。
- [macOS 版](mac/README.md)：ChatGPT/Codex `.app` 发现、macOS 进程生命周期和 shell 安装入口。

两边分别拥有自己的 `src/`、`scripts/` 和 `tests/`，运行时互不引用。两边共用的设计原则保持一致：只观察 Codex 自己已经发出的官方用量响应，不主动请求额度接口，不修改官方 App 或 `app.asar`，并通过本机回环 CDP 注入只读展示。

## 目录

```text
windows/
  src/       Windows 运行时代码
  scripts/   PowerShell 安装、启动、卸载和验证
  tests/     Windows 测试
mac/
  src/       macOS 独立运行时代码
  scripts/   shell 安装、启动、卸载和验证
  tests/     macOS 共用核心测试
docs/        设计与实施记录
```

Mac 版的真实启动、CDP 连接和界面显示需要在 macOS 14+ 的 Apple Silicon 或 Intel 设备上验收；Windows 环境不能替代该验收。
