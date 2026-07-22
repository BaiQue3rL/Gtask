import type { GameId, SyncTarget } from '../../shared/contracts'
import { parseGenshinPersonalData } from './genshin-personal-parser'
import {
  assertAnyPersonalRequestSucceeded,
  capturePersonalRequest,
  personalPartialSuffix,
  type PersonalRequestOutcome
} from './personal-sync-settler'
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
    const outcomes: PersonalRequestOutcome[] = []
    const profile = ['all', 'exploration'].includes(target)
      ? await capturePersonalRequest(() => this.client.getProfile(), outcomes)
      : undefined
    const spiralAbyss = ['all', 'cycles'].includes(target)
      ? await capturePersonalRequest(() => this.client.getSpiralAbyss(), outcomes)
      : undefined
    const imaginariumTheater = ['all', 'cycles'].includes(target)
      ? await capturePersonalRequest(() => this.client.getImaginariumTheater(), outcomes)
      : undefined
    const stygianOnslaught = ['all', 'cycles'].includes(target)
      ? await capturePersonalRequest(() => this.client.getStygianOnslaught(), outcomes)
      : undefined
    const eventCalendar = ['all', 'events'].includes(target)
      ? await capturePersonalRequest(() => this.client.getEventCalendar(), outcomes)
      : undefined
    assertAnyPersonalRequestSucceeded(outcomes)
    const suffix = personalPartialSuffix(outcomes)
    return {
      items: parseGenshinPersonalData({
        profile,
        spiralAbyss,
        imaginariumTheater,
        stygianOnslaught,
        eventCalendar
      }),
      message: (target === 'events'
        ? '原神活动进度已同步'
        : target === 'exploration'
          ? '原神地图探索度已同步'
          : target === 'cycles'
            ? '原神周期战绩已同步'
            : '原神活动、地图探索和周期战绩已同步') + suffix
    }
  }
}
