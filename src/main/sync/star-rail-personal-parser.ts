import type { NormalizedSyncItem, SemanticReviewDraft } from './types'
import { finiteNumber } from './numbers'

export interface StarRailPersonalPayload {
  memoryOfChaos?: unknown
  pureFiction?: unknown
  apocalypticShadow?: unknown
  anomalyArbitration?: unknown
  eventCalendar?: unknown
}

interface ChallengeModeDefinition {
  input: unknown
  label: string
  modeKey: string
}

export function parseStarRailPersonalData(
  input: StarRailPersonalPayload,
  reference = new Date()
): NormalizedSyncItem[] {
  const items: NormalizedSyncItem[] = []
  const modes: ChallengeModeDefinition[] = [
    {
      input: input.memoryOfChaos,
      label: '混沌回忆',
      modeKey: 'memory-of-chaos'
    },
    {
      input: input.pureFiction,
      label: '虚构叙事',
      modeKey: 'pure-fiction'
    },
    {
      input: input.apocalypticShadow,
      label: '末日幻影',
      modeKey: 'apocalyptic-shadow'
    }
  ]
  for (const mode of modes) {
    if (mode.input !== undefined) items.push(parseChallengeMode(mode))
  }
  if (input.anomalyArbitration !== undefined) {
    const arbitration = parseAnomalyArbitration(input.anomalyArbitration)
    if (arbitration) items.push(arbitration)
  }
  if (input.eventCalendar !== undefined) {
    items.push(...parseStarRailEvents(input.eventCalendar, reference))
  }
  if (items.length === 0) throw new Error('星铁个人数据没有可识别的周期玩法')
  return items
}

export function parseStarRailEvents(value: unknown, reference = new Date()): NormalizedSyncItem[] {
  const root = requiredRecord(value, '活动日历')
  const events = Array.isArray(root.act_list) ? root.act_list.filter(isRecord) : []
  return events.flatMap((event) => {
    const timeInfo = isRecord(event.time_info) ? event.time_info : null
    if (!timeInfo) return []
    const id = requiredIdentifier(event.id, '活动 id')
    const title = requiredOptionalString(event.name)
    if (!title) throw new Error('星铁个人数据缺少活动名称')
    const parsedStartsAt = optionalIsoDate(
      timeInfo.start_ts ?? timeInfo.start_time ?? timeInfo.start,
      `${title}开始时间`
    )
    const parsedEndsAt = optionalIsoDate(
      timeInfo.end_ts ?? timeInfo.end_time ?? timeInfo.end,
      `${title}结束时间`
    )
    const hasValidWindow = Boolean(
      parsedStartsAt &&
      parsedEndsAt &&
      new Date(parsedStartsAt).getTime() < new Date(parsedEndsAt).getTime()
    )
    const startsAt = hasValidWindow ? parsedStartsAt : undefined
    const endsAt = hasValidWindow ? parsedEndsAt : undefined
    return [{
      remoteKey: `event:miyoushe:${id}`,
      category: 'limited_event' as const,
      title: title.replaceAll('\\n', ' '),
      startsAt,
      endsAt,
      periodKey: startsAt ? `star-rail:event:${id}:${startsAt}` : `star-rail:event:${id}`,
      scheduleKind: startsAt ? 'fixed_window' as const : undefined,
      modeKey: `official-event-${id}`
    }]
  })
}

export function extractStarRailEventReviewCandidates(value: unknown): SemanticReviewDraft[] {
  const root = requiredRecord(value, '活动日历')
  const events = Array.isArray(root.act_list) ? root.act_list.filter(isRecord) : []
  return events.map((event) => {
    const timeInfo = isRecord(event.time_info) ? event.time_info : {}
    const id = requiredIdentifier(event.id, '活动 id')
    const title = requiredOptionalString(event.name)
    if (!title) throw new Error('星铁个人数据缺少活动名称')
    const startsAt = optionalIsoDate(
      timeInfo.start_ts ?? timeInfo.start_time ?? timeInfo.start,
      `${title}开始时间`
    ) ?? null
    const endsAt = optionalIsoDate(
      timeInfo.end_ts ?? timeInfo.end_time ?? timeInfo.end,
      `${title}结束时间`
    ) ?? null
    return {
      target: 'events',
      kind: 'personal-item-semantics',
      payload: {
        sourceContext: 'miyoushe-star-rail-event-calendar',
        officialEventId: id,
        title: title.replaceAll('\\n', ' '),
        startsAt,
        endsAt,
        observedStatus: {
          allFinished: typeof event.all_finished === 'boolean' ? event.all_finished : null,
          actStatus: requiredOptionalString(event.act_status) ?? null,
          currentProgress: finiteNumber(event.current_progress),
          totalProgress: finiteNumber(event.total_progress)
        }
      }
    }
  })
}

function parseChallengeMode(definition: ChallengeModeDefinition): NormalizedSyncItem {
  const root = requiredRecord(definition.input, definition.label)
  const groups = Array.isArray(root.groups) ? root.groups.filter(isRecord) : []
  const season = groups.find((group) => group.status === 'STATUS_CURRENT') ?? groups[0]
  const scheduleId = requiredIdentifier(
    root.schedule_id ?? season?.schedule_id,
    `${definition.label} schedule_id`
  )
  const stars = Math.max(0, (finiteNumber(root.star_num) ?? 0) + (finiteNumber(root.extra_star_num) ?? 0))
  const floors = Array.isArray(root.all_floor_detail) ? root.all_floor_detail.filter(isRecord) : []
  const maxFloor = parseFloorNumber(root.max_floor)
  const completed =
    root.has_data === true ||
    stars > 0 ||
    maxFloor > 0 ||
    floors.some(hasFloorRecord)
  const startsAt = toIsoDate(root.begin_time ?? season?.begin_time, `${definition.label}开始时间`)
  const endsAt = toIsoDate(root.end_time ?? season?.end_time, `${definition.label}结束时间`)
  return {
    remoteKey: `endgame:${definition.modeKey}`,
    category: 'endgame',
    title: definition.label,
    completed,
    startsAt,
    endsAt,
    periodKey: `star-rail:${definition.modeKey}:${scheduleId}`,
    scheduleKind: 'remote_schedule',
    modeKey: definition.modeKey
  }
}

function parseAnomalyArbitration(value: unknown): NormalizedSyncItem | null {
  const root = requiredRecord(value, '异相仲裁')
  const records = Array.isArray(root.challenge_peak_records)
    ? root.challenge_peak_records.filter(isRecord)
    : []
  const record = records.find((candidate) => {
    const group = isRecord(candidate.group) ? candidate.group : null
    return group?.status === 'STATUS_CURRENT'
  }) ?? records[0]
  if (!record) return null
  const group = requiredRecord(record.group, '异相仲裁 group')
  const groupId = requiredIdentifier(group.group_id, '异相仲裁 group_id')
  const bossRecord = isRecord(record.boss_record) ? record.boss_record : null
  const miniBossRecords = Array.isArray(record.mob_records) ? record.mob_records.filter(isRecord) : []
  const bossStars = Math.max(0, finiteNumber(record.boss_stars) ?? 0)
  const miniBossStars = Math.max(0, finiteNumber(record.mob_stars) ?? 0)
  const hasData =
    record.has_challenge_record === true ||
    bossRecord?.has_challenge_record === true ||
    miniBossRecords.some((candidate) => candidate.has_challenge_record === true) ||
    bossStars > 0 ||
    miniBossStars > 0
  return {
    remoteKey: 'endgame:anomaly-arbitration',
    category: 'endgame',
    title: requiredOptionalString(group.name_mi18n) ?? '异相仲裁',
    completed: hasData,
    startsAt: toIsoDate(group.begin_time, '异相仲裁开始时间'),
    endsAt: toIsoDate(group.end_time, '异相仲裁结束时间'),
    periodKey: `star-rail:anomaly-arbitration:${groupId}`,
    scheduleKind: 'remote_schedule',
    modeKey: 'anomaly-arbitration'
  }
}

function hasFloorRecord(floor: Record<string, unknown>): boolean {
  return ['node_1', 'node_2', 'node_3'].some((key) => isRecord(floor[key])) ||
    (finiteNumber(floor.star_num) ?? 0) > 0 || floor.is_fast === true
}

function parseFloorNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return 0
  const matches = value.match(/\d+/g)
  return matches ? Number(matches.at(-1)) : 0
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
    throw new Error(`星铁个人数据缺少 ${field}`)
  }
  if (Number.isNaN(date.getTime())) throw new Error(`星铁个人数据的 ${field} 不是有效时间`)
  return date.toISOString()
}

function optionalIsoDate(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null
  const numeric = finiteNumber(value)
  if (numeric !== null && numeric <= 0) return null
  try {
    return toIsoDate(numeric ?? value, field)
  } catch {
    return null
  }
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`星铁个人数据缺少 ${field}`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredIdentifier(value: unknown, field: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new Error(`星铁个人数据缺少 ${field}`)
  }
  return String(value)
}

function requiredOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function requiredNumber(value: unknown, field: string): number {
  const number = finiteNumber(value)
  if (number === null) throw new Error(`星铁个人数据缺少 ${field}`)
  return number
}
