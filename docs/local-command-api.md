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

MCP 采用本地 stdio，不监听网络端口。Windows GUI 可执行文件不直接承载 stdio；客户端应启动上述独立 Node 入口。

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
