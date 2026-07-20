import type { GameId } from '../../shared/contracts'
import { parseZenlessPersonalData } from './zenless-personal-parser'
import type { SyncAdapter, SyncAdapterOutput } from './types'

export interface ZenlessBattleChronicleClient {
  getShiyuDefense: () => Promise<unknown>
  getDeadlyAssault: () => Promise<unknown>
}

export class ZenlessPersonalAdapter implements SyncAdapter {
  constructor(private readonly client: ZenlessBattleChronicleClient) {}

  async sync(gameId: GameId): Promise<SyncAdapterOutput> {
    if (gameId !== 'zenless') throw new Error('绝区零个人数据适配器不能用于其他游戏')
    // 保持顺序请求，降低同一平台短时间并发触发风控的概率。
    const shiyuDefense = await this.client.getShiyuDefense()
    const deadlyAssault = await this.client.getDeadlyAssault()
    return {
      items: parseZenlessPersonalData({ shiyuDefense, deadlyAssault }),
      message: '绝区零式舆防卫战和危局强袭战已同步'
    }
  }
}
