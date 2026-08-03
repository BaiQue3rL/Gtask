import type {
  ChecklistCategory,
  ChecklistItem,
  ChecklistSection
} from '../../shared/contracts'

export interface ChecklistPanelVisibilityDescriptor {
  section: ChecklistSection
  categories: readonly ChecklistCategory[]
}

/**
 * “只看未完成” hides empty sections without mutating the saved panel order.
 * A section with an active sync remains visible so progress and cancellation
 * controls never disappear midway through a request.
 */
export function filterChecklistPanels<Panel extends ChecklistPanelVisibilityDescriptor>(
  panels: readonly Panel[],
  items: readonly Pick<ChecklistItem, 'category' | 'completed'>[],
  incompleteOnly: boolean,
  activeSections: ReadonlySet<ChecklistSection> = new Set()
): Panel[] {
  if (!incompleteOnly) return [...panels]
  return panels.filter((panel) =>
    activeSections.has(panel.section) || items.some(
      (item) => panel.categories.includes(item.category) && !item.completed
    )
  )
}
