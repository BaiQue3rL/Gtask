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
同步来源、公开资料文档与个人数据边界见 [同步适配器设计](docs/sync-adapters.md)。
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
- SQLite v1～v12 迁移；新用户四款游戏均只预置主线/支线两个固定状态项
- 手动事项新增、编辑、完成状态切换、软删除、版块批量删除与回收站恢复
- 主线/支线默认状态项，不记录具体剧情任务
- 周常/挑战周期、实时倒计时、地图层级与探索百分比
- 版块独立同步、公开地图增量目录和周常每周一自动重置；挑战玩法按每期独立记录
- 离线时完整支持手动新增和编辑；不再使用容易误识别名称、分类与时间的本地 OCR
- “同步清单 / 同步进度”独立动作、安全事务合并框架，以及公开资料 AI Agent 心跳、任务队列和专用 MCP 回写协议
- 已验收的 Codex 个人插件、排期技能与本地后台启动器；点击同步会自动启动 Codex CLI，四游戏可由最多四个独立 Worker 并行核验并通过 MCP 回写清单
- 同步过程实时展示当前阶段、接口/资料计数、人工验证、真实重试次数和最后更新时间；Codex 接单后不再停留在笼统的排队提示
- 同步架构遵循“确定性本地处理、语义判断交给 Codex”：软件只直接处理可证明准确的机械规则，未知名称、分类、状态和自然语言时间不得猜测写入
- 脱敏语义核验队列与专用 MCP 领取/通过/拒绝协议；候选在 Codex 高置信核验前不会进入正式清单
- 首次使用可由设置页生成应用自带的本地 Codex 市场安装页；MCP 由当前 exe 直接启动，不依赖开发机 Node 路径
- 联网公开资料统一由 Codex 插件检索并通过 MCP 安全回写；不再提供不能独立联网的普通聊天 API
- 本地 AI 命令服务、stdio MCP、外部写入自动刷新，以及每日/升级前/手动一致性备份、安全恢复与每日备份轮换
- Windows DPAPI 凭据保险箱底座和一键清除入口
- 主进程 IPC 参数校验、类型检查与自动化测试
- 品牌应用图标和便携版构建配置
- 125 项自动化测试、真实 Windows 窗口、打包后 MCP 启动与单文件便携版恢复重启冒烟测试
