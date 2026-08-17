# Codex 用量监控插件（macOS）

这一版复用用量解析、CDP 会话、官方响应监听和顶部注入逻辑，但使用独立的 macOS 启动层。Windows 目录不会被引用或修改。

## 支持范围

- macOS 14 或更高版本
- Apple Silicon 或 Intel
- ChatGPT.app（当前 Codex 所在桌面应用）或旧版 Codex.app
- Node.js 24 或更高版本

## 安装

在 Mac 终端进入本目录后执行：

```sh
chmod +x scripts/*.sh scripts/*.command
./scripts/install.sh
```

安装脚本会把 Mac 版复制到 `~/Library/Application Support/CodexUsageToolbar/mac`，并创建桌面入口 `Codex（用量显示）.command`。

如果应用不在 `/Applications/ChatGPT.app`、`/Applications/Codex.app` 或用户的 `Applications` 目录，可以指定：

```sh
CODEX_APP_PATH="/自定义路径/ChatGPT.app" ./scripts/start.sh
```

## 启动

双击桌面上的 `Codex（用量显示）.command`，或运行：

```sh
./scripts/start.sh
```

启动器会在 Codex 进程启动时添加仅监听 `127.0.0.1` 的 CDP 端口，然后连接主页面并观察 Codex 自己的用量响应。它不会主动请求额度接口。

## 验证与卸载

```sh
./scripts/verify.sh
./scripts/uninstall.sh
```

## 当前限制

普通官方入口已经运行的 Codex 没有 CDP 时，Mac 版也不能事后安全开启 CDP；请从桌面入口启动。真实界面验收需要在 Mac 上完成，当前 Windows 环境只能做源码和语法验证。
