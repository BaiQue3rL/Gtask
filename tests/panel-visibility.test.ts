import { describe, expect, it } from 'vitest'
import type { ChecklistItem } from '../src/shared/contracts'
import { filterChecklistPanels } from '../src/renderer/src/panel-visibility'

const panels = [
  { section: 'events' as const, categories: ['limited_event'] as const },
  { section: 'cycles' as const, categories: ['endgame'] as const }
]

function item(category: ChecklistItem['category'], completed: boolean) {
  return { category, completed }
}

describe('filterChecklistPanels', () => {
  it('keeps saved order when the incomplete filter is off', () => {
    expect(filterChecklistPanels(panels, [], false).map((panel) => panel.section))
      .toEqual(['events', 'cycles'])
  })

  it('hides completed sections and lets remaining sections move upward', () => {
    const visible = filterChecklistPanels(panels, [
      item('limited_event', false)
    ], true)
    expect(visible.map((panel) => panel.section)).toEqual(['events'])
  })

  it('does not let transient background state bypass the incomplete filter', () => {
    expect(filterChecklistPanels(panels, [], true)).toEqual([])
  })
})
