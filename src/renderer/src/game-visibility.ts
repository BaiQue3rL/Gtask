import { SUPPORTED_GAME_IDS, type GameId } from '../../shared/contracts'

export const GAME_VISIBILITY_STORAGE_KEY = 'gtask.hidden-games.v1'
const LEGACY_GAME_VISIBILITY_STORAGE_KEY = 'gacha-task-manager.hidden-games.v1'

export function normalizeHiddenGameIds(value: unknown): GameId[] {
  if (!Array.isArray(value)) return []
  const hidden = [...new Set(value.filter((id): id is GameId =>
    typeof id === 'string' && (SUPPORTED_GAME_IDS as readonly string[]).includes(id)
  ))]

  // A corrupt or hand-edited preference must never leave the application without a game to display.
  return hidden.length === SUPPORTED_GAME_IDS.length
    ? hidden.filter((id) => id !== SUPPORTED_GAME_IDS[0])
    : hidden
}

export function readHiddenGameIds(
  storage: Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'setItem' | 'removeItem'>>
): GameId[] {
  try {
    const current = storage.getItem(GAME_VISIBILITY_STORAGE_KEY)
    if (current) return normalizeHiddenGameIds(JSON.parse(current))
    const legacy = storage.getItem(LEGACY_GAME_VISIBILITY_STORAGE_KEY)
    if (!legacy) return []
    const migrated = normalizeHiddenGameIds(JSON.parse(legacy))
    storage.setItem?.(GAME_VISIBILITY_STORAGE_KEY, JSON.stringify(migrated))
    storage.removeItem?.(LEGACY_GAME_VISIBILITY_STORAGE_KEY)
    return migrated
  } catch {
    return []
  }
}

export function writeHiddenGameIds(
  storage: Pick<Storage, 'setItem'>,
  gameIds: readonly GameId[]
): GameId[] {
  const normalized = normalizeHiddenGameIds(gameIds)
  storage.setItem(GAME_VISIBILITY_STORAGE_KEY, JSON.stringify(normalized))
  return normalized
}
