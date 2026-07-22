import type { GameId, SyncTarget } from '../../shared/contracts'
import { parseGenshinPersonalData } from './genshin-personal-parser'
import type { SyncAdapter, SyncAdapterOutput } from './types'

export interface GenshinBattleChronicleClient {
  getProfile: () => Promise<unknown>
  getSpiralAbyss: () => Promise<unknown>
  getImaginariumTheater: () => Promise<unknown>
  getStygianOnslaught: () => Promise<unknown>
  getEventCalendar: () => Promise<unknown>
}

export class GenshinPersonalAdapter implements SyncAdapter {
  constructor(private readonly client: GenshinBattleChronicleClient) {}

  async sync(gameId: GameId, target: SyncTarget = 'all'): Promise<SyncAdapterOutput> {
    if (gameId !== 'genshin') throw new Error('原神个人数据适配器不能用于其他游戏')
    // 保持顺序请求；同一平台完成一次人工验证后，后续请求通常可直接通过。
    const profile = ['all', 'exploration'].includes(target) ? await this.client.getProfile() : undefined
    const spiralAbyss = ['all', 'cycles'].includes(target) ? await this.client.getSpiralAbyss() : undefined
    const imaginariumTheater = ['all', 'cycles'].includes(target)
      ? await this.client.getImaginariumTheater()
      : undefined
    const stygianOnslaught = ['all', 'cycles'].includes(target)
      ? await this.client.getStygianOnslaught()
      : undefined
    const eventCalendar = ['all', 'events'].includes(target)
      ? await this.client.getEventCalendar()
      : undefined
    return {
      items: parseGenshinPersonalData({
        profile,
        spiralAbyss,
        imaginariumTheater,
        stygianOnslaught,
        eventCalendar
      }),
      message: target === 'events'
        ? '原神活动进度已同步'
        : target === 'exploration'
          ? '原神地图探索度已同步'
          : target === 'cycles'
            ? '原神周期战绩已同步'
            : '原神活动、地图探索和周期战绩已同步'
    }
  }
}
