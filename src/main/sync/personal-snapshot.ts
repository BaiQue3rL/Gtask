import type { GameId } from '../../shared/contracts'
import type { NormalizedSyncItem, SemanticReviewDraft } from './types'

type PersonalProvider = 'miyoushe' | 'kuro-community'

const CYCLE_TITLE_PATTERNS: Record<GameId, RegExp[]> = {
  genshin: [/深境螺旋/u, /幻想真境剧诗/u, /幽境危战/u],
  'star-rail': [/混沌回忆/u, /忘却之庭/u, /虚构叙事/u, /末日幻影/u, /异相仲裁/u],
  zenless: [/式舆防卫战/u, /危局强袭战/u],
  'wuthering-waves': [/逆境深塔/u, /冥歌海墟/u, /终焉矩阵/u, /千道门扉/u]
}

export interface PersonalSnapshotAssembly {
  items: NormalizedSyncItem[]
  reviewCandidates: SemanticReviewDraft[]
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
  candidates: SemanticReviewDraft[],
  reference = new Date()
): NormalizedSyncItem[] {
  return assemblePersonalEventsFromCandidates(
    gameId,
    provider,
    candidates,
    reference
  ).items
}

export function assemblePersonalEventsFromCandidates(
  gameId: GameId,
  provider: PersonalProvider,
  candidates: SemanticReviewDraft[],
  reference = new Date()
): PersonalSnapshotAssembly {
  const now = reference.getTime()
  const seen = new Set<string>()
  const items: NormalizedSyncItem[] = []
  const reviewCandidates: SemanticReviewDraft[] = []
  for (const candidate of candidates) {
    if (candidate.target !== 'events') continue
    const id = candidate.payload.officialEventId
    const title = candidate.payload.title
    const endpoint = candidate.payload.sourceContext
    if ((typeof id !== 'string' && typeof id !== 'number') ||
      typeof title !== 'string' || !title.trim() ||
      typeof endpoint !== 'string' || !endpoint.trim()) {
      throw new Error('官方活动快照缺少稳定标识、名称或接口来源')
    }
    if (CYCLE_TITLE_PATTERNS[gameId].some((pattern) => pattern.test(title))) continue
    const startsAt = readIso(candidate.payload.normalizedStartAt)
    const endsAt = readIso(candidate.payload.normalizedEndAt)
    if (endsAt && Date.parse(endsAt) <= now) continue
    const externalId = String(id).trim()
    const remoteKey = `personal-event:${provider}:${endpoint}:${externalId}`
    if (seen.has(remoteKey)) continue
    seen.add(remoteKey)
    const item: NormalizedSyncItem = {
      remoteKey,
      category: 'limited_event' as const,
      title: title.trim(),
      startsAt,
      endsAt,
      scheduleKind: 'fixed_window' as const,
      modeKey: `official-event-${externalId}`,
      sourceIdentity: { provider, endpoint, externalId }
      // 官方活动日历的状态字段语义并不等同于“玩家完成”，因此不猜 completed。
    }
    items.push(item)
    reviewCandidates.push({
      ...candidate,
      payload: {
        ...candidate.payload,
        provider,
        reviewIssues: [
          'classification',
          'completion_semantics',
          ...(!startsAt || !endsAt ? ['time_window'] : [])
        ],
        proposedItem: item
      }
    })
  }
  return { items, reviewCandidates }
}

export function personalMapsFromCandidates(
  provider: PersonalProvider,
  candidates: SemanticReviewDraft[]
): NormalizedSyncItem[] {
  const assembly = assemblePersonalMapsFromCandidates(provider, candidates)
  if (assembly.reviewCandidates.length > 0) {
    const title = assembly.reviewCandidates[0]?.payload.officialTitle
    throw new Error(`官方二级地区“${typeof title === 'string' ? title : '未知地区'}”缺少同批次一级父地区`)
  }
  return assembly.items
}

export function assemblePersonalMapsFromCandidates(
  provider: PersonalProvider,
  candidates: SemanticReviewDraft[]
): PersonalSnapshotAssembly {
  const drafts = candidates.filter((candidate) => candidate.target === 'exploration')
  const remoteKeyByOfficialId = new Map<string, string>()
  for (const draft of drafts) {
    const id = readIdentifier(draft.payload.officialId)
    if (id) remoteKeyByOfficialId.set(id, `personal-map:${provider}:${id}`)
  }
  const items: NormalizedSyncItem[] = []
  const reviewCandidates: SemanticReviewDraft[] = []
  for (const draft of drafts) {
    const id = readIdentifier(draft.payload.officialId)
    const title = typeof draft.payload.officialTitle === 'string'
      ? draft.payload.officialTitle.trim()
      : ''
    const progress = draft.payload.observedProgress
    const nodeKind = draft.payload.observedNodeKind
    if (!id || !title || typeof progress !== 'number' || !Number.isFinite(progress) ||
      progress < 0 || progress > 100) {
      throw new Error('官方地图快照缺少稳定标识、名称或进度')
    }
    const parentId = readIdentifier(draft.payload.observedParentId)
    const parentRemoteKey = parentId ? remoteKeyByOfficialId.get(parentId) ?? null : null
    if (
      (nodeKind !== 'region' && nodeKind !== 'subregion') ||
      (nodeKind === 'region' && parentId !== null) ||
      (nodeKind === 'subregion' && !parentRemoteKey)
    ) {
      reviewCandidates.push({
        ...draft,
        payload: {
          ...draft.payload,
          provider,
          sourceContext: 'personal-map-progress',
          reviewIssues: ['hierarchy'],
          proposedItem: {
            remoteKey: remoteKeyByOfficialId.get(id)!,
            category: 'exploration',
            title,
            completed: progress === 100,
            progressPercent: progress,
            sourceIdentity: {
              provider,
              endpoint: 'personal-map-progress',
              externalId: id
            }
          }
        }
      })
      continue
    }
    items.push({
      remoteKey: remoteKeyByOfficialId.get(id)!,
      category: 'exploration' as const,
      title,
      completed: progress === 100,
      progressPercent: progress,
      parentTitle: typeof draft.payload.observedParentTitle === 'string'
        ? draft.payload.observedParentTitle.trim() || null
        : null,
      mapNodeKind: nodeKind,
      parentRemoteKey,
      modeKey: `official-map-${id}`,
      sourceIdentity: {
        provider,
        endpoint: 'personal-map-progress',
        externalId: id
      }
    })
  }
  return { items, reviewCandidates }
}

function readIdentifier(value: unknown): string | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) return null
  return String(value).trim()
}

function readIso(value: unknown): string | null {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString()
}
