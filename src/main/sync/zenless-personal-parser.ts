import type { NormalizedSyncItem } from './types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`绝区零个人数据缺少 ${field}`)
  return value
}

function requiredIdentifier(value: unknown, field: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    throw new Error(`绝区零个人数据缺少 ${field}`)
  }
  return String(value)
}

function chinaDateTime(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`绝区零个人数据缺少 ${field}`)
  const trimmed = value.trim()
  const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
  const parsed = new Date(hasTimeZone ? trimmed : `${trimmed}+08:00`)
  if (Number.isNaN(parsed.getTime())) throw new Error(`绝区零个人数据的 ${field} 不是有效时间`)
  return parsed.toISOString()
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function percentage(value: number, maximum: number): number | null {
  if (maximum <= 0) return null
  return Math.round(Math.min(100, Math.max(0, (value / maximum) * 100)) * 100) / 100
}

export function parseZenlessShiyuDefense(value: unknown): NormalizedSyncItem {
  const data = requiredRecord(value, '式舆防卫战')
  const scheduleId = requiredIdentifier(data.schedule_id, '式舆防卫战 schedule_id')
  const brief = isRecord(data.brief_info) ? data.brief_info : {}
  const score = finiteNumber(brief.score)
  const maximumScore = finiteNumber(brief.max_score)

  return {
    remoteKey: 'endgame:shiyu-defense',
    category: 'endgame',
    title: '式舆防卫战',
    completed: data.passed_fifth_floor === true,
    progressPercent: score !== null && maximumScore !== null ? percentage(score, maximumScore) : null,
    startsAt: chinaDateTime(data.begin_time, '式舆防卫战开始时间'),
    endsAt: chinaDateTime(data.end_time, '式舆防卫战结束时间'),
    periodKey: `zenless:shiyu-defense:${scheduleId}`,
    scheduleKind: 'remote_schedule',
    modeKey: 'shiyu-defense'
  }
}

export function parseZenlessDeadlyAssault(value: unknown): NormalizedSyncItem {
  const data = requiredRecord(value, '危局强袭战')
  const scheduleId = requiredIdentifier(data.id, '危局强袭战 id')
  const challenges = Array.isArray(data.challenges) ? data.challenges.filter(isRecord) : []
  const earnedStars = finiteNumber(data.total_star) ?? 0
  const maximumStars = challenges.reduce((total, challenge) => {
    return total + (finiteNumber(challenge.total_star) ?? 0)
  }, 0)
  const completed =
    data.has_data === true &&
    challenges.length > 0 &&
    challenges.every((challenge) => {
      const earned = finiteNumber(challenge.star)
      const maximum = finiteNumber(challenge.total_star)
      return earned !== null && maximum !== null && earned >= maximum
    })

  return {
    remoteKey: 'endgame:deadly-assault',
    category: 'endgame',
    title: '危局强袭战',
    completed,
    progressPercent: percentage(earnedStars, maximumStars),
    startsAt: chinaDateTime(data.start_time, '危局强袭战开始时间'),
    endsAt: chinaDateTime(data.end_time, '危局强袭战结束时间'),
    periodKey: `zenless:deadly-assault:${scheduleId}`,
    scheduleKind: 'remote_schedule',
    modeKey: 'deadly-assault'
  }
}

export function parseZenlessPersonalData(input: {
  shiyuDefense?: unknown
  deadlyAssault?: unknown
}): NormalizedSyncItem[] {
  const items: NormalizedSyncItem[] = []
  if (input.shiyuDefense !== undefined) items.push(parseZenlessShiyuDefense(input.shiyuDefense))
  if (input.deadlyAssault !== undefined) items.push(parseZenlessDeadlyAssault(input.deadlyAssault))
  if (items.length === 0) throw new Error('绝区零个人数据没有可识别的周期玩法')
  return items
}
