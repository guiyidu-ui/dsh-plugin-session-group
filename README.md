# dsh-plugin-session-group

> DeepSeek Harness (DSH) Web 侧边栏会话列表**按项目(cwd)分组**显示插件。

把 DSH Web GUI 左侧的会话列表按**工作目录（cwd）**聚合成可折叠的项目分组树，让"按项目"组织会话。支持**分组 / 原始**双模式一键切换：分组模式接管内置 `sidebar.workspaces` 槽位，原始模式让位给 DSH 默认列表。

**纯客户端插件**：全部逻辑在浏览器 bundle（`lib/client.js`），宿主半边（`lib/index.js`）是空壳——**零宿主路由、零服务端、零依赖**，不会往 DSH_HOME 写任何数据。

## 特性

- 📁 按项目(cwd)分组的会话树，可折叠/展开
- 🔄 分组模式 ↔ 原始模式切换（原始模式 = DSH 内置列表原样）
- 🧩 接管 `sidebar.workspaces` 客户端槽位，无需改 DSH 核心
- ⚡ 纯客户端、零宿主路由、零 `dependencies`
- 🔒 不持久化任何会话/用户数据到磁盘

## 安装

DSH 插件目录（`$DSH_HOME/plugins/<name>`）需要的是**插件目录本身**，不是 npm 包。本仓库按插件目录结构组织，直接 clone 到 plugins 下即可：

```powershell
# 1. 克隆到 DSH_HOME 的 plugins 目录
git clone https://github.com/guiyidu-ui/dsh-plugin-session-group.git "$DSH_HOME\plugins\session-group"

# 2. 建 junction（让 profile 的 node_modules 能找到它）
#    Windows:
mklink /J "$DSH_HOME\profiles\web\node_modules\dsh-plugin-session-group" "$DSH_HOME\plugins\session-group"

# 3. 在 profiles\web\cordis.patch.yml 追加插件注入（若尚未登记）
#    - insert:
#        - id: dsh-plugin-session-group
#          name: session-group

# 4. 重启 web 宿主（改插件集需重启才生效）
```

> 若你的 DSH 版本已支持 `dsh plugin add <本地目录>`，可用该命令替代手动 junction。具体以你的 DSH 版本的插件加载机制为准。

## 使用

安装并重启宿主后，Web GUI 左侧边栏的会话列表会按项目分组显示。列表头部有切换按钮：

- **分组模式**（默认）：按 cwd 聚合，每个项目一个可折叠分组。
- **原始模式**：还原为 DSH 内置的扁平会话列表。

## 架构

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半边，**故意留空**（纯客户端插件，无宿主路由/服务） |
| `lib/client.js` | 浏览器 bundle，实现分组树 UI 与模式切换，shadow 内置 `sidebar.workspaces` 槽位 |
| `package.json` | 插件元数据（`dsh.client.inject` 声明注入 `slots`/`sessions`/`uiWorkspace`） |

客户端注入声明（`package.json` 的 `dsh.client` 字段）：

```json
{
  "dsh": {
    "engines": { "dsh": ">=0.1.2-alpha.4" },
    "client": {
      "platform": "web",
      "inject": ["slots", "sessions", "uiWorkspace"]
    }
  }
}
```

- `platform: web` —— 仅 Web GUI 生效（headless/CLI 不受影响）。
- `inject: ["slots", "sessions", "uiWorkspace"]` —— 向客户端注入槽位、会话列表、工作区 UI 三个能力。

## 兼容性

- DSH `>= 0.1.2-alpha.4`（在 0.1.5-rc.1 上验证通过）。
- 依赖 DSH 客户端的 `dsh-client-modules` 自动跳过无 `dsh.client` 字段的纯宿主插件——本插件带 `dsh.client` 字段，会被正常加载。

## 许可

[MIT](./LICENSE) © 2026 guiyidu-ui

## 版本历史

见 [CHANGELOG.md](./CHANGELOG.md)。当前版本 **1.2.0**。
