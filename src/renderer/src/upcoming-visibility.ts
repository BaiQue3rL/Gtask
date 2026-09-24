import type { ChecklistItem } from '../../shared/contracts'

export const SHOW_UPCOMING_BASELINE_ITEMS_STORAGE_KEY =
  'gtask.show-upcoming-baseline-items.v1'

export function readShowUpcomingBaselineItems(
  storage: Pick<Storage, 'getItem'>
): boolean {
  try {
    return JSON.parse(storage.getItem(SHOW_UPCOMING_BASELINE_ITEMS_STORAGE_KEY) ?? 'false') === true
  } catch {
    return false
  }
}

export function writeShowUpcomingBaselineItems(
  storage: Pick<Storage, 'setItem'>,
  enabled: boolean
): boolean {
  storage.setItem(SHOW_UPCOMING_BASELINE_ITEMS_STORAGE_KEY, JSON.stringify(enabled))
  return enabled
}

export function isUpcomingBaselineItem(
  item: Pick<ChecklistItem, 'source' | 'startsAt'>,
  referenceTime: number
): boolean {
  if (item.source !== 'public_schedule' || !item.startsAt) return false
  const startsAt = Date.parse(item.startsAt)
  return Number.isFinite(startsAt) && startsAt > referenceTime
}

export function filterUpcomingBaselineItems<Item extends Pick<ChecklistItem, 'source' | 'startsAt'>>(
  items: readonly Item[],
  referenceTime: number,
  showUpcoming: boolean
): Item[] {
  return showUpcoming
    ? [...items]
    : items.filter((item) => !isUpcomingBaselineItem(item, referenceTime))
}
