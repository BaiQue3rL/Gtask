import { describe, expect, it } from 'vitest'
import { nextChecklistClockUpdate } from '../src/renderer/src/checklist-clock'

describe('checklist clock scheduling', () => {
  it('keeps second-precision deadlines and minute changes without rerendering every second', () => {
    const now = Date.parse('2026-09-14T12:00:10Z')
    expect(nextChecklistClockUpdate([], now)).toBe(Date.parse('2026-09-14T12:01:00.001Z'))
    expect(nextChecklistClockUpdate(['2026-09-14T12:04:20Z'], now)).toBe(Date.parse('2026-09-14T12:00:20.001Z'))
    expect(nextChecklistClockUpdate(['2026-09-14T12:00:11Z'], now)).toBe(now + 1_000)
    expect(nextChecklistClockUpdate(['2026-09-14T12:01:10Z'], now)).toBe(now + 1)
    expect(nextChecklistClockUpdate(['bad', null, '2026-09-14T11:00:00Z'], now))
      .toBe(nextChecklistClockUpdate([], now))
  })
})
