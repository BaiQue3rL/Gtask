// Public semantics remain Agent decisions. These instructions travel with every
// job, including workers whose cwd is the application data directory.
export const BASELINE_MAINTENANCE_POLICY = {
  version: '2026-10-01',
  rules: [
    '同一事项、版本和服务器/时区，后续官方更正及现行完整规则覆盖实际修正的旧公告、日历或缓存字段；比较官方发布/更新时间与原文，不以抓取或转载时间判先后。沿用稳定身份，能裁决的冲突立即纠正，不因冲突漏收或重复要求确认。',
    '来源取舍与时间精度分别处理。已确认开放且官方写明版本更新后开始时，若官方维护起点与预计时长明确，可采用预计维护完成时刻作为 nominal 排期基准，在证据中保留原文和推算依据，不声称实测开服。不编造无依据的小时；缺截止时间按当前契约的 deadlineReview 条件处理。',
    '先枚举完整范围并复用当前基准、脱敏观察与有效来源，只补查缺失或冲突字段。主要公告/规则及一次独立补查仍无新证据时，记录 pending 的具体缺口；保留既有基准、提交其他已确认差异，不能将未覆盖标为无变化或整个范围已核验。',
    '通过进度工具的 researchDecisions 保存冲突旧值、采用值、来源原文、发布时间及时间基准。续接复用已有裁决，不重复检索同一问题。重开 resolved/excluded 须有新证据；发现先前解读/结构化错误或收到用户纠正时，可以填写 correctionReason 明确哪处旧判断不成立，不得锁死已证实的错误。pending 不是限时资格，也不能自动改变目录。',
    '直接维护应用数据时，queue_gtask_baseline_maintenance 传 agentId 原子创建并领取；后台任务仅领取指定 jobId。只有 claimed/resumed 可提交进度或写入。他人执行时停止该任务的写入，用 get_gtask_schedule_job 只读查询状态；终态及不存在均按实际状态报告，不能把空结果当作审计成功。先检查 isError，使用 structuredContent，不把错误文本当 JSON。',
    '先完成裁决、汇总最终差异，再批量应用和验证。同一变更集的验证结果复用；仅内容变化、检查失败或新增证据时重跑受影响检查。完整交付后才归档工作区；研究记录、客户端应用回执及远端发布分别如实报告。'
  ]
}
