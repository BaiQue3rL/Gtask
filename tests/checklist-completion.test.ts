import { describe, expect, it } from 'vitest'
import { isChecklistItemComplete } from '../src/renderer/src/checklist-completion'

describe('isChecklistItemComplete', () => {
  it('把探索度达到 100% 的地图视为完成，即使旧完成标志尚未刷新', () => {
    expect(isChecklistItemComplete({
      category: 'exploration',
      completed: false,
      progressPercent: 100
    })).toBe(true)
  })

  it('不把其他版块的百分比误作完成状态', () => {
    expect(isChecklistItemComplete({
      category: 'endgame',
      completed: false,
      progressPercent: 100
    })).toBe(false)
  })
})
