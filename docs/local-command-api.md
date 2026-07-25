# 本地命令接口

`LocalCommandService` 是桌面 UI、正式 MCP server 与本地 CLI 共用的确定性读写层。它不联网、不接收登录凭据，也不会绕过主进程参数校验。

现在同时提供正式的本地 stdio MCP server。构建后可由 MCP 客户端以 Node 24+ 启动：

```powershell
node out/main/local-mcp-server-cli.js
```

测试数据库可追加 `--database <路径>`。服务公开以下工具：

- `describe_gacha_commands`：读取支持范围与安全约束。
- `read_gacha_checklists`：读取一款或全部四款游戏的清单快照。
- `create_gacha_item`、`update_gacha_item`、`restore_gacha_item`：带明确字段结构的常用写入操作。
- `archive_gacha_item`、`archive_completed_gacha_section`：软删除操作，均要求 `confirm: true`。
- `write_gacha_checklists`：用于批量写入等高级命令的通用入口；同样不会绕过确认保护。
- `register_gacha_schedule_agent`：登记具备联网搜索能力的 AI Agent，并刷新五分钟有效的连接心跳。
- `claim_gacha_schedule_job`：领取用户点击“同步清单”后创建的公开资料任务。
- `update_gacha_schedule_job_progress`：把检索、交叉核验、结构化、重试与写入阶段及当前/总数实时回传桌面端。
- `apply_gacha_public_schedule`：提交交叉验证后的结构化排期，并通过同步合并器写入。
- `fail_gacha_schedule_job`：报告检索失败，保留已有清单和上次成功数据。

服务还公开只读资源 `gacha://backups`，列出最近备份的文件名、类型、大小和更新时间。资源不包含凭据内容，也不提供删除或数据库恢复操作。

MCP 采用本地 stdio，不监听网络端口。Windows GUI 可执行文件不直接承载 stdio；客户端应启动上述独立 Node 入口。
CLI 与 MCP 在打开旧版磁盘数据库时会先创建迁移前一致性备份，与桌面端使用同一安全升级原则。

## AI 公开资料任务协议

“同步清单”在以下任一条件满足时启用：最近五分钟内有 Agent 调用 `register_gacha_schedule_agent`，或本机已经安装并启用 `gacha-task-manager@personal` Codex 插件。点击同步后，桌面端会自动启动非交互 Codex CLI 并调用 `$sync-gacha-schedules` 领取任务，无需用户打开 Codex 或手动发送消息。Agent 按以下顺序工作：

1. 登记心跳并声明 `webSearch: true`。
2. 轮询 `claim_gacha_schedule_job`；无任务时返回 `null`。
3. 按任务中的游戏联网搜索并交叉验证来源。
4. 调用 `apply_gacha_public_schedule` 提交 1～200 条排期及 1～20 条证据，或调用失败工具结束任务。

专用提交工具只允许限时活动、周常和深渊/挑战排期字段，常驻活动继续只由用户手动维护。接口不接受完成状态、探索度、删除操作或凭据。每个标题必须包含中文，并通过 `titleSourceUrl` 指向同批 `language: zh-CN` 证据；纯英文标题和未经中文来源核对的 AI 翻译会拒绝整批数据。其余重复 `remoteKey`、非法时间窗或未知字段同样会拒绝整批数据。

## Codex 插件实测

2026-07-21 已在本机安装个人插件 `gacha-task-manager@personal`，插件内含 `sync-gacha-schedules` 技能和同名 MCP 配置。一次真实流程已完成：

1. 桌面端点击“同步清单”创建公开资料任务。
2. Codex 登记 Agent 并领取同一任务。
3. Codex 持续回传当前阶段和计数，再联网检索官方资料并交叉验证来源。
4. 专用 MCP 工具向原神清单新增 4 条排期，桌面端约 2 秒后自动显示成功。

随后新版中文证据协议又完成两次真实验证：星铁新增 9 条中文排期；原神 4 条既有英文排期在不改变 `remoteKey` 和时间窗的情况下原位更新为中文正式名称。后一次快路径只补充搜索 1 次，MCP 合并结果为新增 0、更新 4。

Codex 对写入型 MCP 工具保留用户批准边界。正式插件不使用全局免审批参数。

不使用 MCP 时，也可以从标准输入传入单个 JSON 命令：

```powershell
'{"command":"list_games"}' | node out/main/local-command-cli.js
```

默认数据库为 `%APPDATA%\gacha-task-manager\data\gacha-task-manager.sqlite`。测试时可显式指定：

```powershell
'{"command":"list_games"}' | node out/main/local-command-cli.js --database ':memory:'
```

Windows PowerShell 5.1 向原生进程传递管道文本时可能损坏中文。含中文的命令推荐使用 UTF-8 Base64：

```powershell
$json = '{"command":"create_item","item":{"gameId":"genshin","category":"custom","title":"刷角色突破素材"}}'
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
node out/main/local-command-cli.js --request-base64 $encoded
```

也可把 JSON 保存为 UTF-8 文件后使用 `--request-file <路径>`。PowerShell 7 的 UTF-8 管道可继续使用标准输入。

## 读取命令

调用方可先读取支持范围、命令列表和破坏性命令：

```json
{"command":"describe_commands"}
```

```json
{"command":"list_games"}
```

一次读取四款游戏的活动清单、周期、探索、自定义事项和同步状态：

```json
{"command":"get_all_snapshots","includeArchived":false}
```

```json
{
  "command": "get_game_snapshot",
  "gameId": "genshin",
  "category": "weekly",
  "completed": false,
  "includeArchived": false
}
```

`category`、`completed` 和 `includeArchived` 均可省略。快照同时返回该游戏同步模式和最近状态。

## 写入命令

新增与界面使用同一字段和校验：

```json
{
  "command": "create_item",
  "item": {
    "gameId": "genshin",
    "category": "custom",
    "title": "刷角色突破素材"
  }
}
```

批量新增和批量更新分别使用 `create_items`、`update_items`，把单项命令的 `item` 改为 `items` 数组。每批限制 1～100 项；整批先校验并在一个事务中写入，任一项失败则全部回滚。

```json
{
  "command": "update_item",
  "item": {
    "id": "事项 ID",
    "completed": true
  }
}
```

恢复不属于破坏性操作：

```json
{"command":"restore_item","id":"事项 ID"}
```

## 删除确认

软删除和版块批量删除必须显式传入 `confirm: true`，否则命令拒绝执行：

```json
{"command":"archive_item","id":"事项 ID","confirm":true}
```

```json
{"command":"archive_items","ids":["事项 ID 1","事项 ID 2"],"confirm":true}
```

```json
{
  "command": "archive_completed_section",
  "gameId": "genshin",
  "section": "events",
  "confirm": true
}
```

有效版块为 `tasks`、`events`、`cycles`、`exploration`、`custom`。所有删除都是软删除，可从回收站恢复。

CLI 在另一个进程提交写入后，运行中的桌面端通过 SQLite `data_version` 检测变化并自动刷新，不需要开放本地 HTTP 端口。
