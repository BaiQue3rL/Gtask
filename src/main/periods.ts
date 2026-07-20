export interface PeriodWindow {
  key: string
  startsAt: string
  endsAt: string
}

const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000

export function getWeeklyPeriod(
  reference = new Date(),
  resetWeekday = 1,
  timeZone = 'Asia/Shanghai'
): PeriodWindow {
  if (!Number.isInteger(resetWeekday) || resetWeekday < 1 || resetWeekday > 7) {
    throw new Error('周重置日必须在 1 到 7 之间')
  }
  if (timeZone !== 'Asia/Shanghai') throw new Error('当前版本只支持 Asia/Shanghai 周期时区')

  const localDate = new Date(reference.getTime() + SHANGHAI_UTC_OFFSET_MS)
  const currentWeekday = localDate.getUTCDay() || 7
  const daysSinceReset = (currentWeekday - resetWeekday + 7) % 7
  const localStartAsUtc = Date.UTC(
    localDate.getUTCFullYear(),
    localDate.getUTCMonth(),
    localDate.getUTCDate() - daysSinceReset
  )
  const startsAtMs = localStartAsUtc - SHANGHAI_UTC_OFFSET_MS
  const endsAtMs = startsAtMs + WEEK_MS
  const localStart = new Date(localStartAsUtc)
  const dateKey = [
    localStart.getUTCFullYear(),
    String(localStart.getUTCMonth() + 1).padStart(2, '0'),
    String(localStart.getUTCDate()).padStart(2, '0')
  ].join('-')

  return {
    key: `weekly:${timeZone}:${resetWeekday}:${dateKey}`,
    startsAt: new Date(startsAtMs).toISOString(),
    endsAt: new Date(endsAtMs).toISOString()
  }
}

