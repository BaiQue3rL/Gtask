import { describe, expect, it } from 'vitest'
import type { AiScheduleJob, SyncProgressUpdate } from '../src/shared/contracts'
import {
  applyPersonalProgressUpdate,
  mergeLiveSyncProgresses,
  reconcilePersonalProgressForGame
} from '../src/renderer/src/personal-sync-progress'

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

  it('reconciles lost terminal events from the active job list', () => {
    const current = { 'wuthering-waves:cycles': progress }
    expect(reconcilePersonalProgressForGame(current, 'wuthering-waves', [], new Set()))
      .toEqual({})

    const job = {
      gameId: 'wuthering-waves',
      target: 'cycles',
      jobKind: 'personal_metadata'
    } as AiScheduleJob
    expect(reconcilePersonalProgressForGame(current, 'wuthering-waves', [job], new Set()))
      .toEqual(current)
  })

  it('renders one card when adapter progress and its AI metadata job overlap', () => {
    const jobProgress = {
      ...progress,
      phase: 'searching' as const,
      message: '正在检索当前周期时间'
    }
    expect(mergeLiveSyncProgresses([jobProgress], [progress])).toEqual([jobProgress])
  })

  it('keeps independent targets and sources visible', () => {
    const eventProgress = { ...progress, target: 'events' as const }
    const publicProgress = { ...progress, source: 'public_schedule' as const }
    expect(mergeLiveSyncProgresses([publicProgress], [progress, eventProgress])).toEqual([
      publicProgress,
      progress,
      eventProgress
    ])
  })
})
