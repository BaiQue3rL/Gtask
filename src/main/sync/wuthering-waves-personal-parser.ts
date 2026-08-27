import {
  type NormalizedSyncItem,
  type PersonalProgressCandidate
} from './types'
import { hasChallengeRecordEvidence } from './challenge-record-evidence'
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

export function extractWutheringWavesExplorationProgressCandidates(
  value: unknown
): PersonalProgressCandidate[] {
  const root = requiredRecord(value, '地图探索')
  const groups = Array.isArray(root.exploreList) ? root.exploreList.filter(isRecord) : []
  const drafts: PersonalProgressCandidate[] = []
  for (const group of groups) {
    const country = requiredRecord(group.country, '地图大区域')
    const countryId = requiredIdentifier(country.countryId, '地图大区域 id')
    const countryName = requiredString(country.countryName, '地图大区域名称')
    drafts.push({
      target: 'exploration',
      kind: 'personal-map-progress',
      payload: {
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
  const difficulties = recordArray(root.difficultyList).filter(isRecurringTowerDifficulty)
  const manualFloors = difficulties.flatMap((difficulty) => {
    const areas = recordArray(difficulty.towerAreaList)
    return areas.flatMap((area, areaIndex) => {
      const isCentralArea = isCentralTowerArea(area, areaIndex, areas.length)
      return recordArray(area.floorList).filter((floor) => (
        isCentralArea || (finiteNumber(floor.floor) ?? 0) >= 4
      ))
    })
  })
  const completed = hasChallengeRecordEvidence({
    explicitFlags: manualFloors.map((floor) => floor.hasRecord),
    positiveValues: manualFloors.flatMap((floor) => [floor.star, floor.score])
  })
  return endgameItem(
    'tower-of-adversity',
    '逆境深塔',
    completed,
    optionalUnixIso(root.seasonEndTime)
  )
}

export function parseWutheringWavesSlash(value: unknown): NormalizedSyncItem {
  const root = requiredRecord(value, '冥歌海墟')
  const difficulties = recordArray(root.difficultyList)
  const challenges = difficulties
    .flatMap((difficulty) => recordArray(difficulty.challengeList))
    .filter((challenge) => {
      const challengeId = finiteNumber(
        challenge.challengeId ?? challenge.challenge_id ?? challenge.id
      )
      return challengeId !== null && challengeId >= 9 && challengeId <= 12
    })
  const halves = challenges.flatMap((challenge) => recordArray(challenge.halfList))
  const completed = hasChallengeRecordEvidence({
    explicitFlags: [
      ...challenges.map((challenge) => challenge.hasRecord),
      ...halves.map((half) => half.hasRecord)
    ],
    positiveValues: [
      ...challenges.map((challenge) => challenge.score),
      ...halves.map((half) => half.score)
    ]
  })
  return endgameItem(
    'whimpering-wastes',
    '冥歌海墟',
    completed,
    optionalUnixIso(root.seasonEndTime)
  )
}

export function parseWutheringWavesMatrix(value: unknown): NormalizedSyncItem {
  const root = requiredRecord(value, '终焉矩阵')
  const modes = recordArray(root.modeDetails)
  const completed = hasChallengeRecordEvidence({
    explicitFlags: [root.hasRecord, ...modes.map((mode) => mode.hasRecord)],
    positiveValues: modes.flatMap((mode) => [mode.score, mode.passBoss])
  })
  return endgameItem(
    'endstate-matrix',
    '终焉矩阵',
    completed,
    optionalUnixIso(root.endTime)
  )
}

function endgameItem(
  modeKey: string,
  title: string,
  completed: boolean,
  endsAt: string | null
): NormalizedSyncItem {
  return {
    remoteKey: `endgame:${modeKey}`,
    category: 'endgame',
    title,
    completed,
    startsAt: null,
    endsAt,
    periodKey: `wuthering-waves:${modeKey}:${endsAt ?? 'current'}`,
    scheduleKind: 'remote_schedule',
    modeKey
  }
}

function optionalUnixIso(value: unknown): string | null {
  const number = finiteNumber(value)
  if (number === null || number <= 0) return null
  const milliseconds = number >= 1e12 ? number : number * 1000
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function percentage(value: unknown, field: string): number {
  const number = finiteNumber(value)
  if (number === null) throw new Error(`鸣潮个人数据缺少${field}`)
  return Math.round(Math.min(100, Math.max(0, number)) * 100) / 100
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

function isRecurringTowerDifficulty(difficulty: Record<string, unknown>): boolean {
  const name = normalizedTitle(difficulty.difficultyName ?? difficulty.name)
  return name.includes('深境区') || /hazard\s*zone|deep\s*zone/iu.test(name)
}

function isCentralTowerArea(
  area: Record<string, unknown>,
  index: number,
  areaCount: number
): boolean {
  const name = normalizedTitle(area.areaName ?? area.name)
  if (name.includes('深境之塔') || /hazard\s*tower|deep\s*tower/iu.test(name)) return true
  return areaCount >= 3 && index > 0 && index < areaCount - 1
}

function normalizedTitle(value: unknown): string {
  return typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, '') : ''
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
