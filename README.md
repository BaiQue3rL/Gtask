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
pnpm release:verify
```

构建后可通过标准输入调用本地 JSON 命令接口：

```powershell
'{"command":"get_game_snapshot","gameId":"genshin","completed":false}' |
  node out/main/local-command-cli.js
```

命令格式和安全约束见 [本地命令接口](docs/local-command-api.md)。
同步来源、公开排期文档与个人数据边界见 [同步适配器设计](docs/sync-adapters.md)。
当前可执行的人工验收步骤见 [阶段验收清单](docs/stage-acceptance.md)。

构建后的本地 MCP server 使用 stdio，不开放网络端口：

```powershell
pnpm local:mcp
```

开发版首次启动后会在 Electron 的 `userData/data` 目录创建 `gacha-task-manager.sqlite`。

本机通用开发依赖和缓存统一放在英文路径
`D:\Users\Administrator\Documents\Codex Project\dev-dependencies`，当前 pnpm store 位于其
`pnpm-store` 子目录，避免盘符根目录散落缓存或工具不兼容中文路径。

## 当前进度

- Electron 主进程和安全预加载桥接
- Vue 3 清单总览和事项编辑弹窗
- SQLite v1～v9 迁移；新用户四款游戏均只预置主线/支线两个固定状态项
- 手动事项新增、编辑、完成状态切换、软删除、版块批量删除与回收站恢复
- 主线/支线默认状态项，不记录具体剧情任务
- 周常/挑战周期、实时倒计时、地图层级与探索百分比
- 版块独立同步、公开地图增量目录和本地周期自动轮转
- 官方排期图片本地中文 OCR、来源时区转换、可编辑预览与确认后安全写入；图片不上传、不持久化
- 每游戏手动/自动同步设置、安全事务合并框架，以及公开排期 AI Agent 心跳、任务队列和专用 MCP 回写协议
- 已验收的 Codex 个人插件与排期技能，可在应用内先排队并打开 Codex，联网核验后通过 MCP 回写清单
- 可选 DeepSeek V4 Flash 结构化整理器，API 密钥仅由 Windows DPAPI 加密保存
- 本地 AI 命令服务、stdio MCP、外部写入自动刷新，以及每日/升级前/手动一致性备份、安全恢复与每日备份轮换
- Windows DPAPI 凭据保险箱底座和一键清除入口
- 主进程 IPC 参数校验、类型检查与自动化测试
- 品牌应用图标和便携版构建配置
- 113 项自动化测试、真实 Windows 窗口与单文件便携版恢复重启冒烟测试
