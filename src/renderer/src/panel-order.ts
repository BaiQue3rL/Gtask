import {
  SUPPORTED_GAME_IDS,
  type ChecklistSection,
  type GameId
} from '../../shared/contracts'

export const PANEL_ORDER_STORAGE_KEY = 'gtask.panel-order.v1'

export const DEFAULT_PANEL_ORDER = [
  'tasks',
  'events',
  'cycles',
  'exploration',
  'custom'
] as const satisfies readonly ChecklistSection[]

export type PanelOrderByGame = Partial<Record<GameId, ChecklistSection[]>>
export type PanelDropPosition = 'before' | 'after'

const WHEEL_LINE_HEIGHT_PX = 32

const PANEL_SECTIONS = new Set<ChecklistSection>(DEFAULT_PANEL_ORDER)

export function normalizePanelOrder(value: unknown): ChecklistSection[] {
  const normalized: ChecklistSection[] = []
  if (Array.isArray(value)) {
    for (const section of value) {
      if (
        typeof section === 'string' &&
        PANEL_SECTIONS.has(section as ChecklistSection) &&
        !normalized.includes(section as ChecklistSection)
      ) {
        normalized.push(section as ChecklistSection)
      }
    }
  }
  for (const section of DEFAULT_PANEL_ORDER) {
    if (!normalized.includes(section)) normalized.push(section)
  }
  return normalized
}

export function readPanelOrders(storage: Pick<Storage, 'getItem'>): PanelOrderByGame {
  try {
    const raw = storage.getItem(PANEL_ORDER_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const source = parsed as Record<string, unknown>
    return Object.fromEntries(
      SUPPORTED_GAME_IDS
        .filter((gameId) => Array.isArray(source[gameId]))
        .map((gameId) => [gameId, normalizePanelOrder(source[gameId])])
    ) as PanelOrderByGame
  } catch {
    return {}
  }
}

export function writePanelOrder(
  storage: Pick<Storage, 'setItem'>,
  current: PanelOrderByGame,
  gameId: GameId,
  order: readonly ChecklistSection[]
): PanelOrderByGame {
  const next: PanelOrderByGame = {
    ...current,
    [gameId]: normalizePanelOrder(order)
  }
  storage.setItem(PANEL_ORDER_STORAGE_KEY, JSON.stringify(next))
  return next
}

export function movePanelSection(
  order: readonly ChecklistSection[],
  source: ChecklistSection,
  target: ChecklistSection,
  position: PanelDropPosition
): ChecklistSection[] {
  const normalized = normalizePanelOrder(order)
  if (source === target || !normalized.includes(source) || !normalized.includes(target)) {
    return normalized
  }
  const next = normalized.filter((section) => section !== source)
  const targetIndex = next.indexOf(target)
  next.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, source)
  return next
}

export function panelDragWheelDelta(
  deltaY: number,
  deltaMode: number,
  viewportHeight: number
): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0
  const scale = deltaMode === 1
    ? WHEEL_LINE_HEIGHT_PX
    : deltaMode === 2
      ? Math.max(1, viewportHeight)
      : 1
  return deltaY * scale
}
