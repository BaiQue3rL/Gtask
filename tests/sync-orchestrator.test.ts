import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { SyncOrchestrator } from '../src/main/sync/orchestrator'
import { SyncVerificationRequiredError } from '../src/main/sync/types'

let database: AppDatabase | null = null
const accountScope = `miyoushe:${'8'.repeat(64)}`

afterEach(() => {
  vi.useRealTimers()
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

  it('accepts an expired Wuthering Waves observation without corrupting the current window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T10:00:00.000Z'))
    database = new AppDatabase(':memory:')
    database.replacePersonalSnapshot(
      'wuthering-waves',
      'cycles',
      `kuro-community:${'8'.repeat(64)}`,
      [{
        remoteKey: 'endgame:endstate-matrix',
        category: 'endgame',
        title: '终焉矩阵',
        completed: true,
        startsAt: '2026-08-26T20:00:00.000Z',
        endsAt: '2026-09-29T20:00:00.000Z',
        periodKey: 'wuthering-waves:endstate-matrix:current',
        scheduleKind: 'remote_schedule',
        modeKey: 'endstate-matrix',
        sourceIdentity: {
          provider: 'kuro-community',
          endpoint: 'aki/roleBox/akiBox/newTowerDetail',
          externalId: 'endgame:endstate-matrix|period:current'
        }
      }],
      'wuthering-waves-personal-v1',
      new Date('2026-08-28T09:00:00.000Z')
    )
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: {
        'wuthering-waves': {
          sync: async () => ({
            items: [{
              remoteKey: 'endgame:endstate-matrix',
              category: 'endgame' as const,
              title: '终焉矩阵',
              completed: true,
              startsAt: null,
              endsAt: '2026-08-19T23:59:59.000Z',
              periodKey: 'wuthering-waves:endstate-matrix:expired',
              scheduleKind: 'remote_schedule' as const,
              modeKey: 'endstate-matrix',
              sourceIdentity: {
                provider: 'kuro-community',
                endpoint: 'aki/roleBox/akiBox/newTowerDetail',
                externalId: 'endgame:endstate-matrix|period:expired'
              }
            }],
            scheduleObservations: [{
              target: 'cycles' as const,
              provider: 'kuro-community' as const,
              endpoint: 'aki/roleBox/akiBox/newTowerDetail',
              remoteKey: 'endgame:endstate-matrix',
              title: '终焉矩阵',
              modeKey: 'endstate-matrix',
              periodKey: 'wuthering-waves:endstate-matrix:expired',
              startsAt: null,
              endsAt: '2026-08-19T23:59:59.000Z'
            }],
            accountScope: `kuro-community:${'8'.repeat(64)}`,
            snapshotCompleteness: 'complete' as const,
            adapterVersion: 'wuthering-waves-personal-v1',
            message: '鸣潮周期挑战记录已同步'
          })
        }
      }
    })

    await expect(orchestrator.syncPersonalOnly('wuthering-waves', 'cycles'))
      .resolves.toMatchObject({ status: 'success' })
    expect(database.getSyncTargetStates('wuthering-waves').find(
      (state) => state.target === 'cycles'
    )).toMatchObject({ status: 'success' })
    expect(database.listChecklistItems('wuthering-waves').find(
      (item) => item.modeKey === 'endstate-matrix'
    )).toMatchObject({
      completed: true,
      startsAt: '2026-08-26T20:00:00.000Z',
      endsAt: '2026-09-29T20:00:00.000Z'
    })
  })

  it('rejects local cycle predictions as personal completion evidence', () => {
    database = new AppDatabase(':memory:')
    expect(() => database!.replacePersonalSnapshot(
      'wuthering-waves',
      'cycles',
      `kuro-community:${'8'.repeat(64)}`,
      [{
        remoteKey: 'endgame:endstate-matrix',
        category: 'endgame',
        title: '终焉矩阵',
        completed: false,
        modeKey: 'endstate-matrix',
        sourceIdentity: {
          provider: 'gtask-cycle-catalog',
          endpoint: 'predicted-cycle-window',
          externalId: 'endstate-matrix|predicted'
        }
      }],
      'test-v1'
    )).toThrow('个人进度不能使用本地预测周期代替官方完成记录')
  })

  it('applies Wuthering Waves manual records without treating numeric fields as schedule time', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T11:00:00.000Z'))
    database = new AppDatabase(':memory:')
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: {
        'wuthering-waves': {
          sync: async () => ({
            items: [
              ['tower-of-adversity', '逆境深塔'],
              ['whimpering-wastes', '冥歌海墟'],
              ['endstate-matrix', '终焉矩阵']
            ].map(([modeKey, title]) => ({
              remoteKey: `endgame:${modeKey}`,
              category: 'endgame' as const,
              title,
              completed: true,
              startsAt: null,
              endsAt: null,
              periodKey: `wuthering-waves:${modeKey}:current`,
              scheduleKind: 'remote_schedule' as const,
              modeKey,
              sourceIdentity: {
                provider: 'kuro-community',
                endpoint: `challenge/${modeKey}`,
                externalId: `endgame:${modeKey}|period:current`
              }
            })),
            accountScope: `kuro-community:${'8'.repeat(64)}`,
            snapshotCompleteness: 'complete' as const,
            adapterVersion: 'wuthering-waves-personal-v1',
            message: '鸣潮周期挑战记录已同步'
          })
        }
      }
    })

    await expect(orchestrator.syncPersonalOnly('wuthering-waves', 'cycles'))
      .resolves.toMatchObject({ status: 'success' })
    const cycles = database.listChecklistItems('wuthering-waves').filter(
      (item) => item.category === 'endgame'
    )
    expect(cycles).toHaveLength(3)
    expect(cycles.every((item) => item.completed)).toBe(true)
    expect(cycles.every((item) => item.source === 'public_schedule')).toBe(true)
    expect(cycles.every((item) => item.startsAt && item.endsAt)).toBe(true)
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
      phase: 'verification',
      message: '请验证'
    }))
  })
})
