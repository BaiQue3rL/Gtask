import type { GameId, PersonalSyncTarget } from '../../shared/contracts'

const PERSONAL_SYNC_TARGETS: Record<GameId, readonly PersonalSyncTarget[]> = {
  genshin: ['events', 'cycles', 'exploration'],
  'star-rail': ['events', 'cycles'],
  zenless: ['events', 'cycles', 'exploration'],
  'wuthering-waves': ['cycles', 'exploration']
}

export function getPersonalSyncTargets(gameId: GameId): PersonalSyncTarget[] {
  return [...PERSONAL_SYNC_TARGETS[gameId]]
}

export function supportsPersonalSyncTarget(gameId: GameId, target: PersonalSyncTarget): boolean {
  return PERSONAL_SYNC_TARGETS[gameId].includes(target)
}
