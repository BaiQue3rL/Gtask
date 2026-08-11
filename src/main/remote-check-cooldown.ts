export const AUTOMATIC_REMOTE_CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1_000

export function automaticRemoteCheckDelay(
  lastAttemptedAt: string | null,
  reference = new Date(),
  startupDelayMs = 0
): number {
  const attemptedAt = lastAttemptedAt ? Date.parse(lastAttemptedAt) : Number.NaN
  if (!Number.isFinite(attemptedAt)) return startupDelayMs
  const elapsed = reference.getTime() - attemptedAt
  if (elapsed < 0) return startupDelayMs
  return Math.max(startupDelayMs, AUTOMATIC_REMOTE_CHECK_COOLDOWN_MS - elapsed)
}
