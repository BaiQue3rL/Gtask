export type ChecklistDeadlineTone = 'normal' | 'warning' | 'urgent'

const ONE_DAY_MS = 24 * 60 * 60 * 1_000
const URGENT_CHECKLIST_WINDOW_MS = 3 * ONE_DAY_MS
const WARNING_CHECKLIST_WINDOW_MS = 7 * ONE_DAY_MS

export function checklistDeadlineTone(
  endsAt: string,
  referenceTime: number
): ChecklistDeadlineTone | null {
  const timestamp = Date.parse(endsAt)
  if (!Number.isFinite(timestamp)) return null
  const remaining = timestamp - referenceTime
  if (remaining <= 0) return null
  if (remaining <= URGENT_CHECKLIST_WINDOW_MS) return 'urgent'
  if (remaining <= WARNING_CHECKLIST_WINDOW_MS) return 'warning'
  return 'normal'
}
