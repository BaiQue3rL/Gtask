import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PANEL_ORDER,
  PANEL_ORDER_STORAGE_KEY,
  movePanelSection,
  normalizePanelOrder,
  panelDragWheelDelta,
  readPanelOrders,
  writePanelOrder
} from '../src/renderer/src/panel-order'

describe('checklist panel order', () => {
  it('uses the four-section product order and repairs incomplete preferences', () => {
    expect(DEFAULT_PANEL_ORDER).toEqual(['events', 'cycles', 'exploration', 'custom'])
    expect(normalizePanelOrder(['events', 'events', 'unknown'])).toEqual([
      'events',
      'cycles',
      'exploration',
      'custom'
    ])
  })

  it('moves a section before or after the target without losing sections', () => {
    expect(movePanelSection(DEFAULT_PANEL_ORDER, 'custom', 'events', 'before')).toEqual([
      'custom',
      'events',
      'cycles',
      'exploration'
    ])
    expect(movePanelSection(DEFAULT_PANEL_ORDER, 'events', 'cycles', 'after')).toEqual([
      'cycles',
      'events',
      'exploration',
      'custom'
    ])
  })

  it('persists independent orders for each game and tolerates damaged storage', () => {
    const setItem = vi.fn()
    const saved = writePanelOrder(
      { setItem },
      { genshin: [...DEFAULT_PANEL_ORDER] },
      'star-rail',
      ['cycles', 'events', 'exploration', 'custom']
    )
    expect(saved['star-rail']?.[0]).toBe('cycles')
    expect(setItem).toHaveBeenCalledWith(PANEL_ORDER_STORAGE_KEY, JSON.stringify(saved))
    expect(readPanelOrders({ getItem: () => '{broken' })).toEqual({})
  })

  it('normalizes wheel input while a panel is being dragged', () => {
    expect(panelDragWheelDelta(120, 0, 800)).toBe(120)
    expect(panelDragWheelDelta(-3, 1, 800)).toBe(-96)
    expect(panelDragWheelDelta(1, 2, 720)).toBe(720)
    expect(panelDragWheelDelta(Number.NaN, 0, 800)).toBe(0)
  })
})
