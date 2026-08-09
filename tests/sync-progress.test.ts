import { describe, expect, it } from 'vitest'
import { projectAiJobProgressPhase } from '../src/shared/sync-progress'

describe('AI 同步任务阶段投影', () => {
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
