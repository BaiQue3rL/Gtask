import type { GameId, SyncTarget } from '../../shared/contracts'
import {
  assertAnyPersonalRequestSucceeded,
  capturePersonalRequest,
  personalPartialSuffix,
  type PersonalRequestOutcome
} from './personal-sync-settler'
import {
  extractWutheringWavesExplorationReviewCandidates,
  parseWutheringWavesPersonalData
} from './wuthering-waves-personal-parser'
import type { SyncAdapter, SyncAdapterOutput, SyncProgressReporter } from './types'
import { personalMapsFromCandidates, withPersonalIdentity } from './personal-snapshot'

export interface WutheringWavesCommunityClient {
  getExploration: () => Promise<unknown>
  getTower: () => Promise<unknown>
  getSlash: () => Promise<unknown>
  getMatrix: () => Promise<unknown>
}

export class WutheringWavesPersonalAdapter implements SyncAdapter {
  constructor(private readonly client: WutheringWavesCommunityClient) {}

  async sync(
    gameId: GameId,
    target: SyncTarget = 'all',
    reportProgress?: SyncProgressReporter
  ): Promise<SyncAdapterOutput> {
    if (gameId !== 'wuthering-waves') {
      throw new Error('鸣潮个人数据适配器不能用于其他游戏')
    }
    const outcomes: PersonalRequestOutcome[] = []
    const total = target === 'exploration' ? 1 : target === 'cycles' ? 3 : 4
    let current = 0
    const request = async (message: string, operation: () => Promise<unknown>): Promise<unknown> => {
      current += 1
      reportProgress?.({ phase: 'fetching', message, current, total })
      const value = await capturePersonalRequest(operation, outcomes)
      if (!outcomes.at(-1)?.succeeded) {
        reportProgress?.({
          phase: 'fetching',
          message: `${message.replace('正在读取', '')}读取失败，继续下一项`,
          current,
          total
        })
      }
      return value
    }
    const exploration = ['all', 'exploration'].includes(target)
      ? await request('正在读取鸣潮地图探索进度', () => this.client.getExploration())
      : undefined
    const tower = ['all', 'cycles'].includes(target)
      ? await request('正在读取逆境深塔战绩', () => this.client.getTower())
      : undefined
    const slash = ['all', 'cycles'].includes(target)
      ? await request('正在读取冥歌海墟战绩', () => this.client.getSlash())
      : undefined
    const matrix = ['all', 'cycles'].includes(target)
      ? await request('正在读取终焉矩阵战绩', () => this.client.getMatrix())
      : undefined
    assertAnyPersonalRequestSucceeded(outcomes)
    const suffix = personalPartialSuffix(outcomes)
    const hasCycleData = [tower, slash, matrix].some((value) => value !== undefined)
    const cycleItems = hasCycleData
      ? parseWutheringWavesPersonalData({ tower, slash, matrix })
      : []
    const explorationCandidates = exploration === undefined
      ? []
      : extractWutheringWavesExplorationReviewCandidates(exploration)
    return {
      items: [
        ...personalMapsFromCandidates('kuro-community', explorationCandidates),
        ...withPersonalIdentity(cycleItems, 'kuro-community', 'personal-challenge-record')
      ],
      snapshotCompleteness: outcomes.every((outcome) => outcome.succeeded) ? 'complete' : 'partial',
      adapterVersion: 'wuthering-waves-personal-v1',
      message: (target === 'exploration'
        ? '鸣潮地图探索度已同步'
        : target === 'cycles'
          ? '鸣潮周期挑战记录已同步'
          : '鸣潮地图探索和周期挑战记录已同步') + suffix
    }
  }
}
