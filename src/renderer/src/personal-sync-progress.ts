import type {
  AiScheduleJob,
  GameId,
  PersonalSyncTarget,
  SyncProgressUpdate
} from '../../shared/contracts'

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

export function reconcilePersonalProgressForGame(
  current: Readonly<Record<string, SyncProgressUpdate>>,
  gameId: GameId,
  activeJobs: readonly AiScheduleJob[],
  activeTargets: ReadonlySet<PersonalSyncTarget>
): Record<string, SyncProgressUpdate> {
  const next = { ...current }
  for (const target of ['events', 'cycles', 'exploration'] as const) {
    const hasActiveJob = activeJobs.some((job) =>
      job.gameId === gameId &&
      job.target === target &&
      (job.jobKind === 'personal_metadata' || job.jobKind === 'personal_review')
    )
    if (!hasActiveJob && !activeTargets.has(target)) {
      delete next[personalProgressKey(gameId, target)]
    }
  }
  return next
}

export function mergeLiveSyncProgresses(
  jobProgresses: readonly SyncProgressUpdate[],
  localProgresses: readonly SyncProgressUpdate[]
): SyncProgressUpdate[] {
  const merged = new Map<string, SyncProgressUpdate>()
  const keyOf = (progress: SyncProgressUpdate): string =>
    `${progress.gameId}:${progress.source}:${progress.target}`

  // Active AI jobs are the persisted source of truth once a metadata/review
  // task exists.  Adapter progress may still be retained locally while the
  // job is running, but must not render a second card for the same operation.
  for (const progress of jobProgresses) merged.set(keyOf(progress), progress)
  for (const progress of localProgresses) {
    const key = keyOf(progress)
    if (!merged.has(key)) merged.set(key, progress)
  }
  return [...merged.values()]
}
