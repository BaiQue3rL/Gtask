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
 */
export function filterChecklistPanels<Panel extends ChecklistPanelVisibilityDescriptor>(
  panels: readonly Panel[],
  items: readonly Pick<ChecklistItem, 'category' | 'completed'>[],
  incompleteOnly: boolean
): Panel[] {
  if (!incompleteOnly) return [...panels]
  return panels.filter((panel) =>
    items.some((item) => panel.categories.includes(item.category) && !item.completed)
  )
}
