import type { GameId, SyncTarget } from '../../shared/contracts'
import { parseStarRailPersonalData } from './star-rail-personal-parser'
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
    // 保持顺序请求，降低短时间并发触发米游社风控的概率。
    const memoryOfChaos = ['all', 'cycles'].includes(target) ? await this.client.getMemoryOfChaos() : undefined
    const pureFiction = ['all', 'cycles'].includes(target) ? await this.client.getPureFiction() : undefined
    const apocalypticShadow = ['all', 'cycles'].includes(target)
      ? await this.client.getApocalypticShadow()
      : undefined
    const anomalyArbitration = ['all', 'cycles'].includes(target)
      ? await this.client.getAnomalyArbitration()
      : undefined
    const eventCalendar = ['all', 'events'].includes(target)
      ? await this.client.getEventCalendar()
      : undefined
    return {
      items: parseStarRailPersonalData({
        memoryOfChaos,
        pureFiction,
        apocalypticShadow,
        anomalyArbitration,
        eventCalendar
      }),
      message: target === 'events'
        ? '星铁活动进度已同步'
        : target === 'cycles'
          ? '星铁四种周期战绩已同步'
          : '星铁活动和四种周期战绩已同步'
    }
  }
}
