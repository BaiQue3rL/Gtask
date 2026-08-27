import type { ChecklistItem, ChecklistSource, GameId } from '../../shared/contracts'
import type { NormalizedSyncItem } from './types'

const DAY_MS = 24 * 60 * 60 * 1000

type CyclePredictionPolicy =
  | { kind: 'monthly'; startDay: number; hour: number; timeZoneOffsetHours: number }
  | { kind: 'interval'; anchorStartsAt: string; cadenceDays: number; durationDays: number }
  | {
      kind: 'version-relative'
      startDayOffset: number
      hour: number
      timeZoneOffsetHours: number
      fallback: Extract<CyclePredictionPolicy, { kind: 'interval' }>
    }

export interface CycleVersionWindow {
  startsAt: string
  endsAt: string
}

export interface CycleModeDefinition {
  gameId: GameId
  modeKey: string
  remoteKey: string
  title: string
  aliases: string[]
  prediction: CyclePredictionPolicy
}

export interface CycleWindow {
  startsAt: string
  endsAt: string
}

export const CYCLE_MODE_CATALOG: readonly CycleModeDefinition[] = [
  {
    gameId: 'genshin',
    modeKey: 'spiral-abyss',
    remoteKey: 'endgame:spiral-abyss',
    title: '深境螺旋',
    aliases: ['深境螺旋'],
    prediction: { kind: 'monthly', startDay: 16, hour: 4, timeZoneOffsetHours: 8 }
  },
  {
    gameId: 'genshin',
    modeKey: 'imaginarium-theater',
    remoteKey: 'endgame:imaginarium-theater',
    title: '幻想真境剧诗',
    aliases: ['幻想真境剧诗'],
    prediction: { kind: 'monthly', startDay: 1, hour: 4, timeZoneOffsetHours: 8 }
  },
  {
    gameId: 'genshin',
    modeKey: 'stygian-onslaught',
    remoteKey: 'endgame:stygian-onslaught',
    title: '幽境危战',
    aliases: ['幽境危战'],
    prediction: {
      kind: 'interval',
      anchorStartsAt: '2026-07-08T10:00:00+08:00',
      cadenceDays: 42,
      durationDays: 33.75
    }
  },
  {
    gameId: 'star-rail',
    modeKey: 'memory-of-chaos',
    remoteKey: 'endgame:memory-of-chaos',
    title: '混沌回忆',
    aliases: ['混沌回忆', '忘却之庭'],
    prediction: {
      kind: 'interval',
      anchorStartsAt: '2026-05-25T04:00:00+08:00',
      cadenceDays: 42,
      durationDays: 42
    }
  },
  {
    gameId: 'star-rail',
    modeKey: 'pure-fiction',
    remoteKey: 'endgame:pure-fiction',
    title: '虚构叙事',
    aliases: ['虚构叙事'],
    prediction: {
      kind: 'interval',
      anchorStartsAt: '2026-05-11T04:00:00+08:00',
      cadenceDays: 42,
      durationDays: 42
    }
  },
  {
    gameId: 'star-rail',
    modeKey: 'apocalyptic-shadow',
    remoteKey: 'endgame:apocalyptic-shadow',
    title: '末日幻影',
    aliases: ['末日幻影'],
    prediction: {
      kind: 'interval',
      anchorStartsAt: '2026-04-27T04:00:00+08:00',
      cadenceDays: 42,
      durationDays: 42
    }
  },
  {
    gameId: 'star-rail',
    modeKey: 'anomaly-arbitration',
    remoteKey: 'endgame:anomaly-arbitration',
    title: '异相仲裁',
    aliases: ['异相仲裁'],
    prediction: {
      kind: 'interval',
      anchorStartsAt: '2026-07-15T06:00:00+08:00',
      cadenceDays: 42,
      durationDays: 42
    }
  },
  {
    gameId: 'zenless',
    modeKey: 'shiyu-defense',
    remoteKey: 'endgame:shiyu-defense',
    title: '式舆防卫战',
    aliases: ['式舆防卫战', '式舆防卫战·剧变节点', '剧变节点'],
    prediction: {
      kind: 'interval',
      anchorStartsAt: '2025-01-03T04:00:00+08:00',
      cadenceDays: 14,
      durationDays: 14
    }
  },
  {
    gameId: 'zenless',
    modeKey: 'deadly-assault',
    remoteKey: 'endgame:deadly-assault',
    title: '危局强袭战',
    aliases: ['危局强袭战'],
    prediction: {
      kind: 'interval',
      anchorStartsAt: '2025-01-10T04:00:00+08:00',
      cadenceDays: 14,
      durationDays: 14
    }
  },
  {
    gameId: 'wuthering-waves',
    modeKey: 'tower-of-adversity',
    remoteKey: 'endgame:tower-of-adversity',
    title: '逆境深塔',
    aliases: ['逆境深塔'],
    prediction: {
      kind: 'interval',
      anchorStartsAt: '2026-07-20T04:00:00+08:00',
      cadenceDays: 28,
      durationDays: 28
    }
  },
  {
    gameId: 'wuthering-waves',
    modeKey: 'whimpering-wastes',
    remoteKey: 'endgame:whimpering-wastes',
    title: '冥歌海墟',
    aliases: ['冥歌海墟'],
    prediction: {
      kind: 'interval',
      anchorStartsAt: '2026-07-06T04:00:00+08:00',
      cadenceDays: 28,
      durationDays: 28
    }
  },
  {
    gameId: 'wuthering-waves',
    modeKey: 'endstate-matrix',
    remoteKey: 'endgame:endstate-matrix',
    title: '终焉矩阵',
    aliases: ['终焉矩阵'],
    prediction: {
      kind: 'version-relative',
      startDayOffset: 7,
      hour: 4,
      timeZoneOffsetHours: 8,
      fallback: {
        kind: 'interval',
        anchorStartsAt: '2026-07-17T04:00:00+08:00',
        cadenceDays: 42,
        durationDays: 34
      }
    }
  }
] as const

function normalizedTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '')
}

export function listCycleModes(gameId: GameId): CycleModeDefinition[] {
  return CYCLE_MODE_CATALOG.filter((definition) => definition.gameId === gameId)
}

export function findCycleMode(
  gameId: GameId,
  item: Pick<NormalizedSyncItem, 'modeKey' | 'remoteKey' | 'title'>
): CycleModeDefinition | null {
  const definitions = listCycleModes(gameId)
  const byIdentity = definitions.find((definition) =>
    definition.modeKey === item.modeKey || definition.remoteKey === item.remoteKey
  )
  if (byIdentity) return byIdentity
  const title = normalizedTitle(item.title)
  return definitions.find((definition) =>
    definition.aliases.some((alias) => title === normalizedTitle(alias))
  ) ?? null
}

function monthlyWindow(
  reference: Date,
  policy: Extract<CyclePredictionPolicy, { kind: 'monthly' }>
): CycleWindow {
  const shifted = new Date(reference.getTime() + policy.timeZoneOffsetHours * 60 * 60 * 1000)
  let year = shifted.getUTCFullYear()
  let month = shifted.getUTCMonth()
  const candidate = Date.UTC(
    year,
    month,
    policy.startDay,
    policy.hour - policy.timeZoneOffsetHours
  )
  if (candidate > reference.getTime()) {
    month -= 1
    if (month < 0) {
      month = 11
      year -= 1
    }
  }
  const startsAt = new Date(Date.UTC(
    year,
    month,
    policy.startDay,
    policy.hour - policy.timeZoneOffsetHours
  ))
  const endsAt = new Date(Date.UTC(
    year,
    month + 1,
    policy.startDay,
    policy.hour - policy.timeZoneOffsetHours
  ))
  return { startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() }
}

function intervalWindow(
  reference: Date,
  policy: Extract<CyclePredictionPolicy, { kind: 'interval' }>
): CycleWindow {
  const anchor = Date.parse(policy.anchorStartsAt)
  const cadence = policy.cadenceDays * DAY_MS
  const offset = Math.floor((reference.getTime() - anchor) / cadence)
  let startsAt = anchor + Math.max(0, offset) * cadence
  const duration = policy.durationDays * DAY_MS
  if (startsAt + duration <= reference.getTime()) startsAt += cadence
  return {
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(startsAt + duration).toISOString()
  }
}

function versionRelativeWindow(
  policy: Extract<CyclePredictionPolicy, { kind: 'version-relative' }>,
  versionWindow: CycleVersionWindow
): CycleWindow | null {
  const versionStart = Date.parse(versionWindow.startsAt)
  const versionEnd = Date.parse(versionWindow.endsAt)
  if (!Number.isFinite(versionStart) || !Number.isFinite(versionEnd) || versionStart >= versionEnd) {
    return null
  }
  const shifted = new Date(versionStart + policy.timeZoneOffsetHours * 60 * 60 * 1000)
  const startsAt = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate() + policy.startDayOffset,
    policy.hour - policy.timeZoneOffsetHours
  )
  if (startsAt >= versionEnd) return null
  return {
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(versionEnd).toISOString()
  }
}

function activeObservedWindow(
  existing: Pick<ChecklistItem, 'startsAt' | 'endsAt'> | undefined,
  reference: Date
): CycleWindow | null {
  if (!existing?.startsAt || !existing.endsAt) return null
  const start = Date.parse(existing.startsAt)
  const end = Date.parse(existing.endsAt)
  const duration = end - start
  if (!Number.isFinite(start) || !Number.isFinite(end) || duration <= 0) return null
  if (end <= reference.getTime()) return null
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }
}

export function predictCycleWindow(
  definition: CycleModeDefinition,
  reference = new Date(),
  existing?: Pick<ChecklistItem, 'startsAt' | 'endsAt'>,
  versionWindow?: CycleVersionWindow | null
): CycleWindow | null {
  if (definition.prediction.kind === 'version-relative' && versionWindow) {
    const predicted = versionRelativeWindow(definition.prediction, versionWindow)
    if (predicted) return predicted
  }
  const observed = activeObservedWindow(existing, reference)
  if (observed) return observed
  if (definition.prediction.kind === 'monthly') {
    return monthlyWindow(reference, definition.prediction)
  }
  if (definition.prediction.kind === 'interval') {
    return intervalWindow(reference, definition.prediction)
  }
  if (definition.prediction.kind === 'version-relative') {
    return intervalWindow(reference, definition.prediction.fallback)
  }
  return null
}

function normalizedKnownItem(
  definition: CycleModeDefinition,
  item: NormalizedSyncItem,
  window: CycleWindow | null
): NormalizedSyncItem {
  return {
    ...item,
    remoteKey: definition.remoteKey,
    title: definition.title,
    startsAt: item.startsAt ?? window?.startsAt ?? null,
    endsAt: item.endsAt ?? window?.endsAt ?? null,
    modeKey: definition.modeKey,
    scheduleKind: 'remote_schedule'
  }
}

function parsedTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? null : timestamp
}

function isFutureCycleItem(item: NormalizedSyncItem, reference: Date): boolean {
  const startsAt = parsedTimestamp(item.startsAt)
  return startsAt !== null && startsAt > reference.getTime()
}

function isCurrentCycleItem(item: NormalizedSyncItem, reference: Date): boolean {
  if (isFutureCycleItem(item, reference)) return false
  const endsAt = parsedTimestamp(item.endsAt)
  return endsAt === null || endsAt > reference.getTime()
}

function latestObservedWindow(
  definition: CycleModeDefinition,
  incomingItems: NormalizedSyncItem[],
  existingItems: ChecklistItem[]
): Pick<ChecklistItem, 'startsAt' | 'endsAt'> | undefined {
  const observations = [
    ...incomingItems.filter((item) =>
      item.category === 'endgame' &&
      (item.modeKey === definition.modeKey || item.remoteKey === definition.remoteKey)
    ),
    ...existingItems.filter((item) =>
      item.category === 'endgame' &&
      (item.modeKey === definition.modeKey || item.remoteKey === definition.remoteKey)
    )
  ].filter((item) => parsedTimestamp(item.startsAt) !== null && parsedTimestamp(item.endsAt) !== null)
  const latest = observations.sort((left, right) =>
    parsedTimestamp(right.endsAt)! - parsedTimestamp(left.endsAt)!
  )[0]
  return latest
    ? { startsAt: latest.startsAt ?? null, endsAt: latest.endsAt ?? null }
    : undefined
}

export function completeCycleCatalog(
  gameId: GameId,
  items: NormalizedSyncItem[],
  existingItems: ChecklistItem[],
  source: Extract<ChecklistSource, 'public_schedule' | 'personal_sync'>,
  reference = new Date(),
  versionWindow?: CycleVersionWindow | null
): NormalizedSyncItem[] {
  // A provider may keep returning the previous period until the player enters
  // the newly opened challenge.  Preserve that expired observation long
  // enough for the snapshot layer to tombstone its official identity, but do
  // not let it count as the current catalog member. Future provider rows are
  // discarded; during an intentional gap, the stable built-in rule may add
  // exactly the next canonical window so the mode never duplicates.
  const normalized = items.map((item) => {
    if (item.category !== 'endgame') return item
    const definition = findCycleMode(gameId, item)
    if (!definition) return item
    const existing = existingItems.find((candidate) =>
      candidate.category === 'endgame' && candidate.source === source &&
      (candidate.modeKey === definition.modeKey || candidate.remoteKey === definition.remoteKey)
    )
    return normalizedKnownItem(
      definition,
      item,
      predictCycleWindow(definition, reference, existing, versionWindow)
    )
  }).filter((item) => item.category !== 'endgame' || !isFutureCycleItem(item, reference))
  const presentModes = new Set(normalized
    .filter((item) => item.category === 'endgame' && isCurrentCycleItem(item, reference))
    .map((item) => item.modeKey)
    .filter((value): value is string => Boolean(value)))
  const additions = listCycleModes(gameId).flatMap((definition) => {
    if (presentModes.has(definition.modeKey)) return []
    const existing = existingItems.find((item) =>
      item.category === 'endgame' && item.source === source &&
      (item.modeKey === definition.modeKey || item.remoteKey === definition.remoteKey)
    )
    const observedWindow = latestObservedWindow(definition, normalized, existingItems)
    const window = predictCycleWindow(
      definition,
      reference,
      observedWindow ?? existing,
      versionWindow
    )
    const periodIdentity = window?.startsAt ?? 'awaiting-official-window'
    const periodKey = `predicted:${gameId}:${definition.modeKey}:${periodIdentity}`
    const placeholder: NormalizedSyncItem = {
      remoteKey: definition.remoteKey,
      category: 'endgame',
      title: definition.title,
      completed: false,
      startsAt: window?.startsAt ?? null,
      endsAt: window?.endsAt ?? null,
      periodKey,
      scheduleKind: 'remote_schedule',
      modeKey: definition.modeKey,
      resetRule: null
    }
    if (source === 'personal_sync') {
      placeholder.sourceIdentity = {
        provider: 'gtask-cycle-catalog',
        endpoint: 'predicted-cycle-window',
        externalId: `${definition.modeKey}|${periodKey}`
      }
    }
    return [placeholder]
  })
  return [...normalized, ...additions]
}

export function nextCyclePeriod(
  gameId: GameId,
  item: Pick<ChecklistItem, 'modeKey' | 'remoteKey' | 'title' | 'startsAt' | 'endsAt'>,
  reference = new Date(),
  versionWindow?: CycleVersionWindow | null
): (CycleWindow & { definition: CycleModeDefinition; periodKey: string }) | null {
  const definition = findCycleMode(gameId, {
    modeKey: item.modeKey,
    remoteKey: item.remoteKey ?? '',
    title: item.title
  })
  if (!definition) return null
  const window = predictCycleWindow(definition, reference, item, versionWindow)
  if (!window || Date.parse(window.endsAt) <= reference.getTime()) return null
  return {
    ...window,
    definition,
    periodKey: `predicted:${gameId}:${definition.modeKey}:${window.startsAt}`
  }
}
