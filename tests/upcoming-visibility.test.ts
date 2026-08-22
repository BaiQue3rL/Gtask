import { describe, expect, it } from 'vitest'
import type { ChecklistItem } from '../src/shared/contracts'
import {
  filterUpcomingBaselineItems,
  isUpcomingBaselineItem,
  readShowUpcomingBaselineItems,
  SHOW_UPCOMING_BASELINE_ITEMS_STORAGE_KEY,
  writeShowUpcomingBaselineItems
} from '../src/renderer/src/upcoming-visibility'

const now = Date.parse('2026-08-22T12:00:00.000Z')

function item(
  source: ChecklistItem['source'],
  startsAt: string | null
): Pick<ChecklistItem, 'source' | 'startsAt'> {
  return { source, startsAt }
}

describe('upcoming baseline visibility', () => {
  it('hides only public baseline items that have not started', () => {
    const futureBaseline = item('public_schedule', '2026-08-23T12:00:00.000Z')
    expect(isUpcomingBaselineItem(futureBaseline, now)).toBe(true)
    expect(filterUpcomingBaselineItems([
      futureBaseline,
      item('public_schedule', '2026-08-22T12:00:00.000Z'),
      item('manual', '2026-08-23T12:00:00.000Z'),
      item('personal_sync', '2026-08-23T12:00:00.000Z'),
      item('public_schedule', null),
      item('public_schedule', 'not-a-time')
    ], now, false)).toHaveLength(5)
  })

  it('shows the complete baseline immediately when the preference is enabled', () => {
    const values = [item('public_schedule', '2026-08-23T12:00:00.000Z')]
    expect(filterUpcomingBaselineItems(values, now, true)).toEqual(values)
  })

  it('defaults to hidden and persists an explicit opt-in', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
    expect(readShowUpcomingBaselineItems(storage)).toBe(false)
    expect(writeShowUpcomingBaselineItems(storage, true)).toBe(true)
    expect(values.get(SHOW_UPCOMING_BASELINE_ITEMS_STORAGE_KEY)).toBe('true')
    expect(readShowUpcomingBaselineItems(storage)).toBe(true)
  })
})
