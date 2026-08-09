import type { ChecklistItem } from '../../shared/contracts'

type CompletionFields = Pick<ChecklistItem, 'category' | 'completed' | 'progressPercent'>

export function isChecklistItemComplete(item: CompletionFields): boolean {
  return item.completed || (
    item.category === 'exploration' &&
    item.progressPercent !== null &&
    item.progressPercent >= 100
  )
}
