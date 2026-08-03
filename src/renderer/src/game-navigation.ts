import type { GameSummary, GameVersionSummary } from '../../shared/contracts'

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
  return `版本剩余 ${days} 天 ${hours} 小时`
}
