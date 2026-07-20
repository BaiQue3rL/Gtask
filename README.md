# 幻游清单

Windows 桌面端多二游任务管理器，当前固定支持：

- 原神
- 崩坏：星穹铁道
- 绝区零
- 鸣潮

## 技术栈

Electron + Vue 3 + TypeScript + SQLite（Node 内置 `node:sqlite`）。所有清单数据默认只保存在本机。

## 本地开发

需要 Node.js 24+ 和 pnpm 11+。

```powershell
pnpm install
pnpm dev
```

常用检查与构建：

```powershell
pnpm typecheck
pnpm build
pnpm package:portable
```

构建后可通过标准输入调用本地 JSON 命令接口：

```powershell
'{"command":"get_game_snapshot","gameId":"genshin","completed":false}' |
  node out/main/local-command-cli.js
```

命令格式和安全约束见 [本地命令接口](docs/local-command-api.md)。
同步来源、公开排期文档与个人数据边界见 [同步适配器设计](docs/sync-adapters.md)。

开发版首次启动后会在 Electron 的 `userData/data` 目录创建 `gacha-task-manager.sqlite`。

## 当前进度

- Electron 主进程和安全预加载桥接
- Vue 3 清单总览和事项编辑弹窗
- SQLite v1～v6 迁移及四款游戏种子数据
- 手动事项新增、编辑、完成状态切换、软删除、版块批量删除与回收站恢复
- 主线/支线默认状态项，不记录具体剧情任务
- 周常/挑战周期、实时倒计时、地图层级与探索百分比
- 每游戏手动/自动同步设置和安全事务合并框架
- 本地 AI 命令服务、外部写入自动刷新和每日一致性备份
- Windows DPAPI 凭据保险箱底座和一键清除入口
- 主进程 IPC 参数校验、类型检查与自动化测试
- 便携版构建配置
