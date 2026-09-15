# Gtask 当前交接

更新：2026-09-15，Asia/Shanghai。这里记录当前工作区；历史发布与安装记录保留在 `history/next-session-through-2026-09-14.md`，不作为当前能力或未完成事项的依据。

## 当前工作

用户要求全功能审计、必要的系统重设计和流程优化，随后设定目标“整个项目优化之后有高可靠、高性能表现，完成后关机”。本轮源代码、回归、性能和隔离打包验收已完成；关机调度的实际结果以 `reliability-performance-goal.md` 末尾为准。不要根据历史记录擅自重复关机。

- 用户已完成本机人工验收，并授权按常用规则增版、提交、推送和发布。本轮源码版本升至 `1.2.0`（兼容新增功能，递增次版本）；数据库 schema 为 `8`，MCP 公共维护契约为 `16`。
- 远程清单消费兼容 v1/v2。当前实际 `updates/catalog.json` 仍为 v1，revision 为 `2026-09-14.zenless-3.2-baseline-maintenance`；没有为了软件审计捏造或发布新的游戏排期。
- 1.2.0 发布准备中；先完成源码与标签发布，确认 Release 附件后再推进在线更新元数据。用户另要求清理本机旧版本：仅清理旧程序、旧安装包及旧测试包，保留个人数据、凭据、数据库备份和研究记录。
- 2026-09-15 18:13 按用户要求，将已验收的最新程序替换至正式安装 `D:\Git\Gtask` 并启动供人工核验。正式数据库由 schema 5 升级至 8，完整性检查通过，自定义清单及登录凭据核对保留。已安装 Codex 插件缓存未另行覆盖；本机仍标识为 1.1.1，不代表线上 1.1.1 已含这些修复。
- 18:26 又按人工验收反馈部署地图修复：沉玉谷特殊汇总零值不再覆盖已确认完成；筛选提升显示的子区带所属地区。实际同步已确认沉玉谷 100% 且仍属于璃月、至冬保持 52%。最新验收、备份与包校验值见 `map-progress-fix-2026-09-15.md`，覆盖下文 18:13 部署的当前包状态。
- 先查看 `git status`，保留原来的 `docs/proposals/baseline-maintenance-v2.md` 和其他研究资料。

## 必须保留的产品边界

Gtask 是 Windows Electron/Vue/TypeScript/SQLite 清单工具，当前包含原神、星铁、绝区零、鸣潮，结构保留扩展能力。公共清单负责结构和时间；个人同步只按唯一匹配回写确定性的完成/进度。不得恢复个人拥有的目录、模型日常复核、逐条模型写入或来源切换。

完成证据三态：明确有记录、明确无记录、未知。未知不覆盖旧进度，手动锁受保护；本期有合格手动挑战记录即完成，不要求满星。地图只有两级，当前个人快照提供的一级值优先于派生平均值。

周期以固定锚点和已发布规则计算，cadence 与 duration 独立。未来例外先保存、到边界生效；同一期校时保留状态，真正换期保存历史并重置。缺时间活动先核验限时资格，满足 v2 例外证据时显示“截止时间待确认”，复核日期不能冒充截止时间。

## 当前标准入口

- `AGENTS.md`：权限、保护范围、工程入口。
- `catalog-maintenance.md`：公共清单的唯一维护流程及 v2 字段用途。
- `sync-architecture-redesign.md`：结构/进度边界、事务、生命周期。
- `ai-map-catalog-maintenance.md`：地图资格、两级层次与稳定键。
- `functional-audit-2026-09-14.md`：第一阶段故障与修复证据。
- `reliability-performance-goal.md`：随后性能优化、维护重设计和最终验收。

旧长篇提案和历史交接不覆盖这些当前标准。安装的旧 Skill 不会自动随工作区更新；使用实时契约判断 MCP 实际能力。

## 已实现的后续优化

- 个人匹配每批建立索引；数据库类别过滤、可见变更计数器与有界快照保留，保护仍被当前条目引用的证据。
- 大清单按视口和实际行高渲染，保留滚动和键盘访问；时钟只在显示边界变化时触发渲染。窄窗口保留版本倒计时。
- 设置和加密凭据原子替换；更新按流限制大小并响应取消；并发清单检查复用一次提交；冷却缓存或进度通知失败不把已提交数据报告成失败。
- 公共修订/退役/回执、规则、未来例外、缺时间复核与清单同事务保存；v5/v7 等迁移、备份恢复和进程骤停都有隔离回归。
- 公共差异编译器保留累计变更及退役，未变化不重发；应用内置和远程都消费 `updates/catalog.json`。历史 TypeScript 种子保留兼容，不再重复维护每个新事实。

## 验证与本机路径

常规：`pnpm test`、`pnpm build`（含类型检查）、`pnpm catalog:check`。`--inventory` 导出隔离公共目录；`--base/--delta/--output` 编译已核验差异。地图额外执行对应专项测试。

性能：设置 `GTASK_PERFORMANCE_TEST=1` 后运行 `tests/performance-benchmark.test.ts`；Electron 脚本是 `scripts/audit-startup-performance.mjs`、`scripts/audit-ui-performance.mjs` 和 `scripts/audit-ui-smoke.mjs`，可用 `--playwright-module` 指定现有运行时。测试数据、截图和打包产物只在各脚本创建的临时目录及仓库 `tmp/`。

正式数据：`D:\Users\Administrator\Documents\Gtask\data\gtask.sqlite`；凭据：`C:\Users\Administrator\AppData\Roaming\gtask\credentials`。不得删除或重建这些数据、备份、发布产物。发布具体新版本仍须用户明确授权，不得将本轮同版本测试包冒充线上升级。

本次人工验收部署备份：`D:\Git\Gtask-backups\20260915-181213`。`program` 为替换前完整程序，`gtask-before-update.sqlite` 为 SQLite 在线备份并通过完整性检查，`userData` 为原设置及加密凭据副本。部署校验 35 个程序文件，安装后 app.asar SHA-256 为 `8ef86cdd5d45859fea7be37d2db8dae293fe0810df9385e9b53b00732aff6ed0`；回执见该备份目录的 `deployment.json`、`pre-deployment.json`、`post-deployment.json`。回退时需要考虑数据库已升级，不能直接让旧程序打开新版数据库；不得擅自覆盖用户人工核验期间新增的数据。
