import { describe, expect, it } from 'vitest'
import type { ChecklistItem } from '../src/shared/contracts'
import { filterChecklistPanels } from '../src/renderer/src/panel-visibility'

const panels = [
  { section: 'tasks' as const, categories: ['main_quest', 'side_quest'] as const },
  { section: 'events' as const, categories: ['limited_event'] as const },
  { section: 'cycles' as const, categories: ['weekly', 'endgame'] as const }
]

function item(category: ChecklistItem['category'], completed: boolean) {
  return { category, completed }
}

describe('filterChecklistPanels', () => {
  it('keeps saved order when the incomplete filter is off', () => {
    expect(filterChecklistPanels(panels, [], false).map((panel) => panel.section))
      .toEqual(['tasks', 'events', 'cycles'])
  })

  it('hides completed sections and lets remaining sections move upward', () => {
    const visible = filterChecklistPanels(panels, [
      item('main_quest', true),
      item('limited_event', false)
    ], true)
    expect(visible.map((panel) => panel.section)).toEqual(['events'])
  })

  it('keeps an empty section visible while its sync is active', () => {
    const visible = filterChecklistPanels(
      panels,
      [],
      true,
      new Set(['cycles' as const])
    )
    expect(visible.map((panel) => panel.section)).toEqual(['cycles'])
  })
})
