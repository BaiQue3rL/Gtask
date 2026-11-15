# Gtask 云端基准维护

每个游戏有一个原有 Work Cloud 独立任务，每次新建聊天，GPT-6.1 Sol / Max、Asia/Shanghai。每轮从 GitHub BaiQue3rL/Gtask 最新 main 读取 AGENTS.md、本文件、state.json、updates/catalog.json、本游戏研究及未合并PR，按 sync-gtask-schedules Skill 交付。只研究、修改和改期本游戏，不重置长期状态，不创建本机替代任务。

## 收录和研究时间

- 最新用户要求（2026-11-14）：新增活动须有可靠起止时间，按当前版本半场收录；上半不提前加入下半活动。跨半场仍有效的既有活动继续保留；当前半场稍后开放、时间完整的活动可以收录。时间未知、归属半场未知的候选留在研究，不发布空时间预告占位。旧版deadlineReview仅保留读取兼容。
- 版更日首轮收集固定在北京时间12:00，业务维护起点、预计开服、半场边界和研究执行时间分开保存，不能改写活动时间来迎合任务时刻。半场首轮默认不早于中午且不早于其开始边界，晚于中午的边界向后取整点；如有可靠的延迟开服等情况，Agent在dateTriggers的reviewAt/reviewReason保存本次例外，不机械在停服起点或开服前收尾。
- 已确认差异先发布，不能因少数缺口拖延全部清单。当前范围必要信息未齐时，由Agent根据主要公告、规则与一次独立补查判断下一次有用时间；优先当天稍后，仍无结果可次日补查，不能直接拖到下半。下午14:00–15:00只是常见选择，不是固定轮询。
- followUps保存一次有理由的定向补查。每条包含gameId、稳定key、targets、remoteKeys（空数组表示该目标范围）、checkedAt、reviewAt、reason、sources；不要求待研究事项已经进入清单。到时只核对指定目标，不恢复旧的全版块pending。查齐后移除；仍未齐就更新具体缺口、查过的来源和下一次估计，并实际重排原任务。已确认属于未来下半的候选留到下半节点，不为它提前唤醒。
- 暂缓收录使用同一稳定键的archives并保留公开事实、暂缓原因和恢复条件。满足条件后用同一键明确upsert，真实编译器会撤销该键的累计归档，消费者按更新的公开决定恢复原身份与个人状态；不得将其另起新键或误认成永久取消。

## 日期、计划与交付

1. 先读docs/catalog-maintenance.md、共享维护策略和src/main/published-schedules.ts。地图维护前完整读docs/ai-map-catalog-maintenance.md。由Agent裁决收录、来源和证据充分性，软件只验证格式、归属、身份、覆盖与事务。
2. 使用本游戏官方适用服务器公告维护periods的startsAt/endsAt/firstHalfEndsAt及来源。只有日期时保存dateTriggers；reviewAt是研究时间，不能当官方边界。官方随版本结束的活动采用本游戏适用版本结束基准并记录nominal_maintenance，不因下一版独立维护公告缺失而留空；例外按后续官方纠正更新，不平分版本，不套用其他游戏时间。
3. 所有计划使用node automation/cloud-baseline/plan.mjs --game <gameId>。version_end核查新版本当前上半活动、已开放地图、周期定义和排期例外；first_half_end核查当前下半新增内容及仍有效旧项；follow_up只处理due指定目标和事项。普通日期无due时只校验和改期，不扩为全游戏或全版块维护。
4. 枚举当前范围并与已有清单逐项比较，复用已核验证据与稳定身份；不能只搜已有标题。必要字段未知保持partial/pending，不写verified_unchanged。原神仅收本体，千星奇域全部保持排除；不因公告渠道或原石奖励改变归属。
5. 研究写入catalog-research/cloud/<gameId>-<唯一摘要>.json，保留sources、decisions、pending、auditComplete、announcementReview；当前只有一个gameId。若存在暂缓活动，读取其已有研究，核实当前半场和完整时间后明确恢复，不重复建项。
6. 只允许修改updates/catalog.json、automation/cloud-baseline/state.json和本游戏cloud研究文件；共享数据保留最新main中其他游戏的原样。不能修改软件、版本、标签、Release、权限或个人数据。使用codex/cloud-baseline/<gameId>-<唯一摘要>分支并续接已有PR，发布前重读main合并其他游戏最新数据。
7. 按维护标准使用真实CLI编译累计差异、消费器及必要测试，所有实际head的CI通过后自行合并并读回线上清单。用户已授权范围内研究、发布和动态改期，例行步骤不交回用户。无变化不推动清单修订，不例行发布未变化的周期/版本窗口。

## 更新原云端任务

1. 从真实触发上下文确认原任务ID、timing_mode、last_run_time、时区、启用和新聊天设置。只更新本游戏原ID，不创建替代任务，不把当前聊天绑定为后续运行容器。
2. 交付后从最新main运行同一 --game 计划；需要时传 --last-run 与 --timing-mode。按最近的未来首轮或followUps选择单次rearm.schedule，平台一小时限制可使补查跨日，不丢弃同一义务。
3. 更新schedule、default_timezone，显式保持is_enabled=true、新聊天和既有模型；不得改成无限每日恢复规则。立即真实读回并规范为{ id, enabled, timingMode, timeZone, schedule }，与automationId和expected保存后执行 --verify-rearm。UI归一化回执与automations_peek原始响应区分，不用请求冒充回执。
4. 保留本次未修改的模型与新聊天设置；不为重复检查未改字段拖延已完成交付。只有实际保存和读回完成才报告改期成功。权限/登录障碍如实报告；不退回固定轮询，不改其他任务。
5. 普通无变化和正常改期安静结束，只报告实际发布、无法恢复的失败或需要用户处理的事项。

state.json是云端研究调度元数据，不是客户端清单，不读取玩家库，不注册本机服务。
