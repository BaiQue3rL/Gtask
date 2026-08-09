import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { SyncOrchestrator } from '../src/main/sync/orchestrator'
import { SyncVerificationRequiredError } from '../src/main/sync/types'

let database: AppDatabase | null = null
const accountScope = `miyoushe:${'8'.repeat(64)}`

afterEach(() => {
  database?.close()
  database = null
})

function personalMap(progressPercent: number) {
  return {
    remoteKey: 'personal-map:miyoushe:6',
    category: 'exploration' as const,
    title: '璃月',
    completed: progressPercent === 100,
    progressPercent,
    mapNodeKind: 'region' as const,
    sourceIdentity: {
      provider: 'miyoushe',
      endpoint: 'personal-map-progress',
      externalId: '6'
    }
  }
}

describe('SyncOrchestrator personal progress', () => {
  it('tracks an in-flight personal request and clears it on completion', async () => {
    database = new AppDatabase(':memory:')
    let release!: (value: {
      items: ReturnType<typeof personalMap>[]
      accountScope: string
      snapshotCompleteness: 'complete'
      adapterVersion: string
      message: string
    }) => void
    const pending = new Promise<Parameters<typeof release>[0]>((resolve) => { release = resolve })
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: { genshin: { sync: async () => await pending } }
    })

    const operation = orchestrator.syncPersonalData('genshin', 'exploration')
    expect(orchestrator.isPersonalSyncActive('genshin', 'exploration')).toBe(true)
    release({
      items: [personalMap(50)],
      accountScope,
      snapshotCompleteness: 'complete',
      adapterVersion: 'test-v1',
      message: '读取完成'
    })
    await operation
    expect(orchestrator.isPersonalSyncActive('genshin', 'exploration')).toBe(false)
  })

  it('updates progress without replacing the bundled map baseline', async () => {
    database = new AppDatabase(':memory:')
    const before = database.listChecklistItems('genshin').filter(
      (item) => item.category === 'exploration'
    )
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: {
        genshin: {
          sync: async () => ({
            items: [personalMap(86)],
            accountScope,
            snapshotCompleteness: 'complete',
            adapterVersion: 'test-v1',
            message: '个人进度已同步'
          })
        }
      }
    })

    await expect(orchestrator.syncPersonalOnly('genshin', 'exploration'))
      .resolves.toMatchObject({ status: 'success' })
    const after = database.listChecklistItems('genshin').filter(
      (item) => item.category === 'exploration'
    )
    expect(after).toHaveLength(before.length)
    expect(after.every((item) => item.source === 'public_schedule')).toBe(true)
    expect(after.find((item) => item.title === '璃月')?.progressPercent).toBe(86)
  })

  it('keeps every baseline cycle and only applies official challenge records', async () => {
    database = new AppDatabase(':memory:')
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: {
        'star-rail': {
          sync: async () => ({
            items: [{
              remoteKey: 'personal-cycle:star-rail:chaos',
              category: 'endgame' as const,
              title: '混沌回忆',
              completed: true,
              modeKey: 'memory-of-chaos',
              sourceIdentity: {
                provider: 'miyoushe',
                endpoint: 'challenge-record',
                externalId: 'chaos'
              }
            }],
            accountScope,
            snapshotCompleteness: 'complete',
            adapterVersion: 'test-v1',
            message: '挑战记录已读取'
          })
        }
      }
    })

    await orchestrator.syncPersonalOnly('star-rail', 'cycles')
    const cycles = database.listChecklistItems('star-rail').filter(
      (item) => item.category === 'endgame'
    )
    expect(cycles.map((item) => item.title)).toEqual(expect.arrayContaining([
      '混沌回忆', '虚构叙事', '末日幻影', '异相仲裁'
    ]))
    expect(cycles.find((item) => item.modeKey === 'memory-of-chaos')?.completed).toBe(true)
    expect(cycles.every((item) => item.source === 'public_schedule')).toBe(true)
  })

  it('preserves the prior baseline when the provider returns a partial snapshot', async () => {
    database = new AppDatabase(':memory:')
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: {
        genshin: {
          sync: async () => ({
            items: [personalMap(100)],
            accountScope,
            snapshotCompleteness: 'partial',
            adapterVersion: 'test-v1',
            message: '只读取到部分进度'
          })
        }
      }
    })

    await expect(orchestrator.syncPersonalOnly('genshin', 'exploration'))
      .resolves.toMatchObject({ status: 'error' })
    expect(database.listChecklistItems('genshin').find((item) => item.title === '璃月'))
      .toMatchObject({ completed: false, source: 'public_schedule' })
  })

  it('reports verification-required state through structured progress', async () => {
    database = new AppDatabase(':memory:')
    const progress = vi.fn()
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: {
        genshin: { sync: async () => { throw new SyncVerificationRequiredError('请验证') } }
      }
    }, progress)

    await expect(orchestrator.syncPersonalOnly('genshin', 'events'))
      .resolves.toMatchObject({ status: 'error' })
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      source: 'personal_data',
      status: 'verification_required',
      phase: 'verification'
    }))
  })
})
