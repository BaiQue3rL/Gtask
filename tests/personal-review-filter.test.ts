import { describe, expect, it } from 'vitest'
import {
  filterRelevantSemanticReviewDrafts,
  isSemanticReviewDraftRelevant
} from '../src/main/sync/personal-review-filter'
import type { SemanticReviewDraft } from '../src/main/sync/types'

function draft(
  target: SemanticReviewDraft['target'],
  payload: Record<string, unknown>
): SemanticReviewDraft {
  return { target, kind: 'test', payload }
}

describe('个人数据语义候选范围', () => {
  const now = new Date('2026-07-26T12:00:00.000Z')

  it('过滤已经结束的活动和周期，只保留当前或未来事项', () => {
    const values = [
      draft('events', { normalizedEndAt: '2026-07-25T12:00:00.000Z' }),
      draft('events', { normalizedEndAt: '2026-07-27T12:00:00.000Z' }),
      draft('cycles', { observedEndsAt: '2026-07-20T12:00:00.000Z' }),
      draft('cycles', { observedEndsAt: '2026-08-01T12:00:00.000Z' })
    ]
    expect(filterRelevantSemanticReviewDrafts(values, now)).toEqual([values[1], values[3]])
  })

  it('地图是长期进度目录，不使用活动过期规则', () => {
    expect(isSemanticReviewDraftRelevant(
      draft('exploration', { normalizedEndAt: '2020-01-01T00:00:00.000Z' }),
      now
    )).toBe(true)
  })

  it('上游没有可靠结束时间时保留候选交给 Codex 判断', () => {
    expect(isSemanticReviewDraftRelevant(draft('events', { normalizedEndAt: null }), now))
      .toBe(true)
  })
})
