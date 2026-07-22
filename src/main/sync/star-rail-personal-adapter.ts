import type { GameId } from '../../shared/contracts'
import { parseStarRailPersonalData } from './star-rail-personal-parser'
import type { SyncAdapter, SyncAdapterOutput } from './types'

export interface StarRailBattleChronicleClient {
  getMemoryOfChaos: () => Promise<unknown>
  getPureFiction: () => Promise<unknown>
  getApocalypticShadow: () => Promise<unknown>
  getAnomalyArbitration: () => Promise<unknown>
}

export class StarRailPersonalAdapter implements SyncAdapter {
  constructor(private readonly client: StarRailBattleChronicleClient) {}

  async sync(gameId: GameId): Promise<SyncAdapterOutput> {
    if (gameId !== 'star-rail') throw new Error('星铁个人数据适配器不能用于其他游戏')
    // 保持顺序请求，降低短时间并发触发米游社风控的概率。
    const memoryOfChaos = await this.client.getMemoryOfChaos()
    const pureFiction = await this.client.getPureFiction()
    const apocalypticShadow = await this.client.getApocalypticShadow()
    const anomalyArbitration = await this.client.getAnomalyArbitration()
    return {
      items: parseStarRailPersonalData({
        memoryOfChaos,
        pureFiction,
        apocalypticShadow,
        anomalyArbitration
      }),
      message: '星铁四种周期战绩已同步'
    }
  }
}
