import type { NormalizedSyncItem } from './types'

export interface GenshinPersonalPayload {
  profile?: unknown
  spiralAbyss?: unknown
  imaginariumTheater?: unknown
  stygianOnslaught?: unknown
  eventCalendar?: unknown
}

export function parseGenshinPersonalData(input: GenshinPersonalPayload): NormalizedSyncItem[] {
  const items: NormalizedSyncItem[] = []
  if (input.profile !== undefined) items.push(...parseExplorations(input.profile))
  if (input.spiralAbyss !== undefined) items.push(parseSpiralAbyss(input.spiralAbyss))
  if (input.imaginariumTheater !== undefined) {
    const theater = parseImaginariumTheater(input.imaginariumTheater)
    if (theater) items.push(theater)
  }
  if (input.stygianOnslaught !== undefined) {
    const stygian = parseStygianOnslaught(input.stygianOnslaught)
    if (stygian) items.push(stygian)
  }
  if (input.eventCalendar !== undefined) items.push(...parseGenshinEvents(input.eventCalendar))
  if (items.length === 0) throw new Error('原神个人数据没有可识别的探索或周期玩法')
  return items
}

export function parseGenshinEvents(value: unknown): NormalizedSyncItem[] {
  const root = requiredRecord(value, '活动日历')
  const events = Array.isArray(root.act_list) ? root.act_list.filter(isRecord) : []
  return events.flatMap((event) => {
    const id = requiredIdentifier(event.id, '活动 id')
    const title = requiredString(event.name, '活动名称')
    const startsAt = toIsoDate(event.start_timestamp ?? event.start_time, `${title}开始时间`)
    const endsAt = toIsoDate(event.end_timestamp ?? event.end_time, `${title}结束时间`)
    const exploration = isRecord(event.explore_detail) ? event.explore_detail : null
    const rawProgress = exploration ? finiteNumber(exploration.explore_percent) : null
    const progressPercent = rawProgress === null
      ? undefined
      : clampPercentage(rawProgress > 100 ? rawProgress / 10 : rawProgress)
    return [{
      remoteKey: `event:miyoushe:${id}`,
      category: 'limited_event' as const,
      title,
      completed: event.is_finished === true || exploration?.is_finished === true,
      progressPercent,
      startsAt,
      endsAt,
      periodKey: `genshin:event:${id}:${startsAt}`,
      scheduleKind: 'fixed_window' as const,
      modeKey: `official-event-${id}`
    }]
  })
}

export function parseExplorations(value: unknown): NormalizedSyncItem[] {
  const root = requiredRecord(value, '个人概览')
  const explorations = Array.isArray(root.world_explorations)
    ? root.world_explorations.filter(isRecord)
    : []
  return explorations.map((exploration) => {
    const id = requiredIdentifier(exploration.id, '探索区域 id')
    const title = requiredString(exploration.name, '探索区域名称')
    const rawProgress = requiredNumber(exploration.exploration_percentage, `${title} 探索度`)
    const progressPercent = clampPercentage(rawProgress / 10)
    return {
      remoteKey: `exploration:world:${id}`,
      category: 'exploration',
      title,
      completed: progressPercent >= 100,
      progressPercent,
      parentTitle: '世界探索',
      modeKey: `world-exploration-${id}`
    }
  })
}

export function parseSpiralAbyss(value: unknown): NormalizedSyncItem {
  const data = requiredRecord(value, '深境螺旋')
  const scheduleId = requiredIdentifier(data.schedule_id, '深境螺旋 schedule_id')
  const totalStars = finiteNumber(data.total_star) ?? 0
  const maxFloor = typeof data.max_floor === 'string' ? data.max_floor.replaceAll(' ', '') : ''
  const floors = Array.isArray(data.floors) ? data.floors.filter(isRecord) : []
  const clearedLastChamber = floors.some((floor) => {
    if (Number(floor.index) !== 12) return false
    const levels = Array.isArray(floor.levels) ? floor.levels.filter(isRecord) : []
    return levels.some((level) => Number(level.index) >= 3 && Number(level.star) >= 0)
  })
  return {
    remoteKey: 'endgame:spiral-abyss',
    category: 'endgame',
    title: '深境螺旋',
    completed: maxFloor === '12-3' || clearedLastChamber,
    progressPercent: clampPercentage((totalStars / 36) * 100),
    startsAt: toIsoDate(data.start_time, '深境螺旋开始时间'),
    endsAt: toIsoDate(data.end_time, '深境螺旋结束时间'),
    periodKey: `genshin:spiral-abyss:${scheduleId}`,
    scheduleKind: 'remote_schedule',
    modeKey: 'spiral-abyss'
  }
}

export function parseImaginariumTheater(value: unknown): NormalizedSyncItem | null {
  const root = requiredRecord(value, '幻想真境剧诗')
  if (root.is_unlock === false) return null
  const records = Array.isArray(root.data) ? root.data.filter(isRecord) : []
  const data = records.find((record) => record.has_data === true) ?? records[0]
  if (!data) return null
  const schedule = requiredRecord(data.schedule, '幻想真境剧诗 schedule')
  const stats = requiredRecord(data.stat, '幻想真境剧诗 stat')
  const scheduleId = requiredIdentifier(schedule.schedule_id, '幻想真境剧诗 schedule_id')
  const bestRecord = finiteNumber(stats.max_round_id) ?? 0
  const medalRounds = Array.isArray(stats.get_medal_round_list) ? stats.get_medal_round_list.length : 0
  const targetRounds = medalRounds > 0 ? medalRounds : 10
  return {
    remoteKey: 'endgame:imaginarium-theater',
    category: 'endgame',
    title: '幻想真境剧诗',
    completed: data.has_data === true && bestRecord >= targetRounds,
    progressPercent: clampPercentage((bestRecord / targetRounds) * 100),
    startsAt: toIsoDate(schedule.start_time ?? schedule.start_date_time, '幻想真境剧诗开始时间'),
    endsAt: toIsoDate(schedule.end_time ?? schedule.end_date_time, '幻想真境剧诗结束时间'),
    periodKey: `genshin:imaginarium-theater:${scheduleId}`,
    scheduleKind: 'remote_schedule',
    modeKey: 'imaginarium-theater'
  }
}

export function parseStygianOnslaught(value: unknown): NormalizedSyncItem | null {
  const root = requiredRecord(value, '幽境危战')
  const records = Array.isArray(root.data) ? root.data.filter(isRecord) : []
  const data = records.find((record) => isRecord(record.schedule) && record.schedule.is_valid !== false)
    ?? records[0]
  if (!data) return null
  const schedule = requiredRecord(data.schedule, '幽境危战 schedule')
  const single = requiredRecord(data.single, '幽境危战 single')
  const best = isRecord(single.best) ? single.best : null
  const difficulty = best ? finiteNumber(best.difficulty) ?? 0 : 0
  const scheduleId = requiredIdentifier(schedule.schedule_id, '幽境危战 schedule_id')
  return {
    remoteKey: 'endgame:stygian-onslaught',
    category: 'endgame',
    title: requiredOptionalString(schedule.name) ?? '幽境危战',
    completed: single.has_data === true && difficulty >= 6,
    progressPercent: clampPercentage((difficulty / 6) * 100),
    startsAt: toIsoDate(schedule.start_time ?? schedule.start_date_time, '幽境危战开始时间'),
    endsAt: toIsoDate(schedule.end_time ?? schedule.end_date_time, '幽境危战结束时间'),
    periodKey: `genshin:stygian-onslaught:${scheduleId}`,
    scheduleKind: 'remote_schedule',
    modeKey: 'stygian-onslaught'
  }
}

function toIsoDate(value: unknown, field: string): string {
  let date: Date
  if (typeof value === 'number' && Number.isFinite(value)) {
    date = new Date(value < 10_000_000_000 ? value * 1000 : value)
  } else if (typeof value === 'string' && value.trim()) {
    const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value.trim())
      ? value.trim()
      : `${value.trim()}+08:00`
    date = new Date(normalized)
  } else if (isRecord(value)) {
    const year = requiredNumber(value.year, `${field} year`)
    const month = requiredNumber(value.month, `${field} month`)
    const day = requiredNumber(value.day, `${field} day`)
    const hour = finiteNumber(value.hour) ?? 0
    const minute = finiteNumber(value.minute) ?? 0
    const second = finiteNumber(value.second) ?? 0
    date = new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second))
  } else {
    throw new Error(`原神个人数据缺少 ${field}`)
  }
  if (Number.isNaN(date.getTime())) throw new Error(`原神个人数据的 ${field} 不是有效时间`)
  return date.toISOString()
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`原神个人数据缺少 ${field}`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredIdentifier(value: unknown, field: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new Error(`原神个人数据缺少 ${field}`)
  }
  return String(value)
}

function requiredString(value: unknown, field: string): string {
  const result = requiredOptionalString(value)
  if (!result) throw new Error(`原神个人数据缺少 ${field}`)
  return result
}

function requiredOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredNumber(value: unknown, field: string): number {
  const number = finiteNumber(value)
  if (number === null) throw new Error(`原神个人数据缺少 ${field}`)
  return number
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function clampPercentage(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100
}
