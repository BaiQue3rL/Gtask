import { describe, expect, it } from 'vitest'
import { resolveAdaptiveColumnLayout } from '../src/renderer/src/adaptive-column-layout'

describe('adaptive checklist column layout', () => {
  it('constrains the longer column to the shorter natural height', () => {
    expect(resolveAdaptiveColumnLayout([920, 356])).toEqual({
      height: 356,
      constrainedIndex: 0
    })
    expect(resolveAdaptiveColumnLayout([420, 870])).toEqual({
      height: 420,
      constrainedIndex: 1
    })
  })

  it('does not create a constraint for effectively equal or invalid heights', () => {
    expect(resolveAdaptiveColumnLayout([500, 506])).toBeNull()
    expect(resolveAdaptiveColumnLayout([0, 500])).toBeNull()
    expect(resolveAdaptiveColumnLayout([500])).toBeNull()
  })
})
