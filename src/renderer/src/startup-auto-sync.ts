const STARTUP_AUTO_SYNC_TIMESTAMP_KEY = 'gtask:startup-auto-sync:last-attempt-at'

export const STARTUP_AUTO_SYNC_COOLDOWN_MS = 10 * 60 * 1_000

export function claimStartupAutoSync(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  now = Date.now(),
  cooldownMs = STARTUP_AUTO_SYNC_COOLDOWN_MS
): boolean {
  try {
    const previous = Number(storage.getItem(STARTUP_AUTO_SYNC_TIMESTAMP_KEY))
    if (Number.isFinite(previous) && previous > 0 && now - previous < cooldownMs) {
      return false
    }
    storage.setItem(STARTUP_AUTO_SYNC_TIMESTAMP_KEY, String(now))
  } catch {
    // A disabled renderer storage must not disable automatic synchronization.
  }
  return true
}
