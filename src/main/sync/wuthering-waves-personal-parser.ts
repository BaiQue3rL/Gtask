import {
  officialPersonalFactAuthority,
  type NormalizedSyncItem,
  type SemanticReviewDraft
} from './types'
import { finiteNumber } from './numbers'

export interface WutheringWavesPersonalPayload {
  exploration?: unknown
  tower?: unknown
  slash?: unknown
  matrix?: unknown
}

export function parseWutheringWavesPersonalData(
  input: WutheringWavesPersonalPayload
): NormalizedSyncItem[] {
  const items: NormalizedSyncItem[] = []
  if (input.exploration !== undefined) items.push(...parseWutheringWavesExploration(input.exploration))
  if (input.tower !== undefined) items.push(parseWutheringWavesTower(input.tower))
  if (input.slash !== undefined) items.push(parseWutheringWavesSlash(input.slash))
  if (input.matrix !== undefined) items.push(parseWutheringWavesMatrix(input.matrix))
  if (items.length === 0) throw new Error('鸣潮个人数据没有可识别的探索或周期挑战')
  return items
}

export function parseWutheringWavesExploration(value: unknown): NormalizedSyncItem[] {
  const root = requiredRecord(value, '地图探索')
  const groups = Array.isArray(root.exploreList) ? root.exploreList.filter(isRecord) : []
  const items: NormalizedSyncItem[] = []
  for (const group of groups) {
    const country = requiredRecord(group.country, '地图大区域')
    const countryId = requiredIdentifier(country.countryId, '地图大区域 id')
    const countryName = requiredString(country.countryName, '地图大区域名称')
    const countryProgress = percentage(group.countryProgress, `${countryName}探索度`)
    items.push({
      remoteKey: `exploration:country:${countryId}`,
      category: 'exploration',
      title: countryName,
      completed: countryProgress === 100,
      progressPercent: countryProgress,
      parentTitle: null,
      mapNodeKind: 'region',
      parentRemoteKey: null,
      modeKey: `exploration-country-${countryId}`
    })
    for (const area of recordArray(group.areaInfoList)) {
      const areaId = requiredIdentifier(area.areaId, '二级地图区域 id')
      const areaName = requiredString(area.areaName, '二级地图区域名称')
      const areaProgress = percentage(area.areaProgress, `${areaName}探索度`)
      items.push({
        remoteKey: `exploration:area:${areaId}`,
        category: 'exploration',
        title: areaName,
        completed: areaProgress === 100,
        progressPercent: areaProgress,
        parentTitle: countryName,
        mapNodeKind: 'subregion',
        parentRemoteKey: `exploration:country:${countryId}`,
        modeKey: `exploration-area-${areaId}`
      })
    }
  }
  return items
}

export function extractWutheringWavesExplorationReviewCandidates(
  value: unknown
): SemanticReviewDraft[] {
  const root = requiredRecord(value, '地图探索')
  const groups = Array.isArray(root.exploreList) ? root.exploreList.filter(isRecord) : []
  const drafts: SemanticReviewDraft[] = []
  for (const group of groups) {
    const country = requiredRecord(group.country, '地图大区域')
    const countryId = requiredIdentifier(country.countryId, '地图大区域 id')
    const countryName = requiredString(country.countryName, '地图大区域名称')
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
        provider: 'kuro-community',
        officialId: countryId,
        officialTitle: countryName,
        observedProgress: percentage(group.countryProgress, `${countryName}探索度`),
        observedNodeKind: 'region',
        observedParentId: null,
        observedParentTitle: null
      }
    })
    for (const area of recordArray(group.areaInfoList)) {
      const areaId = requiredIdentifier(area.areaId, '二级地图区域 id')
      const areaName = requiredString(area.areaName, '二级地图区域名称')
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
          provider: 'kuro-community',
          officialId: `area:${areaId}`,
          officialTitle: areaName,
          observedProgress: percentage(area.areaProgress, `${areaName}探索度`),
          observedNodeKind: 'subregion',
          observedParentId: countryId,
          observedParentTitle: countryName
        }
      })
    }
  }
  return drafts
}

export function parseWutheringWavesTower(value: unknown): NormalizedSyncItem {
  const root = requiredRecord(value, '逆境深塔')
  const difficulties = recordArray(root.difficultyList)
  const completed = difficulties.some((difficulty) =>
    recordArray(difficulty.towerAreaList).some((area) => {
      const floors = recordArray(area.floorList)
      return floors.length > 0 || (finiteNumber(area.star) ?? 0) > 0
    })
  )
  return endgameItem('tower-of-adversity', '逆境深塔', completed)
}

export function parseWutheringWavesSlash(value: unknown): NormalizedSyncItem {
  const root = requiredRecord(value, '冥歌海墟')
  const completed = recordArray(root.difficultyList).some((difficulty) =>
    (finiteNumber(difficulty.allScore) ?? 0) > 0 ||
    recordArray(difficulty.challengeList).some((challenge) =>
      recordArray(challenge.halfList).length > 0 || (finiteNumber(challenge.score) ?? 0) > 0
    )
  )
  return endgameItem('whimpering-wastes', '冥歌海墟', completed)
}

export function parseWutheringWavesMatrix(value: unknown): NormalizedSyncItem {
  const root = requiredRecord(value, '终焉矩阵')
  const completed = recordArray(root.modeDetails).some((mode) =>
    mode.hasRecord === true ||
    (finiteNumber(mode.score) ?? 0) > 0 ||
    (finiteNumber(mode.passBoss) ?? 0) > 0 ||
    recordArray(mode.teams).length > 0
  )
  return endgameItem('endstate-matrix', '终焉矩阵', completed)
}

function endgameItem(
  modeKey: string,
  title: string,
  completed: boolean
): NormalizedSyncItem {
  return {
    remoteKey: `endgame:${modeKey}`,
    category: 'endgame',
    title,
    completed,
    startsAt: null,
    endsAt: null,
    periodKey: `wuthering-waves:${modeKey}:current`,
    scheduleKind: 'remote_schedule',
    modeKey
  }
}

function percentage(value: unknown, field: string): number {
  const number = finiteNumber(value)
  if (number === null) throw new Error(`鸣潮个人数据缺少${field}`)
  return Math.round(Math.min(100, Math.max(0, number)) * 100) / 100
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`鸣潮个人数据缺少${field}`)
  return value
}

function requiredIdentifier(value: unknown, field: string): string {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new Error(`鸣潮个人数据缺少${field}`)
  }
  return String(value)
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`鸣潮个人数据缺少${field}`)
  return value.trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
