export const AUTOMATIC_REMOTE_CHECK_COOLDOWN_MS = 24 * 60 * 60 * 1_000
export const MANUAL_REMOTE_CATALOG_COOLDOWN_MS = 60 * 60 * 1_000

export function remoteCheckCooldownRemaining(
  lastSuccessfulAt: string | null,
  reference: Date,
  cooldownMs: number
): number {
  const successfulAt = lastSuccessfulAt ? Date.parse(lastSuccessfulAt) : Number.NaN
  if (!Number.isFinite(successfulAt)) return 0
  const elapsed = reference.getTime() - successfulAt
  if (elapsed < 0) return 0
  return Math.max(0, cooldownMs - elapsed)
}

export function automaticRemoteCheckDelay(
  lastAttemptedAt: string | null,
  reference = new Date(),
  startupDelayMs = 0
): number {
  return Math.max(
    startupDelayMs,
    remoteCheckCooldownRemaining(lastAttemptedAt, reference, AUTOMATIC_REMOTE_CHECK_COOLDOWN_MS)
  )
}
