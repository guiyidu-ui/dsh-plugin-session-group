# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.2.0] - 2026-09-17

### 发布（Release）
- 作为独立 npm 风格插件包首次公开发布（GitHub 公开仓库）。
- 补全发布元数据：`license`(MIT)、`author`、`repository`/`homepage`/`bugs`、`keywords`、`files` 白名单、`dsh.engines` 声明（`dsh >= 0.1.2-alpha.4`）。
- 新增 `README.md`（安装/使用/架构）、`LICENSE`、`CHANGELOG.md`。
- 剔除运行时/诊断文件（`.diag`、`.write-test`、`restart.log`、`watchdog.ps1`），仓库只保留可发布的 `lib/` + 元数据。

### 不变
- 核心功能与 1.1.0 一致：按项目(cwd)分组的侧边栏会话树、分组/原始双模式、纯客户端零宿主路由。

## [1.1.0] - 2026-09（开发版本）

### 功能
- DSH Web 侧边栏会话列表按项目(cwd)分组展示：可折叠的项目分组树。
- 双模式切换：**分组模式**接管 `sidebar.workspaces` 槽位；**原始模式**让位给 DSH 内置会话列表。
- 纯客户端实现（`lib/client.js`），宿主半边（`lib/index.js`）为空壳，零宿主路由、零服务端依赖。
- 通过 `dsh.client.inject` 声明注入 `slots` / `sessions` / `uiWorkspace` 三个客户端接口。

> 1.1.0 为本地开发版本（仅存在于 DSH_HOME/plugins，未发布）。1.2.0 是首次公开版本。
