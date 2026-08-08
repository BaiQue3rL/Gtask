import {
  officialPersonalFactAuthority,
  type NormalizedSyncItem,
  type SemanticReviewDraft
} from './types'
import { hasChallengeRecordEvidence } from './challenge-record-evidence'
import { finiteNumber } from './numbers'

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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`绝区零个人数据缺少 ${field}`)
  }
  return value.trim()
}

function explorationPercent(value: unknown, field: string): number {
  const progress = finiteNumber(value)
  if (progress === null || progress < 0 || progress > 100) {
    throw new Error(`绝区零个人数据的 ${field} 必须在 0 到 100 之间`)
  }
  return Math.round(progress * 100) / 100
}

export function extractZenlessExplorationReviewCandidates(value: unknown): SemanticReviewDraft[] {
  const root = requiredRecord(value, '区域收集')
  const groups = Array.isArray(root.area_collections)
    ? root.area_collections.filter(isRecord)
    : []
  const drafts: SemanticReviewDraft[] = []
  for (const group of groups) {
    const groupId = requiredIdentifier(group.urban_area_group_id, '一级区域 id')
    const groupName = requiredString(group.name, '一级区域名称')
    drafts.push({
      target: 'exploration',
      kind: 'personal-map-progress',
      payload: {
        factAuthority: officialPersonalFactAuthority(
          'identity',
          'localized_title',
          'progress',
          'hierarchy'
        ),
        provider: 'miyoushe',
        officialId: `group:${groupId}`,
        officialTitle: groupName,
        observedProgress: explorationPercent(
          group.collection_progress,
          `${groupName}探索度`
        ),
        observedNodeKind: 'region',
        observedParentId: null,
        observedParentTitle: null
      }
    })
    const areas = Array.isArray(group.map_collections)
      ? group.map_collections.filter(isRecord)
      : []
    for (const area of areas) {
      const areaId = requiredIdentifier(area.urban_area_id, '二级区域 id')
      const areaName = requiredString(area.name, '二级区域名称')
      drafts.push({
        target: 'exploration',
        kind: 'personal-map-progress',
        payload: {
          factAuthority: officialPersonalFactAuthority(
            'identity',
            'localized_title',
            'progress',
            'hierarchy'
          ),
          provider: 'miyoushe',
          officialId: `area:${areaId}`,
          officialTitle: areaName,
          observedProgress: explorationPercent(
            area.collection_progress,
            `${areaName}探索度`
          ),
          observedNodeKind: 'subregion',
          observedParentId: `group:${groupId}`,
          observedParentTitle: groupName
        }
      })
    }
  }
  if (drafts.length === 0) throw new Error('绝区零个人数据没有可识别的区域探索进度')
  return drafts
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

export function extractZenlessEventReviewCandidates(value: unknown): SemanticReviewDraft[] {
  const root = requiredRecord(value, '活动日历')
  const events = Array.isArray(root.activity_list) ? root.activity_list.filter(isRecord) : []
  return events.map((event) => {
    const id = requiredIdentifier(event.activity_id ?? event.id, '活动 id')
    const title = typeof event.name === 'string' && event.name.trim() ? event.name.trim() : null
    if (!title) throw new Error('绝区零个人数据缺少活动名称')
    return {
      target: 'events',
      kind: 'personal-item-semantics',
      payload: {
        factAuthority: officialPersonalFactAuthority(
          'identity',
          'localized_title',
          'time_window'
        ),
        sourceContext: 'miyoushe-zenless-event-calendar',
        officialEventId: id,
        title,
        normalizedStartAt: optionalUnixIso(event.start_ts),
        normalizedEndAt: optionalUnixIso(event.end_ts),
        observedTime: {
          startTimestamp: safeObservedValue(event.start_ts),
          endTimestamp: safeObservedValue(event.end_ts),
          startTime: safeObservedValue(event.start),
          endTime: safeObservedValue(event.end)
        },
        observedStatus: {
          state: typeof event.state === 'string' ? event.state : null,
          status: typeof event.status === 'string' ? event.status : null,
          obtainedCount: finiteNumber(event.monochrome_got_cnt),
          totalCount: finiteNumber(event.monochrome_cnt)
        }
      }
    }
  })
}

function optionalUnixIso(value: unknown): string | null {
  const timestamp = finiteNumber(value)
  if (timestamp === null || timestamp <= 0) return null
  const date = new Date(timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function safeObservedValue(value: unknown): string | number | null | Record<string, number | null> {
  if (typeof value === 'string' || typeof value === 'number') return value
  if (!isRecord(value)) return null
  return Object.fromEntries(
    ['year', 'month', 'day', 'hour', 'minute', 'second']
      .map((key) => [key, finiteNumber(value[key])])
  )
}

export function parseZenlessShiyuDefense(value: unknown): NormalizedSyncItem {
  const data = requiredRecord(value, '式舆防卫战')
  const scheduleId = requiredIdentifier(data.schedule_id, '式舆防卫战 schedule_id')
  const brief = isRecord(data.brief_info) ? data.brief_info : {}
  const score = finiteNumber(brief.score)
  const hasChallengeRecord = hasChallengeRecordEvidence({
    explicitFlags: [data.passed_fifth_floor],
    positiveValues: [score]
  })

  return {
    remoteKey: 'endgame:shiyu-defense',
    category: 'endgame',
    title: '式舆防卫战',
    completed: hasChallengeRecord,
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
  const completed = hasChallengeRecordEvidence({
    explicitFlags: [data.has_data, ...challenges.map((challenge) => challenge.has_data)],
    positiveValues: [
      earnedStars,
      ...challenges.flatMap((challenge) => [challenge.star, challenge.score])
    ]
  })

  return {
    remoteKey: 'endgame:deadly-assault',
    category: 'endgame',
    title: '危局强袭战',
    completed,
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
}): NormalizedSyncItem[] {
  const items: NormalizedSyncItem[] = []
  if (input.shiyuDefense !== undefined) items.push(parseZenlessShiyuDefense(input.shiyuDefense))
  if (input.deadlyAssault !== undefined) items.push(parseZenlessDeadlyAssault(input.deadlyAssault))
  if (items.length === 0) throw new Error('绝区零个人数据没有可识别的周期玩法')
  return items
}
