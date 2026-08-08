import type { GameId, SyncTarget } from '../../shared/contracts'
import {
  extractGenshinExplorationReviewCandidates,
  extractGenshinEventReviewCandidates,
  parseGenshinPersonalData
} from './genshin-personal-parser'
import {
  assertAnyPersonalRequestSucceeded,
  capturePersonalRequest,
  personalPartialSuffix,
  type PersonalRequestOutcome
} from './personal-sync-settler'
import type { SyncAdapter, SyncAdapterOutput, SyncProgressReporter } from './types'
import {
  assemblePersonalEventsFromCandidates,
  assemblePersonalMapsFromCandidates,
  withPersonalIdentity
} from './personal-snapshot'

export interface GenshinBattleChronicleClient {
  getProfile: () => Promise<unknown>
  getSpiralAbyss: () => Promise<unknown>
  getImaginariumTheater: () => Promise<unknown>
  getStygianOnslaught: () => Promise<unknown>
  getEventCalendar: () => Promise<unknown>
}

export class GenshinPersonalAdapter implements SyncAdapter {
  constructor(private readonly client: GenshinBattleChronicleClient) {}

  async sync(
    gameId: GameId,
    target: SyncTarget = 'all',
    reportProgress?: SyncProgressReporter
  ): Promise<SyncAdapterOutput> {
    if (gameId !== 'genshin') throw new Error('原神个人数据适配器不能用于其他游戏')
    // 保持顺序请求；同一平台完成一次人工验证后，后续请求通常可直接通过。
    const outcomes: PersonalRequestOutcome[] = []
    const total = target === 'events' || target === 'exploration' ? 1 : target === 'cycles' ? 3 : 5
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
    const profile = ['all', 'exploration'].includes(target)
      ? await request('正在读取原神地图进度', () => this.client.getProfile())
      : undefined
    const spiralAbyss = ['all', 'cycles'].includes(target)
      ? await request('正在读取深境螺旋战绩', () => this.client.getSpiralAbyss())
      : undefined
    const imaginariumTheater = ['all', 'cycles'].includes(target)
      ? await request('正在读取幻想真境剧诗战绩', () => this.client.getImaginariumTheater())
      : undefined
    const stygianOnslaught = ['all', 'cycles'].includes(target)
      ? await request('正在读取幽境危战战绩', () => this.client.getStygianOnslaught())
      : undefined
    const eventCalendar = ['all', 'events'].includes(target)
      ? await request('正在读取原神活动进度', () => this.client.getEventCalendar())
      : undefined
    assertAnyPersonalRequestSucceeded(outcomes)
    const suffix = personalPartialSuffix(outcomes)
    const hasChecklistData = [spiralAbyss, imaginariumTheater, stygianOnslaught]
      .some((value) => value !== undefined)
    const eventCandidates = eventCalendar === undefined
      ? []
      : extractGenshinEventReviewCandidates(eventCalendar)
    const explorationCandidates = profile === undefined
      ? []
      : extractGenshinExplorationReviewCandidates(profile)
    const cycleItems = hasChecklistData
      ? parseGenshinPersonalData({
            spiralAbyss,
            imaginariumTheater,
            stygianOnslaught
          })
      : []
    const eventSnapshot = assemblePersonalEventsFromCandidates(
      'genshin',
      'miyoushe',
      eventCandidates
    )
    const explorationSnapshot = assemblePersonalMapsFromCandidates(
      'miyoushe',
      explorationCandidates
    )
    return {
      items: [
        ...eventSnapshot.items,
        ...explorationSnapshot.items,
        ...withPersonalIdentity(cycleItems, 'miyoushe', 'personal-challenge-record')
      ],
      reviewCandidates: [
        ...eventSnapshot.reviewCandidates,
        ...explorationSnapshot.reviewCandidates
      ],
      snapshotCompleteness: outcomes.every((outcome) => outcome.succeeded) ? 'complete' : 'partial',
      adapterVersion: 'genshin-personal-v1',
      message: (target === 'events'
        ? '原神活动进度已读取'
        : target === 'exploration'
          ? '原神地图进度已同步'
          : target === 'cycles'
            ? '原神周期战绩已同步'
            : '原神地图和周期战绩已同步；活动进度已读取') + suffix
    }
  }
}
