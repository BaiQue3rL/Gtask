import type { GameId, SyncTarget } from '../../shared/contracts'
import {
  extractStarRailEventReviewCandidates,
  parseStarRailPersonalData
} from './star-rail-personal-parser'
import {
  assertAnyPersonalRequestSucceeded,
  capturePersonalRequest,
  personalPartialSuffix,
  type PersonalRequestOutcome
} from './personal-sync-settler'
import type { SyncAdapter, SyncAdapterOutput, SyncProgressReporter } from './types'
import { assemblePersonalEventsFromCandidates, withPersonalIdentity } from './personal-snapshot'

export interface StarRailBattleChronicleClient {
  getMemoryOfChaos: () => Promise<unknown>
  getPureFiction: () => Promise<unknown>
  getApocalypticShadow: () => Promise<unknown>
  getAnomalyArbitration: () => Promise<unknown>
  getEventCalendar: () => Promise<unknown>
}

export class StarRailPersonalAdapter implements SyncAdapter {
  constructor(private readonly client: StarRailBattleChronicleClient) {}

  async sync(
    gameId: GameId,
    target: SyncTarget = 'all',
    reportProgress?: SyncProgressReporter
  ): Promise<SyncAdapterOutput> {
    if (gameId !== 'star-rail') throw new Error('星铁个人数据适配器不能用于其他游戏')
    if (target === 'exploration') {
      return { items: [], message: '米游社暂不提供星铁区域探索百分比，已保留公开地图清单' }
    }
    if (target === 'events') {
      const outcomes: PersonalRequestOutcome[] = []
      reportProgress?.({
        phase: 'fetching',
        message: '正在读取星铁活动进度',
        current: 1,
        total: 1
      })
      const eventCalendar = await capturePersonalRequest(
        () => this.client.getEventCalendar(),
        outcomes
      )
      assertAnyPersonalRequestSucceeded(outcomes)
      const eventSnapshot = assemblePersonalEventsFromCandidates(
        'star-rail',
        'miyoushe',
        extractStarRailEventReviewCandidates(eventCalendar)
      )
      return {
        items: eventSnapshot.items,
        reviewCandidates: eventSnapshot.reviewCandidates,
        snapshotCompleteness: 'complete',
        adapterVersion: 'star-rail-personal-v1',
        message: '星铁活动进度已读取'
      }
    }
    // 保持顺序请求，降低短时间并发触发米游社风控的概率。
    const outcomes: PersonalRequestOutcome[] = []
    const total = target === 'cycles' ? 4 : 5
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
    const memoryOfChaos = ['all', 'cycles'].includes(target)
      ? await request('正在读取混沌回忆战绩', () => this.client.getMemoryOfChaos())
      : undefined
    const pureFiction = ['all', 'cycles'].includes(target)
      ? await request('正在读取虚构叙事战绩', () => this.client.getPureFiction())
      : undefined
    const apocalypticShadow = ['all', 'cycles'].includes(target)
      ? await request('正在读取末日幻影战绩', () => this.client.getApocalypticShadow())
      : undefined
    const anomalyArbitration = ['all', 'cycles'].includes(target)
      ? await request('正在读取异相仲裁战绩', () => this.client.getAnomalyArbitration())
      : undefined
    const eventCalendar = target === 'all'
      ? await request('正在读取星铁活动进度', () => this.client.getEventCalendar())
      : undefined
    assertAnyPersonalRequestSucceeded(outcomes)
    const suffix = personalPartialSuffix(outcomes)
    const hasCycleData = [
      memoryOfChaos,
      pureFiction,
      apocalypticShadow,
      anomalyArbitration
    ].some((value) => value !== undefined)
    const cycleItems = hasCycleData
      ? parseStarRailPersonalData({
          memoryOfChaos,
          pureFiction,
          apocalypticShadow,
          anomalyArbitration
        })
      : []
    const eventCandidates = eventCalendar === undefined
      ? []
      : extractStarRailEventReviewCandidates(eventCalendar)
    const eventSnapshot = assemblePersonalEventsFromCandidates(
      'star-rail',
      'miyoushe',
      eventCandidates
    )
    return {
      items: [
        ...eventSnapshot.items,
        ...withPersonalIdentity(cycleItems, 'miyoushe', 'personal-challenge-record')
      ],
      reviewCandidates: eventSnapshot.reviewCandidates,
      snapshotCompleteness: outcomes.every((outcome) => outcome.succeeded) ? 'complete' : 'partial',
      adapterVersion: 'star-rail-personal-v1',
      message: '星铁四种周期战绩已同步' + suffix
    }
  }
}
