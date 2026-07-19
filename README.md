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

开发版首次启动后会在 Electron 的 `userData/data` 目录创建 `gacha-task-manager.sqlite`。

## 当前进度

- Electron 主进程和安全预加载桥接
- Vue 3 清单总览和事项编辑弹窗
- SQLite 初始表结构、版本迁移及四款游戏种子数据
- 手动事项新增、编辑、完成状态切换和软删除
- 主线/支线默认状态项，不记录具体剧情任务
- 手动完成锁和本周完成时间记录
- 主进程 IPC 参数校验与数据库自动化测试
- 便携版构建配置
