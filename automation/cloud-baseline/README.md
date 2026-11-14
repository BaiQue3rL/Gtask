# Gtask 云端基准维护

本流程按游戏独立运行。原神（genshin）、星穹铁道（star-rail）、绝区零（zenless）、鸣潮（wuthering-waves）各有一个 Work Cloud 独立任务，每次触发新建聊天，使用 GPT-6.1 Sol / Max、Asia/Shanghai。每轮只寻找、核验和维护指定游戏的新内容，并依据查到的日期调整该游戏任务自己的下一次触发时间。

## 触发与范围

- 全范围自动维护在该游戏的版更当天或下半场开始当天执行，沿用 version_end / first_half_end 稳定标识。额外允许 `activityTimeReviews` 指定的活动时间复查：由 Agent 估计何时可以取得时间，只复查指定活动。不同游戏各自触发，不启动跨游戏全量维护。
- 清单完整优先于时间准确（用户纠正，2026-11-14）。已确认存在且符合范围的活动立即入清单；起止未知留空并保存 deadlineReview，不把已知活动拖到下半场。根据预计公告可获得时间安排一次定向复查，仍未知则保留条目、更新缺口和下一次估计。不建立固定每日/每周轮询；运行租约、CI 排队及一般网络失败不自动产生复查日期。
- 每轮从 GitHub BaiQue3rL/Gtask 的 main 读取最新本文件、state.json、清单、该游戏研究记录及未合并 PR。仓库保存长期状态；不依赖历次运行聊天，不重置 activatedAt、成功节点或未完成记录。
- 每个任务固定一个 gameId；云端所有规划命令必须传 --game <gameId>。不带 --game 的总览仅供管理员和 CI 检查，不能作为云端任务的执行计划。不得查询其他游戏的新公告、维护其他游戏的数据或调整其他游戏任务。
- 只允许修改 updates/catalog.json、automation/cloud-baseline/state.json 和 catalog-research/cloud/<文件名>.json。共享文件中也只能改变本游戏的数据；清单 revision / publishedAt 可随本游戏发布更新。不能修改软件、版本、标签、Release、权限、个人数据或本目录执行代码。
- 用户已授权在上述范围内研究、编译、创建 PR、等待 CI、合并、核验线上清单和动态调整当前任务；例行步骤不等待人工确认。使用已有 GitHub 和云端调度权限，不建立本地替代任务。

## 本游戏的日期与规划

1. 读取 docs/catalog-maintenance.md、src/main/ai/baseline-maintenance-policy.ts、src/main/published-schedules.ts；地图维护前完整读取 docs/ai-map-catalog-maintenance.md。事实、收录、分类和证据是否充分由 Agent 判断；程序只验证数据、权限、身份、覆盖和事务。
2. 核查本游戏当前及下一版本的适用服务器公告。periods 的 startsAt / endsAt / firstHalfEndsAt 分别记录有依据的排期时间和来源。已有版更日期时，Agent 可结合该游戏适用服务器、时区的稳定停服时刻；没有单独日期时可沿用已发布的版本周期与锚点，在研究记录标为 nominal_maintenance 并保留推算依据。官方明确随版本结束的活动采用同一基准，不能仅因下一版精确维护公告未发布而留作截止待确认。后续官方例外优先；确无适用基准的字段才保留 null。不能统一加 21 天、平分版本，或用单个活动到期日、每日重置和另一游戏的时刻推算版更。
3. 官方只公布日期时，在 dateTriggers 保存 gameId、periodKey、node、date（YYYY-MM-DD）、sources、checkedAt。规划器在当天 11:00 安排任务；11:00 只是运行时间，不写成官方版更或活动时刻。至少一个精确节点或有来源的日期即可建档，不因时分未知而漏排已确认的日期。
4. 官方缩短、延长或更正时修订同一 gameId/periodKey 对应字段，保存旧值、新值、适用来源、发布时间、采用理由与精度；不能机械修改其他边界。稳定节点已成功就不重复执行。预测不能冒充已公布事实。
5. 执行 node automation/cloud-baseline/plan.mjs --game <gameId>。due、upcoming、deferred、nextWake 均限定该游戏。常规节点只在该节点日执行；`activity_time_review` 到估计日期时只核对其 remoteKey 列出的活动时间，不顺带执行历史全范围 pending。
6. 提前几分钟启动时，可在当前运行内等到节点或复查时间（每次不超过 60 秒）。没有到期节点或活动复查时，只校验配置并重排，不提前发布、不增加普通轮询。
7. 维护过程中核验本游戏下一个版更/下半场日期，交付后从最新 main 重新计算下一次时间。下一日期仍未知时如实保留缺口并报告一次，不能凭空建立每日补查；其他游戏按各自任务继续运行。

## 实际云端改期

1. 从本次触发上下文和真实任务设置确认当前任务 ID、timing_mode、last_run_time、时区、启用状态及新聊天模式。每个游戏只更新自己的原 ID，不更新其他任务，不将当前运行聊天绑定为后续运行容器。
2. 运行 node automation/cloud-baseline/plan.mjs --game <gameId> --timing-mode <实际模式>；有 last_run_time 时传 --last-run <带时区时间>。保存真实输出到仓库外。rearm 选择该游戏最近的未来常规节点或活动时间复查，遵守平台一小时间隔；常规节点不能被推到普通次日，估计的复查时间可顺延。
3. 使用 rearm.schedule 更新同一实际任务的 schedule、default_timezone，显式保持 is_enabled=true，保留名称、GPT-6.1 Sol / Max 和 thread_mode=new_chat。调度只包含下一次执行，没有无限每日恢复规则。rearm=null 时不能保留或新建普通日期轮询。
4. 更新后立即 automations_peek 读回，把真实字段规范为 {id,enabled,timingMode,timeZone,schedule}，与 automationId 及原 rearm 一起保存为 {automationId,expected,receipt}，执行 node automation/cloud-baseline/plan.mjs --verify-rearm <回执.json>。不能从请求复制出伪造回执。只保存提示词不等于实际改期。
5. 只有已保存日期、实际任务更新和读回验证都完成，才可报告自动改期成功。调度权限缺失、配置不符或没有任何可靠下一日期时报告具体障碍；不擅自退回固定轮询，不修改其他任务。
6. 管理员部署时核验实际模型及新聊天设置，运行 --verify-profile；提示词中的模型名不算设置证据。每个游戏最终一个启用任务。日常 Agent 不自行创建替代任务。

## 当天维护

- version_end：检查本游戏新版本活动、已开放地图、周期玩法定义及排期例外；已官宣限时活动即使未开放也先收录，地图仍只收录已开放内容。
- first_half_end：只检查本游戏下半新增活动、补充公告和历史未决事项。枚举本期有效/已公告事项，不只检索清单已有标题；本游戏的历史节点早于 activatedAt 不妨碍当前节点覆盖当前内容。
- activity_time_review：只复核 due 中列出的活动时间，补齐后删除对应 activityTimeReviews；仍未知就更新 checkedAt、缺口、reviewAt 和估计理由，并再次实际改期。时间未知不删除活动，不恢复旧的整版审计或研究其他游戏。
- 官方独立命名的限时参与事项、region/subregion 两级地图、稳定身份及个人数据边界沿用现有标准。普通周期和版本按已发布规则滚动，不例行发布逐期记录。
- 原神任务只收录原神本体活动。千星奇域的赛季、玩法活动、奇偶装扮活动、创作赛事及相关网页活动均排除，不因原神官方公告或原石奖励而收录，也不转入其他版块。Agent 按实际参与内容判断归属，沿用已发布的稳定键退役记录。
- 可靠证据足够即发布，不增加固定来源数量、指定页面形式、玩法标签等级或独立探索百分比门槛；可选描述未知不阻挡已确认事实。必要事实未知保持 pending，不声称 verified_unchanged。
- 复用有效来源和既有裁决；后续适用官方更正覆盖旧字段。重开裁决须有新证据或明确 correctionReason。主要公告及一次定向补查仍无时间结果时，先收录已确认活动并估计下一次有效复查，不无限搜索，也不以等待时间为由漏收。
- 研究写入 catalog-research/cloud/<gameId>-<唯一摘要>.json，记录节点 key、覆盖版块、sources、decisions、pending、auditComplete。announcementReview 只包含本游戏：checkedAt 和 games（仅一个游戏）；游戏记录 gameId、coverage（complete/partial）、checkedSources、evidencePath、pending。用 node automation/cloud-baseline/plan.mjs --verify-review <研究.json> --game <gameId> 验证。partial 不能冒充无变化，不阻塞其他已确认事实。

## 编译与交付

1. 使用 codex/cloud-baseline/<gameId>-<唯一摘要> 分支。先检查该游戏已有 PR，续接同一节点；running 保留有限租约，ready 只确认或继续交付。GitHub 写入使用预期 SHA；同日不同游戏并发时重新读取 main、保留已合入的其他游戏数据，再编译和验证，不覆盖、不强推。
2. 差异确定后运行 pnpm install --frozen-lockfile、pnpm build、pnpm catalog:check --base <main清单> --delta <已核验差异> --output <累计清单>。临时差异与验证输出放工作区外。不得自制 JSON 合并绕过真实编译器；无清单变化不更新 revision/publishedAt。
3. 最终清单运行 pnpm test、pnpm build、pnpm catalog:check；地图变化加现有地图专项。再运行 node --test automation/cloud-baseline/plan.test.mjs、node automation/cloud-baseline/plan.mjs --game <gameId> 及 node automation/cloud-baseline/plan.mjs --guard <最新main SHA> --game <gameId>。CI 中 Verify 与 Cloud baseline checks 必须对实际最新 head 成功，后者检查路径和跨游戏写入边界。
4. 已确认部分可先发布，但未全部覆盖的节点保持 pending、auditComplete=false。全部核验且确无差异才记 verified_unchanged。有清单变化先记 ready，包含 revision、原始 UTF-8 SHA-256、证据路径及 PR URL。
5. 核对最新 head 和全部检查，用预期 head SHA 合并。合并后从 GitHub main 读回清单并核对 revision / SHA-256，才记 published；完成回执通过相同受限 PR 保存。中断后先核对实际发布再续接，不重复研究。
6. Gitee 仅为镜像，单独核验；不能将仓库提交、线上清单、镜像和本机接收混为同一结果。交付后重新规划并完成本任务改期闭环。
7. 没有变化、正常改期和状态未变时安静结束；只报告实际发布、无法恢复的失败或需要用户处理的事项。不因普通 pending 每天通知。

state.json 仅为云端调度元数据，不属于客户端清单协议，也不打进应用。本目录不注册本机服务或任务。
