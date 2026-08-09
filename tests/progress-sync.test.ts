import { describe, expect, it, vi } from 'vitest'
import {
  orderPersonalSyncTargets,
  waitForPersonalSyncCooldown
} from '../src/renderer/src/progress-sync'

describe('personal progress sync orchestration', () => {
  it('orders supported targets and omits unsupported sections', () => {
    expect(orderPersonalSyncTargets(['exploration', 'events'])).toEqual([
      'events',
      'exploration'
    ])
  })

  it('uses a three-second cooldown by default', async () => {
    vi.useFakeTimers()
    const pending = waitForPersonalSyncCooldown()
    await vi.advanceTimersByTimeAsync(2_999)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(settled).toBe(true)
    vi.useRealTimers()
  })
})
