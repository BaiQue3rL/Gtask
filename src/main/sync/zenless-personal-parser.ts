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

function optionalChinaDateTime(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  let parsed: Date
  if (typeof value === 'number' && Number.isFinite(value)) {
    parsed = new Date(value < 10_000_000_000 ? value * 1000 : value)
  } else if (typeof value === 'string' && value.trim()) {
    const trimmed = value.trim()
    if (/^\d{10,13}$/.test(trimmed)) {
      const timestamp = Number(trimmed)
      parsed = new Date(trimmed.length === 10 ? timestamp * 1000 : timestamp)
    } else {
      const hasTimeZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed)
      parsed = new Date(hasTimeZone ? trimmed : `${trimmed}+08:00`)
    }
  } else if (isRecord(value)) {
    const year = finiteNumber(value.year)
    const month = finiteNumber(value.month)
    const day = finiteNumber(value.day)
    if (year === null || month === null || day === null) {
      throw new Error(`绝区零个人数据的 ${field} 不是有效时间`)
    }
    parsed = new Date(Date.UTC(
      year,
      month - 1,
      day,
      (finiteNumber(value.hour) ?? 0) - 8,
      finiteNumber(value.minute) ?? 0,
      finiteNumber(value.second) ?? 0
    ))
  } else {
    throw new Error(`绝区零个人数据的 ${field} 不是有效时间`)
  }
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

export function parseZenlessEvents(value: unknown, reference = new Date()): NormalizedSyncItem[] {
  const root = requiredRecord(value, '活动日历')
  const events = Array.isArray(root.activity_list) ? root.activity_list.filter(isRecord) : []
  return events.map((event) => {
    const id = requiredIdentifier(event.activity_id ?? event.id, '活动 id')
    const title = typeof event.name === 'string' && event.name.trim() ? event.name.trim() : null
    if (!title) throw new Error('绝区零个人数据缺少活动名称')
    const startsAt = optionalChinaDateTime(event.start_ts ?? event.start, `${title}开始时间`)
    const endsAt = optionalChinaDateTime(event.end_ts ?? event.end, `${title}结束时间`)
    if (!startsAt || !endsAt) throw new Error(`绝区零个人数据缺少 ${title} 排期时间`)
    const obtained = finiteNumber(event.monochrome_got_cnt ?? event.obtained_monochromes)
    const maximum = finiteNumber(event.monochrome_cnt ?? event.max_monochromes)
    const hasStarted = Date.parse(startsAt) <= reference.getTime()
    const progressPercent = hasStarted && obtained !== null && maximum !== null
      ? percentage(obtained, maximum) ?? undefined
      : undefined
    const state = typeof (event.state ?? event.status) === 'string'
      ? String(event.state ?? event.status)
      : ''
    return {
      remoteKey: `event:miyoushe:${id}`,
      category: 'limited_event',
      title,
      completed: hasStarted && state === 'STATE_COMPLETED',
      progressPercent,
      startsAt,
      endsAt,
      periodKey: `zenless:event:${id}:${startsAt}`,
      scheduleKind: 'fixed_window',
      modeKey: `official-event-${id}`
    }
  })
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
    startsAt: optionalChinaDateTime(data.begin_time, '式舆防卫战开始时间'),
    endsAt: optionalChinaDateTime(data.end_time, '式舆防卫战结束时间'),
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
    startsAt: optionalChinaDateTime(data.start_time, '危局强袭战开始时间'),
    endsAt: optionalChinaDateTime(data.end_time, '危局强袭战结束时间'),
    periodKey: `zenless:deadly-assault:${scheduleId}`,
    scheduleKind: 'remote_schedule',
    modeKey: 'deadly-assault'
  }
}

export function parseZenlessPersonalData(input: {
  shiyuDefense?: unknown
  deadlyAssault?: unknown
  eventCalendar?: unknown
}, reference = new Date()): NormalizedSyncItem[] {
  const items: NormalizedSyncItem[] = []
  if (input.shiyuDefense !== undefined) items.push(parseZenlessShiyuDefense(input.shiyuDefense))
  if (input.deadlyAssault !== undefined) items.push(parseZenlessDeadlyAssault(input.deadlyAssault))
  if (input.eventCalendar !== undefined) {
    items.push(...parseZenlessEvents(input.eventCalendar, reference))
  }
  if (items.length === 0) throw new Error('绝区零个人数据没有可识别的周期玩法')
  return items
}
