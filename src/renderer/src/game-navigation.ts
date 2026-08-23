import type { GameSummary, GameVersionSummary } from '../../shared/contracts'

export type GameVersionDeadlineTone = 'distant' | 'normal' | 'urgent'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1_000
const THREE_WEEKS_MS = 3 * ONE_WEEK_MS

function validFutureTimestamp(value: string | null, referenceTime: number): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > referenceTime ? timestamp : null
}

export function orderGamesByVersion(
  games: readonly GameSummary[],
  versions: readonly GameVersionSummary[],
  referenceTime: number
): GameSummary[] {
  const endsAtByGame = new Map(versions.map((version) => [version.gameId, version.endsAt]))
  return [...games].sort((left, right) => {
    const leftEnd = validFutureTimestamp(endsAtByGame.get(left.id) ?? null, referenceTime)
    const rightEnd = validFutureTimestamp(endsAtByGame.get(right.id) ?? null, referenceTime)
    if (leftEnd !== null && rightEnd !== null && leftEnd !== rightEnd) return leftEnd - rightEnd
    if (leftEnd !== null) return -1
    if (rightEnd !== null) return 1
    return left.sortOrder - right.sortOrder
  })
}

export function formatGameVersionRemaining(
  endsAt: string | null,
  referenceTime: number
): string | null {
  const timestamp = validFutureTimestamp(endsAt, referenceTime)
  if (timestamp === null) return null
  const totalHours = Math.max(1, Math.ceil((timestamp - referenceTime) / 3_600_000))
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return `版本还剩 ${days} 天 ${hours} 小时`
}

export function isGameVersionDeadlineUrgent(
  endsAt: string | null,
  referenceTime: number
): boolean {
  const timestamp = validFutureTimestamp(endsAt, referenceTime)
  return timestamp !== null && timestamp - referenceTime < ONE_WEEK_MS
}

export function gameVersionDeadlineTone(
  endsAt: string | null,
  referenceTime: number
): GameVersionDeadlineTone | null {
  const timestamp = validFutureTimestamp(endsAt, referenceTime)
  if (timestamp === null) return null
  const remaining = timestamp - referenceTime
  if (remaining < ONE_WEEK_MS) return 'urgent'
  if (remaining > THREE_WEEKS_MS) return 'distant'
  return 'normal'
}
