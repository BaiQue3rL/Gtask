import type { ChecklistItem } from '../../shared/contracts'
import { compareMapTreeItems } from './checklist-sort'
import { isChecklistItemComplete } from './checklist-completion'

export interface ChecklistTreeRow {
  item: ChecklistItem
  depth: number
  hasChildren: boolean
  displayProgressPercent: number | null
}

export function collectMapBranchKeys(items: ChecklistItem[]): Set<string> {
  return new Set(
    buildMapTreeRows(items, new Set(), items)
      .filter((row) => row.hasChildren)
      .map((row) => row.item.remoteKey ?? row.item.id)
  )
}

export function buildMapTreeRows(
  sourceItems: ChecklistItem[],
  collapsedKeys: ReadonlySet<string>,
  progressSourceItems: ChecklistItem[] = sourceItems,
  includeAncestorStructure = true
): ChecklistTreeRow[] {
  const items = [...sourceItems].sort(compareMapTreeItems)
  const progressItems = [...progressSourceItems].sort(compareMapTreeItems)
  const keyOf = (item: ChecklistItem): string => item.remoteKey ?? item.id
  const byKey = new Map(progressItems.map((item) => [keyOf(item), item]))
  const titleGroups = new Map<string, ChecklistItem[]>()
  for (const item of progressItems) {
    const group = titleGroups.get(item.title) ?? []
    group.push(item)
    titleGroups.set(item.title, group)
  }
  const parentKeyOf = (item: ChecklistItem): string | null => {
    if (item.parentRemoteKey && byKey.has(item.parentRemoteKey)) return item.parentRemoteKey
    if (!item.parentTitle) return null
    const candidates = titleGroups.get(item.parentTitle) ?? []
    return candidates.length === 1 ? keyOf(candidates[0]) : null
  }
  const children = new Map<string, ChecklistItem[]>()
  for (const item of progressItems) {
    const parentKey = parentKeyOf(item)
    if (!parentKey || parentKey === keyOf(item)) continue
    const group = children.get(parentKey) ?? []
    group.push(item)
    children.set(parentKey, group)
  }
  const visibleKeys = new Set(items.map(keyOf))
  // A filter may hide a completed parent while leaving unfinished children
  // visible. Preserve the necessary ancestor path as structure instead of
  // promoting those children into fake root regions.
  const renderKeys = new Set(visibleKeys)
  if (includeAncestorStructure) {
    for (const visible of items) {
      let current: ChecklistItem | undefined = visible
      const visitedAncestors = new Set<string>()
      while (current) {
        const key = keyOf(current)
        if (visitedAncestors.has(key)) break
        visitedAncestors.add(key)
        renderKeys.add(key)
        const parentKey = parentKeyOf(current)
        if (!parentKey || parentKey === key) break
        current = byKey.get(parentKey)
      }
    }
  }
  const roots = progressItems.filter((item) => {
    if (!renderKeys.has(keyOf(item))) return false
    const parentKey = parentKeyOf(item)
    return !parentKey || parentKey === keyOf(item)
  })
  const displayProgress = new Map<string, number | null>()
  const resolveProgress = (item: ChecklistItem, visiting = new Set<string>()): number | null => {
    const key = keyOf(item)
    const cached = displayProgress.get(key)
    if (cached !== undefined || displayProgress.has(key)) return cached ?? null
    if (visiting.has(key)) return null
    const nextVisiting = new Set(visiting)
    nextVisiting.add(key)
    if (item.progressPercent !== null) {
      displayProgress.set(key, item.progressPercent)
      return item.progressPercent
    }
    const childProgress = (children.get(key) ?? [])
      .map((child) => resolveProgress(child, nextVisiting))
      .filter((progress): progress is number => progress !== null)
    const progress = childProgress.length > 0
      ? Math.round(childProgress.reduce((sum, value) => sum + value, 0) / childProgress.length)
      : null
    displayProgress.set(key, progress)
    return progress
  }
  const rows: ChecklistTreeRow[] = []
  const visited = new Set<string>()
  const reachable = new Set<string>()
  const markReachable = (item: ChecklistItem): void => {
    const key = keyOf(item)
    if (reachable.has(key)) return
    reachable.add(key)
    for (const child of children.get(key) ?? []) {
      if (renderKeys.has(keyOf(child))) markReachable(child)
    }
  }
  const visit = (item: ChecklistItem, depth: number): void => {
    const key = keyOf(item)
    if (visited.has(key)) return
    visited.add(key)
    const descendants = children.get(key) ?? []
    const visibleDescendants = descendants.filter((child) => renderKeys.has(keyOf(child)))
    rows.push({
      item,
      depth,
      hasChildren: visibleDescendants.length > 0,
      displayProgressPercent: resolveProgress(item)
    })
    if (collapsedKeys.has(key)) return
    for (const child of visibleDescendants) visit(child, depth + 1)
  }
  for (const root of roots) markReachable(root)
  for (const root of roots) visit(root, 0)
  for (const item of progressItems) {
    if (renderKeys.has(keyOf(item)) && !reachable.has(keyOf(item))) visit(item, 0)
  }
  return rows
}

export function filterIncompleteMapTreeRows(rows: ChecklistTreeRow[]): ChecklistTreeRow[] {
  return rows.filter((row) => !isChecklistItemComplete(row.item))
}

export function distributeMapTreeRows(
  rows: ChecklistTreeRow[],
  columnCount = 2
): ChecklistTreeRow[][] {
  const columns = Array.from(
    { length: Math.max(1, Math.floor(columnCount)) },
    (): ChecklistTreeRow[] => []
  )
  const branches: ChecklistTreeRow[][] = []
  for (const row of rows) {
    if (row.depth === 0 || branches.length === 0) branches.push([])
    branches.at(-1)!.push(row)
  }
  for (const branch of branches) {
    const target = columns.reduce(
      (shortest, column) => column.length < shortest.length ? column : shortest,
      columns[0]
    )
    target.push(...branch)
  }
  return columns
}
