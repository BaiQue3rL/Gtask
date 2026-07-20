# 本地命令接口

`LocalCommandService` 是桌面 UI、未来 MCP server 与本地 CLI 共用的确定性读写层。它不联网、不接收登录凭据，也不会绕过主进程参数校验。

构建后从标准输入传入单个 JSON 命令：

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
