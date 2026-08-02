import { describe, expect, it, vi } from 'vitest'
import type { SyncTargetState } from '../src/shared/contracts'
import {
  globalSyncSourceLabel,
  orderPersonalSyncTargets,
  selectGuardedGlobalPublicTargets,
  summarizeGlobalSyncState,
  waitForPersonalSyncCooldown
} from '../src/renderer/src/global-sync'

function state(
  target: SyncTargetState['target'],
  catalogSource: SyncTargetState['catalogSource'],
  overrides: Partial<SyncTargetState> = {}
): SyncTargetState {
  return {
    gameId: 'genshin',
    target,
    lastSuccessAt: null,
    lastAttemptAt: null,
    status: 'idle',
    catalogCoverage: 'empty',
    catalogSource,
    ...overrides
  }
}

describe('global sync orchestration', () => {
  it('orders supported personal targets and omits unsupported sections', () => {
    expect(orderPersonalSyncTargets(['exploration', 'events'])).toEqual([
      'events',
      'exploration'
    ])
  })

  it('never includes personal-owned sections in a global public refresh', () => {
    expect(selectGuardedGlobalPublicTargets([
      state('tasks', 'public_schedule'),
      state('events', 'personal_data'),
      state('cycles', 'public_schedule'),
      state('exploration', null)
    ])).toEqual(['tasks', 'cycles', 'exploration'])
  })

  it('summarises per-section timestamps and mixed sources instead of stale all state', () => {
    const states = [
      state('all', 'public_schedule', {
        status: 'success',
        lastSuccessAt: '2026-01-01T00:00:00.000Z'
      }),
      state('tasks', 'public_schedule', {
        status: 'success',
        catalogCoverage: 'complete',
        lastSuccessAt: '2026-08-01T00:00:00.000Z'
      }),
      state('events', 'personal_data', {
        status: 'success',
        catalogCoverage: 'complete',
        lastSuccessAt: '2026-08-02T00:00:00.000Z'
      }),
      state('cycles', 'personal_data', {
        status: 'success',
        catalogCoverage: 'complete',
        lastSuccessAt: '2026-08-02T01:00:00.000Z'
      }),
      state('exploration', 'public_schedule', {
        status: 'success',
        catalogCoverage: 'complete',
        lastSuccessAt: '2026-08-01T12:00:00.000Z'
      })
    ]
    expect(summarizeGlobalSyncState(states)).toMatchObject({
      status: 'success',
      lastSuccessAt: '2026-08-02T01:00:00.000Z',
      catalogCoverage: 'complete',
      catalogSource: null
    })
    expect(globalSyncSourceLabel(states)).toBe('混合来源')
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
