import { CHECKLIST_CATEGORIES, MAP_NODE_KINDS, SCHEDULE_KINDS } from '../../shared/contracts'
import { normalizeActivityTags } from '../activity-tags'
import type { NormalizedSyncItem } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${field}格式不正确`)
  const normalized = value.trim()
  if (!normalized || normalized.length > maxLength) throw new Error(`${field}格式不正确`)
  return normalized
}

function nullableString(value: unknown, field: string, maxLength = 200): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`${field}格式不正确`)
  return value
}

function nullableDate(value: unknown, field: string): string | null | undefined {
  const normalized = nullableString(value, field)
  if (!normalized) return normalized
  const timestamp = Date.parse(normalized)
  if (Number.isNaN(timestamp)) throw new Error(`${field}不是有效时间`)
  return new Date(timestamp).toISOString()
}

function nullableHttpUrl(value: unknown): string | null | undefined {
  const normalized = nullableString(value, '同步来源 URL', 500)
  if (!normalized) return normalized
  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    throw new Error('同步来源 URL 格式不正确')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('同步来源 URL 仅支持 HTTP/HTTPS')
  return url.toString()
}

function optionalActivityTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 5) throw new Error('活动玩法标签格式不正确')
  const tags = value.map((entry) => requiredString(entry, '活动玩法标签', 80))
  const uniqueTags = normalizeActivityTags(tags)
  return uniqueTags
}

function optionalSourceIdentity(value: unknown): NormalizedSyncItem['sourceIdentity'] {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error('个人数据来源标识格式不正确')
  return {
    provider: requiredString(value.provider, '个人数据平台', 80),
    endpoint: requiredString(value.endpoint, '个人数据接口', 160),
    externalId: requiredString(value.externalId, '个人数据官方标识', 300)
  }
}

export function normalizeSyncItem(value: unknown): NormalizedSyncItem {
  if (!isRecord(value)) throw new Error('同步事项格式不正确')
  if (
    typeof value.category !== 'string' ||
    !CHECKLIST_CATEGORIES.includes(value.category as NormalizedSyncItem['category'])
  ) {
    throw new Error('同步事项分类不受支持')
  }
  if (value.completed !== undefined && typeof value.completed !== 'boolean') {
    throw new Error('同步完成状态格式不正确')
  }
  if (
    value.progressPercent !== undefined &&
    value.progressPercent !== null &&
    (typeof value.progressPercent !== 'number' ||
      !Number.isFinite(value.progressPercent) ||
      value.progressPercent < 0 ||
      value.progressPercent > 100)
  ) {
    throw new Error('同步进度必须在 0 到 100 之间')
  }
  if (
    value.scheduleKind !== undefined &&
    value.scheduleKind !== null &&
    (typeof value.scheduleKind !== 'string' ||
      !SCHEDULE_KINDS.includes(value.scheduleKind as NormalizedSyncItem['scheduleKind'] & string))
  ) {
    throw new Error('同步周期类型格式不正确')
  }
  if (
    value.mapNodeKind !== undefined &&
    value.mapNodeKind !== null &&
    (typeof value.mapNodeKind !== 'string' ||
      !MAP_NODE_KINDS.includes(value.mapNodeKind as NormalizedSyncItem['mapNodeKind'] & string))
  ) {
    throw new Error('同步地图节点类型格式不正确')
  }
  if (
    value.resetWeekday !== undefined &&
    value.resetWeekday !== null &&
    (typeof value.resetWeekday !== 'number' ||
      !Number.isInteger(value.resetWeekday) ||
      value.resetWeekday < 1 ||
      value.resetWeekday > 7)
  ) {
    throw new Error('同步周重置日必须在 1 到 7 之间')
  }

  const startsAt = nullableDate(value.startsAt, '同步开始时间')
  const endsAt = nullableDate(value.endsAt, '同步结束时间')
  if (startsAt && endsAt && Date.parse(startsAt) > Date.parse(endsAt)) {
    throw new Error('同步结束时间不能早于开始时间')
  }

  return {
    remoteKey: requiredString(value.remoteKey, '远端事项标识', 200),
    sourceUrl: nullableHttpUrl(value.sourceUrl),
    category: value.category as NormalizedSyncItem['category'],
    title: requiredString(value.title, '同步事项名称', 100),
    activityTags: optionalActivityTags(value.activityTags),
    completed: value.completed as boolean | undefined,
    progressPercent: value.progressPercent as number | null | undefined,
    parentTitle: nullableString(value.parentTitle, '同步上级区域'),
    mapNodeKind: value.mapNodeKind as NormalizedSyncItem['mapNodeKind'] | undefined,
    parentRemoteKey: nullableString(value.parentRemoteKey, '同步上级区域标识'),
    startsAt,
    endsAt,
    resetRule: nullableString(value.resetRule, '同步重置规则'),
    periodKey: nullableString(value.periodKey, '同步周期标识'),
    scheduleKind: value.scheduleKind as NormalizedSyncItem['scheduleKind'] | undefined,
    resetWeekday: value.resetWeekday as number | null | undefined,
    timeZone: nullableString(value.timeZone, '同步时区'),
    modeKey: nullableString(value.modeKey, '同步模式标识'),
    recurrenceRule: null,
    sourceIdentity: optionalSourceIdentity(value.sourceIdentity)
  }
}

export function normalizeSyncItems(values: unknown): NormalizedSyncItem[] {
  if (!Array.isArray(values)) throw new Error('同步事项列表格式不正确')
  return values.map(normalizeSyncItem)
}
