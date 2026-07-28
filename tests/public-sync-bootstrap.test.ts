import { describe, expect, it } from 'vitest'
import { SUPPORTED_GAME_IDS } from '../src/shared/contracts'
import { getFixedWeeklyBootstrap } from '../src/main/sync/public-sync-bootstrap'

describe('公开资料本地机械初始化', () => {
  it('四款游戏在全局或周期同步开始时都建立唯一固定周常', () => {
    for (const gameId of SUPPORTED_GAME_IDS) {
      expect(getFixedWeeklyBootstrap(gameId, 'all')).toEqual([{
        remoteKey: `weekly:${gameId}`,
        category: 'weekly',
        title: '周常'
      }])
      expect(getFixedWeeklyBootstrap(gameId, 'cycles')).toHaveLength(1)
      expect(getFixedWeeklyBootstrap(gameId, 'events')).toEqual([])
      expect(getFixedWeeklyBootstrap(gameId, 'exploration')).toEqual([])
      expect(getFixedWeeklyBootstrap(gameId, 'tasks')).toEqual([])
    }
  })
})
