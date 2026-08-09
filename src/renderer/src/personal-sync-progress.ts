import type { GameId, PersonalSyncTarget, SyncProgressUpdate } from '../../shared/contracts'

export function personalProgressKey(gameId: GameId, target: PersonalSyncTarget): string {
  return `${gameId}:${target}`
}

export function isTerminalPersonalProgress(progress: SyncProgressUpdate): boolean {
  return progress.status === 'completed' ||
    progress.status === 'error' ||
    progress.status === 'cancelled'
}

export function applyPersonalProgressUpdate(
  current: Readonly<Record<string, SyncProgressUpdate>>,
  progress: SyncProgressUpdate
): Record<string, SyncProgressUpdate> {
  if (progress.target === 'all' || progress.target === 'tasks') return { ...current }
  const key = personalProgressKey(progress.gameId, progress.target)
  const next = { ...current }
  if (isTerminalPersonalProgress(progress)) delete next[key]
  else next[key] = progress
  return next
}
