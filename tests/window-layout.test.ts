import { describe, expect, it } from 'vitest'
import {
  calculatePortraitWindowSize,
  PORTRAIT_WINDOW_ASPECT_RATIO
} from '../src/main/window-layout'

describe('portrait window layout', () => {
  it('uses the preferred 3:4 size when the display has enough room', () => {
    expect(calculatePortraitWindowSize({ width: 1920, height: 1080 })).toEqual({
      width: 750,
      height: 1000,
      minWidth: 540,
      minHeight: 720
    })
  })

  it('shrinks to the work area while preserving the same ratio', () => {
    const size = calculatePortraitWindowSize({ width: 1024, height: 768 })
    expect(size.height).toBe(744)
    expect(size.width / size.height).toBeCloseTo(PORTRAIT_WINDOW_ASPECT_RATIO, 2)
    expect(size.minWidth / size.minHeight).toBeCloseTo(PORTRAIT_WINDOW_ASPECT_RATIO, 2)
  })
})
