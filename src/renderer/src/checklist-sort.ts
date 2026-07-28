import type { ChecklistCategory, ChecklistItem } from '../../shared/contracts'

const CATEGORY_ORDER: Record<ChecklistCategory, number> = {
  main_quest: 10,
  side_quest: 20,
  limited_event: 30,
  permanent_event: 40,
  weekly: 50,
  endgame: 60,
  exploration: 70,
  custom: 80
}

function timestamp(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function lifecycleRank(item: ChecklistItem, now: number): number {
  if (item.completed) return 5
  const startsAt = timestamp(item.startsAt)
  const endsAt = timestamp(item.endsAt)
  if (startsAt !== null && startsAt > now) return 3
  if (endsAt !== null && endsAt <= now) return 4
  if (endsAt !== null && endsAt <= now + 24 * 60 * 60 * 1000) return 0
  return 1
}

export function compareChecklistItems(
  left: ChecklistItem,
  right: ChecklistItem,
  now = Date.now()
): number {
  const completionOrder = Number(left.completed) - Number(right.completed)
  if (completionOrder !== 0) return completionOrder

  const lifecycleOrder = lifecycleRank(left, now) - lifecycleRank(right, now)
  if (lifecycleOrder !== 0) return lifecycleOrder

  const categoryOrder = CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category]
  if (categoryOrder !== 0) return categoryOrder

  const leftStartsAt = timestamp(left.startsAt)
  const rightStartsAt = timestamp(right.startsAt)
  const leftFuture = leftStartsAt !== null && leftStartsAt > now
  const rightFuture = rightStartsAt !== null && rightStartsAt > now
  if (leftFuture || rightFuture) {
    const startOrder = (leftStartsAt ?? Number.POSITIVE_INFINITY) -
      (rightStartsAt ?? Number.POSITIVE_INFINITY)
    if (startOrder !== 0) return startOrder
  } else {
    const endOrder = (timestamp(left.endsAt) ?? Number.POSITIVE_INFINITY) -
      (timestamp(right.endsAt) ?? Number.POSITIVE_INFINITY)
    if (endOrder !== 0) return endOrder
  }

  const createdOrder = timestamp(left.createdAt)! - timestamp(right.createdAt)!
  if (Number.isFinite(createdOrder) && createdOrder !== 0) return createdOrder
  return 0
}

const MAP_KIND_ORDER = {
  group: 0,
  region: 1,
  independent: 2,
  subregion: 3
} as const

export function compareMapTreeItems(left: ChecklistItem, right: ChecklistItem): number {
  const completionOrder = Number(left.completed) - Number(right.completed)
  if (completionOrder !== 0) return completionOrder
  const kindOrder =
    MAP_KIND_ORDER[left.mapNodeKind ?? 'region'] -
    MAP_KIND_ORDER[right.mapNodeKind ?? 'region']
  if (kindOrder !== 0) return kindOrder
  return left.title.localeCompare(right.title, 'zh-CN')
}
