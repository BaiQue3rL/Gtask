# 本地命令与 MCP 接口

`LocalCommandService` 是桌面 UI、本地 CLI 与 stdio MCP 共用的确定性数据层。它不监听网络端口，不接收登录凭据，也不会绕过数据库事务和手动数据保护。

## 启动

```powershell
node out/main/local-command-cli.js
node out/main/local-mcp-server-cli.js
```

CLI 可从标准输入、`--request-file` 或 UTF-8 Base64 的 `--request-base64` 接收一个 JSON 命令。MCP 测试实例可追加 `--database <路径>`；不指定时使用正式数据路径。

## 常用 MCP 工具

- `describe_gacha_commands`、`read_gacha_checklists`：读取命令边界和清单快照。
- `create_gacha_item`、`update_gacha_item`、`restore_gacha_item`：通用维护写入。
- `archive_gacha_item`、`archive_completed_gacha_section`：需要 `confirm: true` 的破坏性操作。
- `write_gacha_checklists`：高级批量命令入口，仍受确认和系统数据保护。
- `queue_gacha_baseline_maintenance`：为指定游戏和目标排队后台公共基准维护。
- `register_gacha_schedule_agent`、`claim_gacha_schedule_job`：登记本机 Codex 管理端并领取指定维护任务。
- `update_gacha_schedule_job_progress`：提交结构化维护阶段和计数。
- `apply_gacha_public_schedule`：提交版本窗口或公共基准增量。
- `fail_gacha_schedule_job`：明确结束失败任务并保留已有基准。
- `register_gacha_activity_tag`：在有可靠证据时注册可复用的 `custom.*` 玩法标签。

只读资源 `gacha://backups` 返回备份摘要，不返回凭据内容，不提供删除或恢复工具。

## 公共基准维护协议

维护任务仅有 `public_catalog`。MCP 是本机 Codex 专用的管理接口，不向普通用户开放；普通用户只消费发布后的 `updates/catalog.json`。Codex 可以领取后台提示指定的 jobId，也可以在用户直接要求维护时先为明确的游戏/版块排队、再只领取刚返回的 jobId。登记时上报的协议号仅用于诊断，工具 schema 与每个 `job.contract` 才是当前字段和完成条件的权威来源。

维护端先读取 `job.contract`，把目标版块的当前 `matchCandidates` 与持久版本窗口视为已核验基准，对目标版块做完整目录核查，再通过专用工具只提交差异：缺失项新增、字段变化项更新、确认失效项归档。未变化的既有记录不能为了表示“已核查”而重复写入；整个版块无差异时提交空 `items` 并用 `verifiedUnchangedTargets` 标记已完成核查。`verifiedEmptyTargets` 只表示活动版块确实没有任何有效或已公布活动，不能代替“没有变化”。它可以在契约范围内维护活动、周期、地图和版本窗口，但不能：

- 读取凭据、UID、Cookie、Token 或个人接口快照；
- 提交完成状态、挑战记录或探索百分比；
- 修改/删除手动自定义事项和回收站；
- 创建第三层地图或未核验的自由文本结构。

该管理接口用于维护发布基准，不是用户点击“同步进度”的依赖，也不在普通界面显示。

## CLI 示例

```powershell
'{"command":"list_games"}' | node out/main/local-command-cli.js

$json = '{"command":"create_item","item":{"gameId":"genshin","category":"custom","title":"刷角色突破素材"}}'
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
node out/main/local-command-cli.js --request-base64 $encoded
```

写入单项使用 `create_item`、`update_item`、`restore_item`；批量使用 `create_items`、`update_items`。归档命令必须显式传 `confirm: true`。外部进程写入后，桌面端通过 SQLite `data_version` 自动刷新。
