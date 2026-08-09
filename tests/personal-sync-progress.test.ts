import { describe, expect, it } from 'vitest'
import type { SyncProgressUpdate } from '../src/shared/contracts'
import { applyPersonalProgressUpdate } from '../src/renderer/src/personal-sync-progress'

const progress: SyncProgressUpdate = {
  gameId: 'wuthering-waves',
  target: 'cycles',
  source: 'personal_data',
  phase: 'writing',
  status: 'running',
  message: '正在写入',
  current: 1,
  total: 1,
  updatedAt: '2026-08-01T13:00:00.000Z'
}

describe('personal sync progress lifecycle', () => {
  it('removes a stale card when a terminal update arrives', () => {
    const running = applyPersonalProgressUpdate({}, progress)
    expect(running['wuthering-waves:cycles']).toEqual(progress)

    const completed = applyPersonalProgressUpdate(running, {
      ...progress,
      status: 'completed',
      phase: 'completed'
    })
    expect(completed).toEqual({})
  })
})
