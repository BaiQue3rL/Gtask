import { describe, expect, it } from 'vitest'
import { checklistDeadlineTone } from '../src/renderer/src/checklist-deadline'

describe('checklist deadline urgency', () => {
  const now = Date.parse('2026-08-23T12:00:00.000Z')

  it('marks the final three days as urgent, including the exact boundary', () => {
    expect(checklistDeadlineTone('2026-08-26T12:00:00.000Z', now)).toBe('urgent')
    expect(checklistDeadlineTone('2026-08-26T12:00:00.001Z', now)).toBe('warning')
  })

  it('uses warning yellow through the seventh day before returning to normal', () => {
    expect(checklistDeadlineTone('2026-08-30T12:00:00.000Z', now)).toBe('warning')
    expect(checklistDeadlineTone('2026-08-30T12:00:00.001Z', now)).toBe('normal')
  })

  it('leaves expired and invalid deadlines to their existing states', () => {
    expect(checklistDeadlineTone('2026-08-23T12:00:00.000Z', now)).toBeNull()
    expect(checklistDeadlineTone('not-a-date', now)).toBeNull()
  })
})
