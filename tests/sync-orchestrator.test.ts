import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { SyncOrchestrator } from '../src/main/sync/orchestrator'
import { SyncVerificationRequiredError } from '../src/main/sync/types'

let database: AppDatabase | null = null

afterEach(() => {
  database?.close()
  database = null
})

describe('SyncOrchestrator', () => {
  it('公开排期和个人数据按顺序执行并汇总结果', async () => {
    database = new AppDatabase(':memory:')
    const order: string[] = []
    const publicSync = vi.fn(async () => {
      order.push('public')
      return {
        items: [
          {
            remoteKey: 'event:summer',
            category: 'limited_event' as const,
            title: '夏日活动'
          }
        ],
        message: '公开排期已同步'
      }
    })
    const personalSync = vi.fn(async () => {
      order.push('personal')
      return {
        items: [
          {
            remoteKey: 'abyss:current',
            category: 'endgame' as const,
            title: '深境螺旋',
            completed: true
          }
        ],
        message: '个人数据已同步'
      }
    })
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: { genshin: { sync: publicSync } },
      personalData: { genshin: { sync: personalSync } }
    })

    const result = await orchestrator.syncGame('genshin', 'public_and_personal')

    expect(order).toEqual(['public', 'personal'])
    expect(publicSync).toHaveBeenCalledWith(
      'genshin',
      'all',
      expect.any(Function),
      undefined
    )
    expect(personalSync).toHaveBeenCalledWith(
      'genshin',
      'all',
      expect.any(Function),
      undefined
    )
    expect(result.status).toBe('success')
    expect(result.sources.map((source) => source.added)).toEqual([1, 1])
    expect(database.listChecklistItems('genshin')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: '夏日活动', source: 'public_schedule', completed: false }),
        expect.objectContaining({ title: '深境螺旋', source: 'personal_sync', completed: true })
      ])
    )
    expect(database.getSyncSettings('genshin').status).toBe('success')
  })

  it('未接入适配器时明确返回错误而不伪造同步成功', async () => {
    database = new AppDatabase(':memory:')
    const orchestrator = new SyncOrchestrator(database)

    const result = await orchestrator.syncGame('wuthering-waves', 'public_and_personal')

    expect(result.status).toBe('error')
    expect(result.sources).toHaveLength(2)
    expect(result.message).toContain('公开资料适配器尚未接入')
    expect(result.message).toContain('库街区个人数据适配器尚未接入')
    expect(database.getSyncSettings('wuthering-waves').status).toBe('error')
  })

  it('版块同步只合并目标版块内的数据', async () => {
    database = new AppDatabase(':memory:')
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {
        genshin: {
          sync: async () => ({
            items: [
              { remoteKey: 'event:one', category: 'limited_event', title: '目标活动' },
              { remoteKey: 'map:one', category: 'exploration', title: '不应写入的地图' }
            ],
            message: '混合数据'
          })
        }
      },
      personalData: {}
    })

    const result = await orchestrator.syncGame('genshin', 'public_schedule', 'events')
    expect(result.requestedTarget).toBe('events')
    expect(database.listChecklistItems('genshin').some((item) => item.title === '目标活动')).toBe(true)
    expect(database.listChecklistItems('genshin').some((item) => item.title === '不应写入的地图')).toBe(false)
  })

  it('个人数据需要验证时保留公开排期成功结果并标记验证状态', async () => {
    database = new AppDatabase(':memory:')
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {
        genshin: { sync: async () => ({ items: [], message: '公开排期已同步' }) }
      },
      personalData: {
        genshin: {
          sync: async () => {
            throw new SyncVerificationRequiredError('米游社登录已失效或需要 Geetest 验证')
          }
        }
      }
    })

    const result = await orchestrator.syncGame('genshin', 'public_and_personal')

    expect(result.status).toBe('partial')
    expect(result.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'public_schedule', status: 'success' }),
        expect.objectContaining({ source: 'personal_data', status: 'verification_required' })
      ])
    )
    expect(database.getSyncSettings('genshin')).toMatchObject({
      status: 'verification_required'
    })
    expect(database.getSyncSettings('genshin').lastSuccessAt).not.toBeNull()
  })

  it('同一游戏的并发刷新复用正在执行的任务，避免重复请求和写入', async () => {
    database = new AppDatabase(':memory:')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapter = vi.fn(async () => {
      await gate
      return { items: [], message: '完成' }
    })
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: { zenless: { sync: adapter } },
      personalData: {}
    })

    const first = orchestrator.syncGame('zenless', 'public_schedule')
    const second = orchestrator.syncGame('zenless', 'public_schedule')
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(adapter).toHaveBeenCalledTimes(1)
    expect(secondResult).toEqual(firstResult)
  })

  it('可单独运行个人适配器并复用同一游戏的并发请求', async () => {
    database = new AppDatabase(':memory:')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const personal = vi.fn(async () => {
      await gate
      return {
        items: [{
          remoteKey: 'endgame:shiyu-defense',
          category: 'endgame' as const,
          title: '式舆防卫战',
          completed: true
        }],
        message: '绝区零个人数据已同步'
      }
    })
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: { zenless: { sync: personal } }
    })

    const first = orchestrator.syncPersonalData('zenless')
    const second = orchestrator.syncPersonalData('zenless')
    release()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(personal).toHaveBeenCalledTimes(1)
    expect(secondResult).toEqual(firstResult)
    expect(firstResult).toMatchObject({ source: 'personal_data', status: 'success', added: 1 })
    expect(database.listChecklistItems('zenless')).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '式舆防卫战', completed: true, source: 'personal_sync' })
    ]))
  })

  it('同步进度只运行个人适配器并记录独立结果', async () => {
    database = new AppDatabase(':memory:')
    const progress: Array<{ phase: string; status: string; message: string }> = []
    const publicSync = vi.fn(async () => ({ items: [], message: '不应运行' }))
    const personalSync = vi.fn(async () => ({
      items: [{
        remoteKey: 'map:fontaine',
        category: 'exploration' as const,
        title: '枫丹',
        progressPercent: 72
      }],
      message: '个人进度已同步'
    }))
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: { genshin: { sync: publicSync } },
      personalData: { genshin: { sync: personalSync } }
    }, (update) => progress.push({
      phase: update.phase,
      status: update.status,
      message: update.message
    }))

    const result = await orchestrator.syncPersonalOnly('genshin', 'exploration')

    expect(publicSync).not.toHaveBeenCalled()
    expect(personalSync).toHaveBeenCalledWith(
      'genshin',
      'exploration',
      expect.any(Function),
      expect.any(AbortSignal)
    )
    expect(result).toMatchObject({
      requestedScope: 'personal_data',
      requestedTarget: 'exploration',
      status: 'success'
    })
    expect(database.getSyncSettings('genshin')).toMatchObject({
      status: 'success',
      lastScope: null
    })
    expect(progress.map((update) => update.phase)).toEqual([
      'fetching',
      'structuring',
      'merging',
      'completed'
    ])
    expect(progress.at(-1)).toMatchObject({
      status: 'completed',
      message: '同步完成'
    })
  })

  it('模糊个人数据只进入 Codex 核验队列，不直接写入或冒充同步成功', async () => {
    database = new AppDatabase(':memory:')
    const progress: Array<{ phase: string; status: string; message: string }> = []
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: {
        'star-rail': {
          sync: async () => ({
            items: [],
            reviewCandidates: [{
              target: 'events',
              kind: 'personal-item-semantics',
              payload: {
                officialEventId: '6011',
                title: '反贪「砖」家',
                observedStatus: { allFinished: true }
              }
            }],
            message: '原始状态已脱敏'
          })
        }
      }
    }, (update) => progress.push({
      phase: update.phase,
      status: update.status,
      message: update.message
    }))

    const result = await orchestrator.syncPersonalOnly('star-rail', 'events')

    expect(result).toMatchObject({
      status: 'partial',
      sources: [expect.objectContaining({ pendingReview: 1 })]
    })
    expect(result.message).toContain('1 条状态正在由 Codex 核验，核验前保留原清单')
    expect(progress.at(-1)).toMatchObject({
      phase: 'verifying',
      status: 'running',
      message: '个人数据已读取，Codex 正在核验 1 条状态'
    })
    expect(database.getSyncTargetStates('star-rail')).toContainEqual(
      expect.objectContaining({
        target: 'events',
        status: 'stale',
        catalogCoverage: 'partial',
        catalogSource: 'personal_data'
      })
    )
    expect(database.listChecklistItems('star-rail').some((item) => item.title === '反贪「砖」家'))
      .toBe(false)
  })

  it('取消个人同步会中断适配器且不会合并任何数据', async () => {
    database = new AppDatabase(':memory:')
    const progress: Array<{ phase: string; status: string }> = []
    const personalSync = vi.fn(async (
      _gameId,
      _target,
      _reportProgress,
      signal?: AbortSignal
    ) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return {
        items: [{
          remoteKey: 'map:cancelled',
          category: 'exploration' as const,
          title: '不应写入',
          progressPercent: 88
        }],
        message: '不应完成'
      }
    })
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: { genshin: { sync: personalSync } }
    }, (update) => progress.push({
      phase: update.phase,
      status: update.status
    }))

    const operation = orchestrator.syncPersonalOnly('genshin', 'exploration')
    await vi.waitFor(() => expect(personalSync).toHaveBeenCalledTimes(1))
    expect(orchestrator.cancelPersonalSync('genshin', 'exploration')).toBe(true)
    const result = await operation

    expect(result.status).toBe('cancelled')
    expect(result.sources[0]).toMatchObject({ status: 'cancelled', added: 0, updated: 0 })
    expect(database.listChecklistItems('genshin').some(
      (item) => item.remoteKey === 'map:cancelled'
    )).toBe(false)
    expect(progress.at(-1)).toEqual({ phase: 'cancelled', status: 'cancelled' })
  })
})
