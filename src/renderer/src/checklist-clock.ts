/** Wake the view only when a displayed minute or an exact lifecycle boundary changes. */
export function nextChecklistClockUpdate(instants: readonly (string | null)[], now: number): number {
  let next = now + (60_000 - now % 60_000) + 1
  for (const value of instants) {
    if (!value) continue
    const remaining = Date.parse(value) - now
    if (!Number.isFinite(remaining) || remaining <= 0) continue
    next = Math.min(next, now + remaining % 60_000 + 1, now + remaining)
  }
  return next
}
