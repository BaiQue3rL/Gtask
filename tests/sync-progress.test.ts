import { describe, expect, it } from 'vitest'
import { projectAiJobProgressPhase } from '../src/shared/sync-progress'

describe('AI 同步任务阶段投影', () => {
  it('把个人语义任务的实现阶段收敛为核对或更新', () => {
    expect(projectAiJobProgressPhase({
      jobKind: 'personal_review',
      status: 'claimed',
      progressPhase: 'fetching'
    })).toBe('verifying')
    expect(projectAiJobProgressPhase({
      jobKind: 'personal_metadata',
      status: 'claimed',
      progressPhase: 'structuring'
    })).toBe('verifying')
    expect(projectAiJobProgressPhase({
      jobKind: 'personal_review',
      status: 'claimed',
      progressPhase: 'merging'
    })).toBe('writing')
  })

  it('把公开资料任务与终态投影为稳定的产品阶段', () => {
    expect(projectAiJobProgressPhase({
      jobKind: 'public_catalog',
      status: 'pending',
      progressPhase: 'queued'
    })).toBe('queued')
    expect(projectAiJobProgressPhase({
      jobKind: 'public_catalog',
      status: 'claimed',
      progressPhase: 'fetching'
    })).toBe('searching')
    expect(projectAiJobProgressPhase({
      jobKind: 'public_catalog',
      status: 'completed',
      progressPhase: 'writing'
    })).toBe('completed')
  })
})
