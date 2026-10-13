import { describe, expect, it } from 'vitest'
import type { PersonalProgressSummary, SyncResult, SyncTargetState } from '../src/shared/contracts'
import { formatPersonalProgressSummary, hasUnconfirmedProgress, personalSummaryForState,
  readPersonalSyncReceipts, recordPersonalSyncReceipt, writePersonalSyncReceipts } from '../src/renderer/src/personal-sync-summary'

const progress: PersonalProgressSummary = { complete: 1, incomplete: 3, unknown: 1, notReturned: 4, unmatched: 0, manualProtected: 1 }
const result: SyncResult = { gameId: 'zenless', requestedScope: 'personal_data', requestedTarget: 'events', status: 'success',
  startedAt: '2026-10-13T14:00:00Z', finishedAt: '2026-10-13T14:00:02Z', message: '完成',
  sources: [{ source: 'personal_data', status: 'success', message: '完成', added: 0, updated: 1, preserved: 3, progress }] }
const state: SyncTargetState = { gameId: 'zenless', target: 'events', status: 'success', lastSuccessAt: '2026-10-13T14:00:01Z',
  lastAttemptAt: '2026-10-13T14:00:00Z', catalogCoverage: 'complete', catalogSource: 'public_schedule' }

describe('personal sync evidence display', () => {
  it('retains per-section summaries across restart and explains unknown versus absent progress', () => {
    let json = ''
    writePersonalSyncReceipts({ setItem: (_key, value) => { json = value } }, recordPersonalSyncReceipt({}, result))
    const receipts = readPersonalSyncReceipts({ getItem: () => json })
    expect(personalSummaryForState(receipts, state)).toEqual(progress)
    expect(personalSummaryForState(receipts, { ...state, target: 'cycles' })).toBeUndefined()
    expect(hasUnconfirmedProgress(progress)).toBe(true)
    expect(formatPersonalProgressSummary(progress)).toContain('无法判断 1（保留原状态）')
    expect(formatPersonalProgressSummary(progress)).toContain('接口未返回 4（保留原状态）')
    expect(formatPersonalProgressSummary(progress)).toContain('手动保护 1')
  })

  it('rejects stale summaries after restore, newer sync or failure and never relabels known incomplete as unknown', () => {
    const receipts = recordPersonalSyncReceipt({}, result)
    for (const lastSuccessAt of ['2026-10-12T14:00:01Z', '2026-10-14T14:00:01Z', 'invalid']) {
      expect(personalSummaryForState(receipts, { ...state, lastSuccessAt })).toBeUndefined()
    }
    expect(personalSummaryForState(receipts, { ...state, status: 'error' })).toBeUndefined()
    expect(hasUnconfirmedProgress({ ...progress, unknown: 0, notReturned: 0 })).toBe(false)
    expect(recordPersonalSyncReceipt(receipts, { ...result, sources: [{ ...result.sources[0], status: 'error' }] })).toBe(receipts)
  })

  it('tolerates unavailable storage and ignores malformed or negative counters', () => {
    expect(readPersonalSyncReceipts({ getItem: () => '{' })).toEqual({})
    const receipts = recordPersonalSyncReceipt({}, result)
    const malformed = { ...receipts, 'zenless:events': { ...receipts['zenless:events'], progress: { ...progress, unknown: -1 } } }
    expect(readPersonalSyncReceipts({ getItem: () => JSON.stringify(malformed) })).toEqual({})
    expect(() => writePersonalSyncReceipts({ setItem: () => { throw new Error('Storage unavailable') } }, {})).not.toThrow()
  })
})
