import type {
  PersonalSyncTarget,
  SyncIndicatorTarget,
  SyncStatus,
  SyncTarget,
  SyncTargetState
} from '../../shared/contracts'

export const PERSONAL_SYNC_TARGET_ORDER: readonly PersonalSyncTarget[] = [
  'events',
  'cycles',
  'exploration'
]

const GLOBAL_PUBLIC_TARGET_ORDER: readonly Exclude<SyncTarget, 'all'>[] = [
  'tasks',
  'events',
  'cycles',
  'exploration'
]

export function orderPersonalSyncTargets(
  targets: readonly PersonalSyncTarget[]
): PersonalSyncTarget[] {
  const supported = new Set(targets)
  return PERSONAL_SYNC_TARGET_ORDER.filter((target) => supported.has(target))
}

/**
 * A global public refresh must never be an implicit source switch. Tasks are
 * always public; other sections are included only while they are uninitialised
 * or already owned by the public catalogue.
 */
export function selectGuardedGlobalPublicTargets(
  states: readonly SyncTargetState[]
): Exclude<SyncTarget, 'all'>[] {
  const byTarget = new Map(states.map((state) => [state.target, state]))
  return GLOBAL_PUBLIC_TARGET_ORDER.filter((target) =>
    target === 'tasks' || byTarget.get(target)?.catalogSource !== 'personal_data'
  )
}

function newestTimestamp(
  states: readonly SyncTargetState[],
  field: 'lastSuccessAt' | 'lastAttemptAt'
): string | null {
  return states
    .map((state) => state[field])
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null
}

function aggregateStatus(states: readonly SyncTargetState[]): SyncStatus {
  const attempted = states.filter((state) => state.lastAttemptAt || state.lastSuccessAt)
  if (attempted.length === 0) return 'idle'
  if (attempted.some((state) => state.status === 'verification_required')) {
    return 'verification_required'
  }
  if (attempted.some((state) => state.status === 'error')) return 'error'
  if (attempted.some((state) => state.status === 'stale')) return 'stale'
  if (attempted.some((state) => state.status === 'idle')) return 'idle'
  if (attempted.length < states.length) return 'stale'
  return attempted.every((state) => state.status === 'success') ? 'success' : 'idle'
}

export function summarizeGlobalSyncState(
  states: readonly SyncTargetState[]
): SyncTargetState {
  const sectionStates = GLOBAL_PUBLIC_TARGET_ORDER
    .map((target) => states.find((state) => state.target === target))
    .filter((state): state is SyncTargetState => Boolean(state))
  const sources = new Set(sectionStates.map((state) => state.catalogSource).filter(Boolean))
  const coverage = sectionStates.length === GLOBAL_PUBLIC_TARGET_ORDER.length &&
    sectionStates.every((state) => state.catalogCoverage === 'complete')
    ? 'complete'
    : sectionStates.some((state) => state.catalogCoverage !== 'empty')
      ? 'partial'
      : 'empty'

  return {
    gameId: sectionStates[0]?.gameId ?? states[0]?.gameId ?? 'genshin',
    target: 'all' as SyncIndicatorTarget,
    lastSuccessAt: newestTimestamp(sectionStates, 'lastSuccessAt'),
    lastAttemptAt: newestTimestamp(sectionStates, 'lastAttemptAt'),
    status: aggregateStatus(sectionStates),
    catalogCoverage: coverage,
    catalogSource: sources.size === 1
      ? [...sources][0] as SyncTargetState['catalogSource']
      : null
  }
}

export function globalSyncSourceLabel(states: readonly SyncTargetState[]): string | null {
  const sources = new Set(
    states
      .filter((state) => state.target !== 'all' && state.catalogSource)
      .map((state) => state.catalogSource)
  )
  if (sources.size > 1) return '混合来源'
  if (sources.has('personal_data')) return '个人数据'
  if (sources.has('public_schedule')) return '公开数据'
  return null
}

export function waitForPersonalSyncCooldown(milliseconds = 3_000): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))
}
