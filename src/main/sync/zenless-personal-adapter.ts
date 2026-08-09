import type { GameId, SyncTarget } from '../../shared/contracts'
import {
  extractZenlessExplorationProgressCandidates,
  extractZenlessEventProgressCandidates,
  parseZenlessPersonalData
} from './zenless-personal-parser'
import {
  assertAnyPersonalRequestSucceeded,
  capturePersonalRequest,
  personalPartialSuffix,
  type PersonalRequestOutcome
} from './personal-sync-settler'
import type { SyncAdapter, SyncAdapterOutput, SyncProgressReporter } from './types'
import {
  personalEventsFromCandidates,
  personalMapsFromCandidates,
  withPersonalIdentity
} from './personal-snapshot'

export interface ZenlessBattleChronicleClient {
  getShiyuDefense: () => Promise<unknown>
  getDeadlyAssault: () => Promise<unknown>
  getZenlessEventCalendar: () => Promise<unknown>
  getZenlessExploration: () => Promise<unknown>
}

export class ZenlessPersonalAdapter implements SyncAdapter {
  constructor(private readonly client: ZenlessBattleChronicleClient) {}

  async sync(
    gameId: GameId,
    target: SyncTarget = 'all',
    reportProgress?: SyncProgressReporter
  ): Promise<SyncAdapterOutput> {
    if (gameId !== 'zenless') throw new Error('绝区零个人数据适配器不能用于其他游戏')
    // 保持顺序请求，降低同一平台短时间并发触发风控的概率。
    const outcomes: PersonalRequestOutcome[] = []
    const total = target === 'events' || target === 'exploration'
      ? 1
      : target === 'cycles'
        ? 2
        : 4
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
    const shiyuDefense = ['all', 'cycles'].includes(target)
      ? await request('正在读取式舆防卫战战绩', () => this.client.getShiyuDefense())
      : undefined
    const deadlyAssault = ['all', 'cycles'].includes(target)
      ? await request('正在读取危局强袭战战绩', () => this.client.getDeadlyAssault())
      : undefined
    const eventCalendar = ['all', 'events'].includes(target)
      ? await request('正在读取绝区零活动进度', () => this.client.getZenlessEventCalendar())
      : undefined
    const exploration = ['all', 'exploration'].includes(target)
      ? await request('正在读取绝区零区域探索进度', () => this.client.getZenlessExploration())
      : undefined
    assertAnyPersonalRequestSucceeded(outcomes)
    const suffix = personalPartialSuffix(outcomes)
    const hasChecklistData = [shiyuDefense, deadlyAssault].some((value) => value !== undefined)
    const cycleItems = hasChecklistData
      ? parseZenlessPersonalData({ shiyuDefense, deadlyAssault })
      : []
    const eventCandidates = eventCalendar === undefined
      ? []
      : extractZenlessEventProgressCandidates(eventCalendar)
    const explorationCandidates = exploration === undefined
      ? []
      : extractZenlessExplorationProgressCandidates(exploration)
    const eventItems = personalEventsFromCandidates(
      'zenless',
      'miyoushe',
      eventCandidates
    )
    const explorationItems = personalMapsFromCandidates(
      'miyoushe',
      explorationCandidates
    )
    return {
      items: [
        ...eventItems,
        ...withPersonalIdentity(cycleItems, 'miyoushe', 'personal-challenge-record'),
        ...explorationItems
      ],
      snapshotCompleteness: outcomes.every((outcome) => outcome.succeeded) ? 'complete' : 'partial',
      adapterVersion: 'zenless-personal-v1',
      message: (target === 'events'
        ? '绝区零活动进度已读取'
        : target === 'exploration'
          ? '绝区零区域探索进度已读取'
        : target === 'cycles'
          ? '绝区零式舆防卫战和危局强袭战已同步'
          : '绝区零两种周期战绩、活动与区域探索进度已读取') + suffix
    }
  }
}
