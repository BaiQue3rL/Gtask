# Gtask 云端基准维护

每个游戏有一个原有 Work Cloud 独立任务，每次新建聊天，GPT-6.2 Sol / Max、Asia/Shanghai。每轮从 GitHub BaiQue3rL/Gtask 最新 main 读取 AGENTS.md、本文件、state.json、updates/catalog.json、本游戏研究及未合并PR，按 sync-gtask-schedules Skill 交付。只研究、修改和改期本游戏，不重置长期状态，不创建本机替代任务。

## 收录和研究时间

- 最新用户要求（2026-11-14）：新增活动须有可靠起止时间，按当前版本半场收录；上半不提前加入下半活动。跨半场仍有效的既有活动继续保留；当前半场稍后开放、时间完整的活动可以收录。时间未知、归属半场未知的候选留在研究，不发布空时间预告占位。旧版deadlineReview仅保留读取兼容。
- 版更日首轮收集固定在北京时间12:00，业务维护起点、预计开服、半场边界和研究执行时间分开保存，不能改写活动时间来迎合任务时刻。半场首轮默认不早于中午且不早于其开始边界，晚于中午的边界向后取整点；如有可靠的延迟开服等情况，Agent在dateTriggers的reviewAt/reviewReason保存本次例外，不机械在停服起点或开服前收尾。
- 已确认差异先发布，不能因少数缺口拖延全部清单。当前范围必要信息未齐时，由Agent根据主要公告、规则与一次独立补查判断下一次有用时间；优先当天稍后，仍无结果可次日补查，不能直接拖到下半。下午14:00–15:00只是常见选择，不是固定轮询。
- followUps 保存本游戏的一次定向补查。targets 确定版块，remoteKeys 列出已知线索。计划带有 `eventNoticesSince` 时，从该时点起核对本游戏国服活动公告列表及增补，翻到已覆盖的记录，打开相关单项规则和图表，并复用已审过的资料。把新发现且符合当前半场的活动一并交付。半场按参与开始时间判定，一张标有「第二期」的海报也可能包含上半已开放的活动。
- 活动核查结束前，判断本半场还有哪一批已知会补发或有依据预计将发布的公告。若现有公告只覆盖前段、单项规则或下一批速递预计会在业务节点前给出本半场内容，按预计发布时间安排一次 events 补查，可以使用空 remoteKeys。来源暂不可读时保留这项义务。已覆盖当前范围且没有这类线索时结束补查。只涉及未来下半的内容留到下半节点。
- 暂缓收录使用同一稳定键的archives并保留公开事实、暂缓原因和恢复条件。满足条件后用同一键明确upsert，真实编译器会撤销该键的累计归档，消费者按更新的公开决定恢复原身份与个人状态；不得将其另起新键或误认成永久取消。

## 日期、计划与交付

1. 先读docs/catalog-maintenance.md、共享维护策略和src/main/published-schedules.ts。地图维护前完整读docs/ai-map-catalog-maintenance.md。由Agent裁决收录、来源和证据充分性，软件只验证格式、归属、身份、覆盖与事务。
2. 使用本游戏官方适用服务器公告维护periods的startsAt/endsAt/firstHalfEndsAt及来源。只有日期时保存dateTriggers；reviewAt是研究时间，不能当官方边界。官方随版本结束的活动采用本游戏适用版本结束基准并记录nominal_maintenance，不因下一版独立维护公告缺失而留空；例外按后续官方纠正更新，不平分版本，不套用其他游戏时间。
3. 定时执行使用 `node automation/cloud-baseline/plan.mjs --game <gameId>`。临近已排时刻时，命令在本轮等到真实时间再输出计划；等待进程完成。version_end 核查新版本当前上半活动、已开放地图、周期定义和排期例外。first_half_end 核查当前下半及仍有效旧项。follow_up 执行 due 的目标、已知线索和公告区间。`--at` 用于历史回放或即时预览。
4. 枚举当前范围并与已有清单逐项比较，复用已核验证据与稳定身份；不能只搜已有标题。必要字段未知保持partial/pending，不写verified_unchanged。原神仅收本体，千星奇域全部保持排除；不因公告渠道或原石奖励改变归属。
5. 研究写入 catalog-research/cloud/<gameId>-<唯一摘要>.json，保存 sources、decisions、pending、auditComplete、announcementReview。活动核查在 announcementReview 的本游戏记录填写 `eventNotices`：since 为实际核查的区间起点，sources 为用于发现新活动的公告列表或完整资料，reason 说明本半场后续公告的覆盖情况。已覆盖时 status 为 covered、nextReviewKey 为 null；仍有本半场缺口时 status 为 follow_up，nextReviewKey 指向本游戏未来的 events 补查，整体标为 partial。用 `--verify-review <研究文件> --game <gameId> --base-ref <本轮开始的main提交>` 按原任务核验。若暂缓活动已合格，用原键恢复。
6. 只允许修改updates/catalog.json、automation/cloud-baseline/state.json和本游戏cloud研究文件；共享数据保留最新main中其他游戏的原样。不能修改软件、版本、标签、Release、权限或个人数据。使用codex/cloud-baseline/<gameId>-<唯一摘要>分支并续接已有PR，发布前重读main合并其他游戏最新数据。
7. 按维护标准使用真实CLI编译累计差异、消费器及必要测试，所有实际head的CI通过后自行合并并读回线上清单。用户已授权范围内研究、发布和动态改期，例行步骤不交回用户。无变化不推动清单修订，不例行发布未变化的周期/版本窗口。

## 更新原云端任务

1. 从真实触发上下文确认原任务ID、timing_mode、last_run_time、时区、启用和新聊天设置。只更新本游戏原ID，不创建替代任务，不把当前聊天绑定为后续运行容器。
2. 交付后从最新 main 运行同一 --game 计划。到期的补查须研究并关闭，或根据新证据续排。遗漏的补查优先于更远的业务节点。若本次定时上下文提前送达，等本次已保存的触发时刻过去，再更新原任务。安排和读回下一次单次触发时保持原任务启用。
3. 更新schedule、default_timezone，显式保持is_enabled=true、新聊天和既有模型；不得改成无限每日恢复规则。立即真实读回并规范为{ id, enabled, timingMode, timeZone, schedule }，与automationId和expected保存后执行 --verify-rearm。UI归一化回执与automations_peek原始响应区分，不用请求冒充回执。
4. 保留本次未修改的模型与新聊天设置；不为重复检查未改字段拖延已完成交付。只有实际保存和读回完成才报告改期成功。权限/登录障碍如实报告；不退回固定轮询，不改其他任务。
5. 普通无变化和正常改期安静结束，只报告实际发布、无法恢复的失败或需要用户处理的事项。

state.json是云端研究调度元数据，不是客户端清单，不读取玩家库，不注册本机服务。
