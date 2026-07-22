import type { GameId } from '../../shared/contracts'
import { parseGenshinPersonalData } from './genshin-personal-parser'
import type { SyncAdapter, SyncAdapterOutput } from './types'

export interface GenshinBattleChronicleClient {
  getProfile: () => Promise<unknown>
  getSpiralAbyss: () => Promise<unknown>
  getImaginariumTheater: () => Promise<unknown>
  getStygianOnslaught: () => Promise<unknown>
}

export class GenshinPersonalAdapter implements SyncAdapter {
  constructor(private readonly client: GenshinBattleChronicleClient) {}

  async sync(gameId: GameId): Promise<SyncAdapterOutput> {
    if (gameId !== 'genshin') throw new Error('原神个人数据适配器不能用于其他游戏')
    // 保持顺序请求；同一平台完成一次人工验证后，后续请求通常可直接通过。
    const profile = await this.client.getProfile()
    const spiralAbyss = await this.client.getSpiralAbyss()
    const imaginariumTheater = await this.client.getImaginariumTheater()
    const stygianOnslaught = await this.client.getStygianOnslaught()
    return {
      items: parseGenshinPersonalData({
        profile,
        spiralAbyss,
        imaginariumTheater,
        stygianOnslaught
      }),
      message: '原神地图探索和周期战绩已同步'
    }
  }
}
