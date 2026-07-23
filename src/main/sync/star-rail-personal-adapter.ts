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
import type { SyncAdapter, SyncAdapterOutput } from './types'

export interface StarRailBattleChronicleClient {
  getMemoryOfChaos: () => Promise<unknown>
  getPureFiction: () => Promise<unknown>
  getApocalypticShadow: () => Promise<unknown>
  getAnomalyArbitration: () => Promise<unknown>
  getEventCalendar: () => Promise<unknown>
}

export class StarRailPersonalAdapter implements SyncAdapter {
  constructor(private readonly client: StarRailBattleChronicleClient) {}

  async sync(gameId: GameId, target: SyncTarget = 'all'): Promise<SyncAdapterOutput> {
    if (gameId !== 'star-rail') throw new Error('星铁个人数据适配器不能用于其他游戏')
    if (target === 'exploration') {
      return { items: [], message: '米游社暂不提供星铁区域探索百分比，已保留公开地图清单' }
    }
    if (target === 'events') {
      const outcomes: PersonalRequestOutcome[] = []
      const eventCalendar = await capturePersonalRequest(
        () => this.client.getEventCalendar(),
        outcomes
      )
      assertAnyPersonalRequestSucceeded(outcomes)
      return {
        items: [],
        reviewCandidates: extractStarRailEventReviewCandidates(eventCalendar),
        message: '星铁活动原始状态已脱敏，等待 Codex 核验'
      }
    }
    // 保持顺序请求，降低短时间并发触发米游社风控的概率。
    const outcomes: PersonalRequestOutcome[] = []
    const memoryOfChaos = ['all', 'cycles'].includes(target)
      ? await capturePersonalRequest(() => this.client.getMemoryOfChaos(), outcomes)
      : undefined
    const pureFiction = ['all', 'cycles'].includes(target)
      ? await capturePersonalRequest(() => this.client.getPureFiction(), outcomes)
      : undefined
    const apocalypticShadow = ['all', 'cycles'].includes(target)
      ? await capturePersonalRequest(() => this.client.getApocalypticShadow(), outcomes)
      : undefined
    const anomalyArbitration = ['all', 'cycles'].includes(target)
      ? await capturePersonalRequest(() => this.client.getAnomalyArbitration(), outcomes)
      : undefined
    const eventCalendar = target === 'all'
      ? await capturePersonalRequest(() => this.client.getEventCalendar(), outcomes)
      : undefined
    assertAnyPersonalRequestSucceeded(outcomes)
    const suffix = personalPartialSuffix(outcomes)
    return {
      items: parseStarRailPersonalData({
        memoryOfChaos,
        pureFiction,
        apocalypticShadow,
        anomalyArbitration
      }),
      reviewCandidates: eventCalendar === undefined
        ? []
        : extractStarRailEventReviewCandidates(eventCalendar),
      message: '星铁四种周期战绩已同步' + suffix
    }
  }
}
