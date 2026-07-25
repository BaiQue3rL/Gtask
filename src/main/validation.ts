import {
  CHECKLIST_CATEGORIES,
  CHECKLIST_SECTIONS,
  CREDENTIAL_PROVIDERS,
  SCHEDULE_KINDS,
  SYNC_RUN_MODES,
  SYNC_SCOPES,
  SYNC_TARGETS,
  SUPPORTED_GAME_IDS,
  type ChecklistCategory,
  type ChecklistSection,
  type CredentialProvider,
  type CreateChecklistItemInput,
  type GameId,
  type ScheduleKind,
  type SyncRunMode,
  type SyncScope,
  type SyncTarget,
  type UpdateChecklistItemInput
} from '../shared/contracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseGameId(value: unknown): GameId {
  if (typeof value !== 'string' || !SUPPORTED_GAME_IDS.includes(value as GameId)) {
    throw new Error('不支持的游戏')
  }
  return value as GameId
}

export function parseChecklistCategory(value: unknown): ChecklistCategory {
  if (typeof value !== 'string' || !CHECKLIST_CATEGORIES.includes(value as ChecklistCategory)) {
    throw new Error('不支持的事项分类')
  }
  return value as ChecklistCategory
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('事项名称格式不正确')
  const title = value.trim()
  if (!title) throw new Error('事项名称不能为空')
  if (title.length > 100) throw new Error('事项名称不能超过 100 个字符')
  return title
}

function parseActivityTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 5) throw new Error('活动玩法标签格式不正确')
  const tags = value.map((entry) => {
    if (typeof entry !== 'string') throw new Error('活动玩法标签格式不正确')
    const tag = entry.trim()
    if (!tag || tag.length > 20) throw new Error('活动玩法标签须为 1 到 20 个字符')
    return tag
  })
  const uniqueTags = [...new Set(tags)]
  if (uniqueTags.includes('待识别')) {
    throw new Error('活动玩法标签不能使用“待识别”，无法确认时请使用“未知”')
  }
  return uniqueTags
}

function parseNullableString(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 200) throw new Error(`${fieldName}格式不正确`)
  return value
}

function parseNullableDate(value: unknown, fieldName: string): string | null | undefined {
  const normalized = parseNullableString(value, fieldName)
  if (!normalized) return normalized
  const timestamp = Date.parse(normalized)
  if (Number.isNaN(timestamp)) throw new Error(`${fieldName}不是有效时间`)
  return new Date(timestamp).toISOString()
}

function validateTimeWindow(startsAt: string | null | undefined, endsAt: string | null | undefined): void {
  if (startsAt && endsAt && Date.parse(startsAt) > Date.parse(endsAt)) {
    throw new Error('结束时间不能早于开始时间')
  }
}

function parseProgress(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error('探索进度必须在 0 到 100 之间')
  }
  return value
}

function parseScheduleKind(value: unknown): ScheduleKind | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || !SCHEDULE_KINDS.includes(value as ScheduleKind)) {
    throw new Error('周期类型格式不正确')
  }
  return value as ScheduleKind
}

function parseResetWeekday(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 7) {
    throw new Error('周重置日必须在 1 到 7 之间')
  }
  return value
}

function parseRecurrenceRule(value: unknown): string | null | undefined {
  const rule = parseNullableString(value, '自动周期规则')
  if (!rule) return rule
  if (
    !/^interval-days:\d{1,3}$/.test(rule) &&
    !/^monthly-days:[\d,]+@\d{2}:\d{2}\[Asia\/Shanghai\]$/.test(rule)
  ) throw new Error('自动周期规则格式不正确')
  return rule
}

export function parseCreateChecklistItem(value: unknown): CreateChecklistItemInput {
  if (!isRecord(value)) throw new Error('新增事项参数格式不正确')
  const startsAt = parseNullableDate(value.startsAt, '开始时间')
  const endsAt = parseNullableDate(value.endsAt, '结束时间')
  validateTimeWindow(startsAt, endsAt)
  return {
    gameId: parseGameId(value.gameId),
    category: parseChecklistCategory(value.category),
    title: parseTitle(value.title),
    activityTags: parseActivityTags(value.activityTags),
    progressPercent: parseProgress(value.progressPercent),
    parentTitle: parseNullableString(value.parentTitle, '上级区域'),
    startsAt,
    endsAt,
    resetRule: parseNullableString(value.resetRule, '重置规则'),
    scheduleKind: parseScheduleKind(value.scheduleKind),
    resetWeekday: parseResetWeekday(value.resetWeekday),
    timeZone: parseNullableString(value.timeZone, '时区'),
    modeKey: parseNullableString(value.modeKey, '模式标识'),
    recurrenceRule: parseRecurrenceRule(value.recurrenceRule)
  }
}

export function parseUpdateChecklistItem(value: unknown): UpdateChecklistItemInput {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new Error('更新事项参数格式不正确')
  }

  if (value.completed !== undefined && typeof value.completed !== 'boolean') {
    throw new Error('完成状态格式不正确')
  }
  const startsAt = parseNullableDate(value.startsAt, '开始时间')
  const endsAt = parseNullableDate(value.endsAt, '结束时间')
  validateTimeWindow(startsAt, endsAt)

  return {
    id: parseItemId(value.id),
    category: value.category === undefined ? undefined : parseChecklistCategory(value.category),
    title: value.title === undefined ? undefined : parseTitle(value.title),
    activityTags: parseActivityTags(value.activityTags),
    completed: value.completed,
    progressPercent: parseProgress(value.progressPercent),
    parentTitle: parseNullableString(value.parentTitle, '上级区域'),
    startsAt,
    endsAt,
    resetRule: parseNullableString(value.resetRule, '重置规则'),
    scheduleKind: parseScheduleKind(value.scheduleKind),
    resetWeekday: parseResetWeekday(value.resetWeekday),
    timeZone: parseNullableString(value.timeZone, '时区'),
    modeKey: parseNullableString(value.modeKey, '模式标识'),
    recurrenceRule: parseRecurrenceRule(value.recurrenceRule)
  }
}

export function parseItemId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 100) throw new Error('事项 ID 格式不正确')
  return value
}

export function parseChecklistSection(value: unknown): ChecklistSection {
  if (typeof value !== 'string' || !CHECKLIST_SECTIONS.includes(value as ChecklistSection)) {
    throw new Error('不支持的清单版块')
  }
  return value as ChecklistSection
}

export function parseSyncRunMode(value: unknown): SyncRunMode {
  if (typeof value !== 'string' || !SYNC_RUN_MODES.includes(value as SyncRunMode)) {
    throw new Error('不支持的同步运行模式')
  }
  return value as SyncRunMode
}

export function parseSyncScope(value: unknown): SyncScope {
  if (typeof value !== 'string' || !SYNC_SCOPES.includes(value as SyncScope)) {
    throw new Error('不支持的同步范围')
  }
  return value as SyncScope
}

export function parseSyncTarget(value: unknown): SyncTarget {
  if (typeof value !== 'string' || !SYNC_TARGETS.includes(value as SyncTarget)) {
    throw new Error('不支持的同步版块')
  }
  return value as SyncTarget
}

export function parseCredentialProvider(value: unknown): CredentialProvider {
  if (
    typeof value !== 'string' ||
    !CREDENTIAL_PROVIDERS.includes(value as CredentialProvider)
  ) {
    throw new Error('不支持的凭据平台')
  }
  return value as CredentialProvider
}

export function parseExternalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 500) throw new Error('外部链接格式不正确')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('外部链接格式不正确')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许打开 HTTP/HTTPS 链接')
  return url.toString()
}
