import type { GameId, SyncTarget } from '../../shared/contracts'
import { parseZenlessPersonalData } from './zenless-personal-parser'
import type { SyncAdapter, SyncAdapterOutput } from './types'

export interface ZenlessBattleChronicleClient {
  getShiyuDefense: () => Promise<unknown>
  getDeadlyAssault: () => Promise<unknown>
  getZenlessEventCalendar: () => Promise<unknown>
}

export class ZenlessPersonalAdapter implements SyncAdapter {
  constructor(private readonly client: ZenlessBattleChronicleClient) {}

  async sync(gameId: GameId, target: SyncTarget = 'all'): Promise<SyncAdapterOutput> {
    if (gameId !== 'zenless') throw new Error('绝区零个人数据适配器不能用于其他游戏')
    if (target === 'exploration') {
      return { items: [], message: '米游社暂不提供绝区零区域探索百分比，已保留公开地图清单' }
    }
    // 保持顺序请求，降低同一平台短时间并发触发风控的概率。
    const shiyuDefense = ['all', 'cycles'].includes(target) ? await this.client.getShiyuDefense() : undefined
    const deadlyAssault = ['all', 'cycles'].includes(target) ? await this.client.getDeadlyAssault() : undefined
    const eventCalendar = ['all', 'events'].includes(target)
      ? await this.client.getZenlessEventCalendar()
      : undefined
    return {
      items: parseZenlessPersonalData({ shiyuDefense, deadlyAssault, eventCalendar }),
      message: target === 'events'
        ? '绝区零活动进度已同步'
        : target === 'cycles'
          ? '绝区零式舆防卫战和危局强袭战已同步'
          : '绝区零活动、式舆防卫战和危局强袭战已同步'
    }
  }
}
