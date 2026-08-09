import type { GameId } from '../../shared/contracts'
import type { NormalizedSyncItem, PersonalProgressCandidate } from './types'

type PersonalProvider = 'miyoushe' | 'kuro-community'

const CYCLE_TITLE_PATTERNS: Record<GameId, RegExp[]> = {
  genshin: [/深境螺旋/u, /幻想真境剧诗/u, /幽境危战/u],
  'star-rail': [/混沌回忆/u, /忘却之庭/u, /虚构叙事/u, /末日幻影/u, /异相仲裁/u],
  zenless: [/式舆防卫战/u, /危局强袭战/u],
  'wuthering-waves': [/逆境深塔/u, /冥歌海墟/u, /终焉矩阵/u, /千道门扉/u]
}

export function withPersonalIdentity(
  items: NormalizedSyncItem[],
  provider: PersonalProvider,
  endpoint: string
): NormalizedSyncItem[] {
  return items.map((item) => ({
    ...item,
    sourceIdentity: {
      provider,
      endpoint,
      externalId: item.periodKey
        ? `${item.remoteKey}|period:${item.periodKey}`
        : item.remoteKey
    }
  }))
}

export function personalEventsFromCandidates(
  gameId: GameId,
  provider: PersonalProvider,
  candidates: PersonalProgressCandidate[],
  reference = new Date()
): NormalizedSyncItem[] {
  const now = reference.getTime()
  const seen = new Set<string>()
  const items: NormalizedSyncItem[] = []
  for (const candidate of candidates) {
    if (candidate.target !== 'events') continue
    const id = candidate.payload.officialEventId
    const title = candidate.payload.title
    const endpoint = candidate.payload.sourceContext
    if ((typeof id !== 'string' && typeof id !== 'number') ||
      typeof title !== 'string' || !title.trim() ||
      typeof endpoint !== 'string' || !endpoint.trim()) {
      throw new Error('官方活动进度缺少稳定标识、名称或接口来源')
    }
    if (CYCLE_TITLE_PATTERNS[gameId].some((pattern) => pattern.test(title))) continue
    const startsAt = readIso(candidate.payload.normalizedStartAt)
    const endsAt = readIso(candidate.payload.normalizedEndAt)
    if (endsAt && Date.parse(endsAt) <= now) continue
    const externalId = String(id).trim()
    const remoteKey = `personal-event:${provider}:${endpoint}:${externalId}`
    if (seen.has(remoteKey)) continue
    seen.add(remoteKey)
    items.push({
      remoteKey,
      category: 'limited_event',
      title: title.trim(),
      startsAt,
      endsAt,
      scheduleKind: 'fixed_window',
      modeKey: `official-event-${externalId}`,
      sourceIdentity: { provider, endpoint, externalId }
      // 活动日历的状态字段不等于“玩家完成”，没有确定证据时不写 completed。
    })
  }
  return items
}

export function personalMapsFromCandidates(
  provider: PersonalProvider,
  candidates: PersonalProgressCandidate[]
): NormalizedSyncItem[] {
  const drafts = candidates.filter((candidate) => candidate.target === 'exploration')
  const remoteKeyByOfficialId = new Map<string, string>()
  for (const draft of drafts) {
    const id = readIdentifier(draft.payload.officialId)
    if (id) remoteKeyByOfficialId.set(id, `personal-map:${provider}:${id}`)
  }
  const items: NormalizedSyncItem[] = []
  for (const draft of drafts) {
    const id = readIdentifier(draft.payload.officialId)
    const title = typeof draft.payload.officialTitle === 'string'
      ? draft.payload.officialTitle.trim()
      : ''
    const progress = draft.payload.observedProgress
    const nodeKind = draft.payload.observedNodeKind
    if (!id || !title || typeof progress !== 'number' || !Number.isFinite(progress) ||
      progress < 0 || progress > 100) {
      throw new Error('官方地图进度缺少稳定标识、名称或进度')
    }
    const parentId = readIdentifier(draft.payload.observedParentId)
    const parentRemoteKey = parentId ? remoteKeyByOfficialId.get(parentId) ?? null : null
    const validNodeKind = nodeKind === 'region' || nodeKind === 'subregion' ? nodeKind : null
    items.push({
      remoteKey: remoteKeyByOfficialId.get(id)!,
      category: 'exploration',
      title,
      completed: progress === 100,
      progressPercent: progress,
      parentTitle: typeof draft.payload.observedParentTitle === 'string'
        ? draft.payload.observedParentTitle.trim() || null
        : null,
      mapNodeKind: validNodeKind,
      parentRemoteKey,
      modeKey: `official-map-${id}`,
      sourceIdentity: {
        provider,
        endpoint: 'personal-map-progress',
        externalId: id
      }
    })
  }
  return items
}

function readIdentifier(value: unknown): string | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) return null
  return String(value).trim()
}

function readIso(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString()
}
