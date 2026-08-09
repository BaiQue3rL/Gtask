import type { PersonalSyncTarget } from '../../shared/contracts'

const PERSONAL_SYNC_TARGET_ORDER: readonly PersonalSyncTarget[] = [
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

export function waitForPersonalSyncCooldown(milliseconds = 3_000): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds))
}
