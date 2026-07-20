import { CHECKLIST_CATEGORIES, SCHEDULE_KINDS } from '../../shared/contracts'
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
  if (normalized && Number.isNaN(Date.parse(normalized))) throw new Error(`${field}不是有效时间`)
  return normalized
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
    value.resetWeekday !== undefined &&
    value.resetWeekday !== null &&
    (typeof value.resetWeekday !== 'number' ||
      !Number.isInteger(value.resetWeekday) ||
      value.resetWeekday < 1 ||
      value.resetWeekday > 7)
  ) {
    throw new Error('同步周重置日必须在 1 到 7 之间')
  }

  return {
    remoteKey: requiredString(value.remoteKey, '远端事项标识', 200),
    category: value.category as NormalizedSyncItem['category'],
    title: requiredString(value.title, '同步事项名称', 100),
    completed: value.completed as boolean | undefined,
    progressPercent: value.progressPercent as number | null | undefined,
    parentTitle: nullableString(value.parentTitle, '同步上级区域'),
    startsAt: nullableDate(value.startsAt, '同步开始时间'),
    endsAt: nullableDate(value.endsAt, '同步结束时间'),
    resetRule: nullableString(value.resetRule, '同步重置规则'),
    periodKey: nullableString(value.periodKey, '同步周期标识'),
    scheduleKind: value.scheduleKind as NormalizedSyncItem['scheduleKind'] | undefined,
    resetWeekday: value.resetWeekday as number | null | undefined,
    timeZone: nullableString(value.timeZone, '同步时区'),
    modeKey: nullableString(value.modeKey, '同步模式标识')
  }
}

export function normalizeSyncItems(values: unknown): NormalizedSyncItem[] {
  if (!Array.isArray(values)) throw new Error('同步事项列表格式不正确')
  return values.map(normalizeSyncItem)
}
