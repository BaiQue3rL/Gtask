# Gtask

Gtask 是一款 Windows 桌面端多游戏任务与进度管理器，当前内置支持原神、崩坏：星穹铁道、绝区零和鸣潮，架构可继续扩展其他游戏。

## 核心能力

- 首次启动直接显示活动、周期挑战、地图探索和版本剩余时间，无开屏配置门槛。
- 内置持续维护的公共基准表；无账号数据的版块也能作为完整清单使用。
- 米游社与库街区应用内登录，支持按版块手动“同步进度”。
- 可在设置中按游戏开启或关闭启动自动同步；每次启动每款游戏最多自动同步一轮。
- 官方个人接口只更新基准表的完成状态和探索进度，不改标题、时间、标签或地图层级。
- 活动、周期和地图结构为只读；用户仍可维护完成状态。自定义版块保留新增、编辑、删除和回收站。
- SQLite 本地存储、DPAPI 加密凭据、每日/迁移前/恢复前/手动备份和安全恢复。
- 后台 MCP 可维护已验证基准表，不是普通用户使用软件的前置条件。

## 技术栈

Electron + Vue 3 + TypeScript + SQLite（Node 内置 `node:sqlite`）。清单数据默认只保存在本机。

## 本地开发

需要 Node.js 24+ 和 pnpm 11+。

```powershell
pnpm install
pnpm dev
```

常用验证与构建：

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm package:dir
pnpm package:portable
pnpm package:installer
```

正式 Windows 安装包使用 NSIS；`package:dir` 可生成不经过安装器的解包目录。

## 本地数据

首次启动后，应用在 Windows 系统“文档”目录下创建：

- `GachaTaskManager/data/gacha-task-manager.sqlite`
- `GachaTaskManager/backups`
- `GachaTaskManager/logs`

凭据独立保存在当前 Windows 用户的应用数据目录，并由 DPAPI 加密。备份轮换规则见 [数据模型](docs/data-model.md)。

## 维护接口

构建后的本地命令行和 stdio MCP 不监听网络端口：

```powershell
'{"command":"get_game_snapshot","gameId":"genshin","completed":false}' |
  node out/main/local-command-cli.js

node out/main/local-mcp-server-cli.js
```

接口与保护边界见 [本地命令接口](docs/local-command-api.md)，同步架构见 [同步架构基准](docs/sync-architecture-redesign.md)。
