export interface RecurringWindow {
  startsAt: string
  endsAt: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

export function rollRecurringWindow(
  startsAt: string,
  endsAt: string,
  recurrenceRule: string,
  reference = new Date()
): RecurringWindow | null {
  let start = Date.parse(startsAt)
  let end = Date.parse(endsAt)
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null
  if (end > reference.getTime()) return null

  const interval = /^interval-days:(\d{1,3})$/.exec(recurrenceRule)
  if (interval) {
    const days = Number(interval[1])
    if (days < 1 || days > 366) return null
    const duration = days * DAY_MS
    while (end <= reference.getTime()) {
      start = end
      end += duration
    }
    return { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }
  }

  const monthly = /^monthly-days:([\d,]+)@(\d{2}):(\d{2})\[Asia\/Shanghai\]$/.exec(recurrenceRule)
  if (!monthly) return null
  const days = [...new Set(monthly[1].split(',').map(Number))]
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 31)
    .sort((left, right) => left - right)
  const hour = Number(monthly[2])
  const minute = Number(monthly[3])
  if (days.length === 0 || hour > 23 || minute > 59) return null

  while (end <= reference.getTime()) {
    start = end
    end = nextShanghaiMonthlyBoundary(end, days, hour, minute)
  }
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }
}

function nextShanghaiMonthlyBoundary(
  afterTimestamp: number,
  days: number[],
  hour: number,
  minute: number
): number {
  const local = new Date(afterTimestamp + SHANGHAI_OFFSET_MS)
  for (let monthOffset = 0; monthOffset <= 24; monthOffset += 1) {
    const monthAnchor = new Date(Date.UTC(
      local.getUTCFullYear(),
      local.getUTCMonth() + monthOffset,
      1
    ))
    const year = monthAnchor.getUTCFullYear()
    const month = monthAnchor.getUTCMonth()
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
    for (const day of days) {
      if (day > daysInMonth) continue
      const candidate = Date.UTC(year, month, day, hour, minute) - SHANGHAI_OFFSET_MS
      if (candidate > afterTimestamp) return candidate
    }
  }
  throw new Error('无法计算下一周期')
}
