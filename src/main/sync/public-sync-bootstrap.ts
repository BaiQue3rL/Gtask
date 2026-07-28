import type { GameId, SyncTarget } from '../../shared/contracts'
import type { NormalizedSyncItem } from './types'

export function getFixedWeeklyBootstrap(
  gameId: GameId,
  target: SyncTarget
): NormalizedSyncItem[] {
  if (target !== 'all' && target !== 'cycles') return []
  return [{
    remoteKey: `weekly:${gameId}`,
    category: 'weekly',
    title: '周常'
  }]
}
