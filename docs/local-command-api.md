# 本地命令与 MCP 接口

`LocalCommandService` 是桌面 UI、本地 CLI 与 stdio MCP 共用的确定性数据层。它不监听网络端口，不接收登录凭据，也不会绕过数据库事务和手动数据保护。MCP 的通用命令能力是本机 Codex 管理员的授权能力；它与严格的公共基准维护模式分开使用。

## 启动

```powershell
node out/main/local-command-cli.js
node out/main/local-mcp-server-cli.js
```

CLI 可从标准输入、`--request-file` 或 UTF-8 Base64 的 `--request-base64` 接收一个 JSON 命令。MCP 测试实例可追加 `--database <路径>`；不指定时使用正式数据路径。

## 常用 MCP 工具

- `describe_gtask_commands`、`read_gtask_checklists`：读取命令边界和清单快照。
- `create_gtask_item`、`update_gtask_item`、`restore_gtask_item`：软件维护模式下的通用维护写入；不属于基准维护的标准写入路径。
- `archive_gtask_item`、`archive_completed_gtask_section`：需要 `confirm: true` 的破坏性操作。
- `write_gtask_checklists`：软件维护模式下的高级批量命令入口，仍受确认和系统数据保护。
- `queue_gtask_baseline_maintenance`：传 `agentId` 时原子创建并领取指定范围；省略时仅排队给后台。已存在相同任务时返回实际归属，不重复创建。
- `register_gtask_schedule_agent`、`claim_gtask_schedule_job`：登记本机 Codex 管理端并领取指定维护任务。
- `get_gtask_schedule_job`：只读小摘要，查询不领取、续租或回队；`includeResearch` 返回已保存裁决。终态与 `auditComplete` 分开报告。
- `update_gtask_schedule_job_progress`：提交阶段、计数及 `researchDecisions`；默认返回摘要，`compact=false` 返回完整任务。
- `apply_gtask_public_schedule`：提交版本窗口或公共基准增量。
- `fail_gtask_schedule_job`：明确结束失败任务并保留已有基准。
- `register_gtask_activity_tag`：在有可靠证据时注册可复用的 `custom.*` 玩法标签。

只读资源 `gtask://backups` 返回备份摘要，不返回凭据内容，不提供删除或恢复工具。

## 工作模式与授权

MCP 有两种明确使用场景：

- **基准维护模式：** 由 `sync-gtask-schedules` Skill 驱动，只使用排队、领取、进度、公开资料提交和失败结束等维护工具。个人同步只提供脱敏观察，应用只写个人进度。
- **软件维护模式：** 用户明确要求修复或维护软件时，Codex 作为本机管理员可以使用通用读写命令、仓库工具和部署工具。该模式不改变普通用户没有 MCP 入口的事实，也不把通用命令变成个人同步或基准维护的隐式链路。

任务开始时必须明确当前模式；基准维护任务不得为了绕过资料契约而切换到软件维护模式。

## 公共基准维护协议

在基准维护模式下，维护任务仅有 `public_catalog`。MCP 是本机 Codex 专用的管理接口，不向普通用户开放；普通用户只消费发布后的 `updates/catalog.json`。后台提示精确领取指定 jobId；直接请求在排队时传入已登记 agentId，在同一事务内创建和领取。仅 claimed/resumed 可写入，其他结果用只读查询或按终态结束。登记时上报的协议号仅用于诊断，工具 schema 与每个 `job.contract` 才是字段和完成条件的权威来源。

每个任务附带 `contract.maintenancePolicy`，后台启动提示使用同一策略源，不依赖应用数据目录中是否存在项目 AGENTS.md。旧技能副本不能覆盖实时契约的新能力。错误结果包含 `isError` 和 `structuredContent.error.message`；应先检查 isError，不能对错误文案执行 JSON.parse。

`researchDecisions` 使用 target/key 定位公开事实，记录 resolved/pending/excluded、previousValue、adoptedValue、timeBasis、reason 和 sources（URL、官方发布时间、原文）。重试和续接保留记录；重开需要新证据，或 correctionReason 明确说明旧解读/结构化错误或用户纠正。程序只验证记录及归属，不判断哪份公告正确。待核实事项不阻断已确认增量的保存，但不能声明该范围无变化；完成摘要的 auditComplete 为 false，未覆盖保持 stale/partial。旧任务没有完整审计回执时 auditComplete 为 null，不补造成功。

维护端先读取 `job.contract`，把目标版块的当前 `matchCandidates` 与持久版本窗口视为已核验基准，对目标版块做完整目录核查，再通过专用工具只提交差异：缺失项新增、字段变化项更新、确认失效项归档。未变化的既有记录不能为了表示“已核查”而重复写入；整个版块无差异时提交空 `items` 并用 `verifiedUnchangedTargets` 标记已完成核查。`verifiedEmptyTargets` 只表示活动版块确实没有任何有效或已公布活动，不能代替“没有变化”。它可以在契约范围内维护活动、周期、地图和版本窗口，但不能：

- 读取凭据、UID、Cookie、Token 或个人接口快照；
- 提交完成状态、挑战记录或探索百分比；
- 修改/删除手动自定义事项和回收站；
- 创建第三层地图或未核验的自由文本结构。

该管理接口用于维护发布基准，不是用户点击“同步进度”的依赖，也不在普通界面显示。软件维护模式的通用 MCP 命令另行受用户任务授权约束。

## CLI 示例

```powershell
'{"command":"list_games"}' | node out/main/local-command-cli.js

$json = '{"command":"create_item","item":{"gameId":"genshin","category":"custom","title":"刷角色突破素材"}}'
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
node out/main/local-command-cli.js --request-base64 $encoded
```

写入单项使用 `create_item`、`update_item`、`restore_item`；批量使用 `create_items`、`update_items`。归档命令必须显式传 `confirm: true`。外部进程写入后，桌面端通过 SQLite `data_version` 自动刷新。
