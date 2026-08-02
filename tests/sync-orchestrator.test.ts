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

describe('SyncOrchestrator', () => {
  it('公开入口可机械检测同一版块正在读取个人数据并等待来源互斥', async () => {
    database = new AppDatabase(':memory:')
    let release: ((value: {
      items: ReturnType<typeof personalMap>[]
      accountScope: string
      snapshotCompleteness: 'complete'
      adapterVersion: string
      message: string
    }) => void) | null = null
    const pending = new Promise<{
      items: ReturnType<typeof personalMap>[]
      accountScope: string
      snapshotCompleteness: 'complete'
      adapterVersion: string
      message: string
    }>((resolve) => { release = resolve })
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: {
        genshin: { sync: async () => await pending }
      }
    })

    const operation = orchestrator.syncPersonalData('genshin', 'exploration')
    expect(orchestrator.isPersonalSyncActive('genshin', 'exploration')).toBe(true)
    expect(orchestrator.isPersonalSyncActive('genshin')).toBe(true)
    release!({
      items: [personalMap(50)],
      accountScope,
      snapshotCompleteness: 'complete',
      adapterVersion: 'test-v1',
      message: '读取完成'
    })
    await operation
    expect(orchestrator.isPersonalSyncActive('genshin', 'exploration')).toBe(false)
  })

  it.each([
    ['genshin', ['深境螺旋', '幻想真境剧诗', '幽境危战']],
    ['star-rail', ['混沌回忆', '虚构叙事', '末日幻影', '异相仲裁']],
    ['zenless', ['式舆防卫战', '危局强袭战']],
    ['wuthering-waves', ['逆境深塔', '冥歌海墟', '终焉矩阵']]
  ] as const)('个人接口未返回挑战记录时由本地目录补齐 %s 全部模式', async (
    gameId,
    expectedTitles
  ) => {
    database = new AppDatabase(':memory:')
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: {
        [gameId]: {
          sync: async () => ({
            items: [],
            accountScope,
            snapshotCompleteness: 'complete',
            adapterVersion: 'test-v1',
            message: '官方当前没有挑战记录'
          })
        }
      }
    })

    await expect(orchestrator.syncPersonalOnly(gameId, 'cycles'))
      .resolves.toMatchObject({ status: 'success' })
    const cycles = database.listChecklistItems(gameId).filter(
      (item) => item.category === 'endgame'
    )
    expect(cycles.map((item) => item.title).sort()).toEqual(
      [...expectedTitles].sort()
    )
    expect(cycles.every((item) => item.source === 'personal_sync' && !item.completed)).toBe(true)
  })

  it.each([
    ['genshin', 'imaginarium-theater', '幻想真境剧诗',
      ['深境螺旋', '幻想真境剧诗', '幽境危战'], 31],
    ['wuthering-waves', 'endstate-matrix', '终焉矩阵',
      ['逆境深塔', '冥歌海墟', '终焉矩阵'], 28]
  ] as const)('接口只返回已过期记录时仍建立 %s 当前期完整清单', async (
    gameId,
    modeKey,
    title,
    expectedTitles,
    durationDays
  ) => {
    database = new AppDatabase(':memory:')
    const now = Date.now()
    const endsAt = new Date(now - 60 * 60 * 1000)
    const startsAt = new Date(endsAt.getTime() - durationDays * 24 * 60 * 60 * 1000)
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: {
        [gameId]: {
          sync: async () => ({
            items: [{
              remoteKey: `endgame:${modeKey}`,
              category: 'endgame' as const,
              title,
              completed: true,
              modeKey,
              periodKey: `${gameId}:${modeKey}:expired`,
              startsAt: startsAt.toISOString(),
              endsAt: endsAt.toISOString(),
              sourceIdentity: {
                provider: gameId === 'wuthering-waves' ? 'kuro-community' : 'miyoushe',
                endpoint: 'personal-challenge-record',
                externalId: `${modeKey}:expired`
              }
            }],
            accountScope,
            snapshotCompleteness: 'complete' as const,
            adapterVersion: 'test-v1',
            message: '官方仍返回上一期记录'
          })
        }
      }
    })

    await expect(orchestrator.syncPersonalOnly(gameId, 'cycles'))
      .resolves.toMatchObject({ status: 'success' })
    const cycles = database.listChecklistItems(gameId).filter(
      (item) => item.category === 'endgame'
    )
    const current = cycles.find((item) => item.modeKey === modeKey)!

    expect(cycles.map((item) => item.title).sort()).toEqual([...expectedTitles].sort())
    expect(current).toMatchObject({ title, completed: false, source: 'personal_sync' })
    expect(Date.parse(current.startsAt!)).toBeLessThanOrEqual(Date.now())
    expect(Date.parse(current.endsAt!)).toBeGreaterThan(Date.now())
  })

  it('公开清单和个人清单由用户选择切换，不再自动融合', async () => {
    database = new AppDatabase(':memory:')
    const custom = database.createChecklistItem({
      gameId: 'genshin', category: 'custom', title: '自定义养成计划'
    })
    database.createChecklistItem({
      gameId: 'genshin', category: 'exploration', title: '用户手填地图'
    })
    const publicSync = vi.fn(async () => ({
      items: [{ remoteKey: 'map:public:liyue', category: 'exploration' as const, title: '璃月' }],
      message: '公开资料已同步'
    }))
    const personalSync = vi.fn(async () => ({
      items: [personalMap(86)],
      accountScope,
      snapshotCompleteness: 'complete' as const,
      adapterVersion: 'test-v1',
      message: '个人进度已同步'
    }))
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: { genshin: { sync: publicSync } },
      personalData: { genshin: { sync: personalSync } }
    })

    await orchestrator.syncGame('genshin', 'public_schedule', 'exploration')
    expect(database.listChecklistItems('genshin').some((item) => item.source === 'public_schedule'))
      .toBe(true)
    const personal = await orchestrator.syncPersonalOnly('genshin', 'exploration')

    expect(personal.status).toBe('success')
    expect(publicSync).toHaveBeenCalledTimes(1)
    expect(database.listChecklistItems('genshin').filter((item) => item.category === 'exploration'))
      .toEqual([expect.objectContaining({ title: '璃月', source: 'personal_sync', progressPercent: 86 })])
    expect(database.listChecklistItems('genshin')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: custom.id, title: '自定义养成计划' }),
      expect.objectContaining({ id: 'genshin:main_quest' }),
      expect.objectContaining({ id: 'genshin:side_quest' })
    ]))
    expect(database.getSourceBinding('genshin', 'miyoushe', 'personal-map-progress', '6'))
      .toMatchObject({ bindingKind: 'mechanical', confidence: 1 })
    expect(database.getSyncTargetStates('genshin')).toContainEqual(expect.objectContaining({
      target: 'exploration', catalogSource: 'personal_data', catalogCoverage: 'complete'
    }))
  })

  it('同步进度不调用公开适配器或旧目录准备器', async () => {
    database = new AppDatabase(':memory:')
    const publicSync = vi.fn(async () => ({ items: [], message: '不应运行' }))
    const prepare = vi.fn()
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: { genshin: { sync: publicSync } },
      personalData: { genshin: { sync: async () => ({
        items: [personalMap(72)], accountScope,
        snapshotCompleteness: 'complete', adapterVersion: 'test-v1', message: '完成'
      }) } }
    }, undefined, prepare)

    await expect(orchestrator.syncPersonalOnly('genshin', 'exploration'))
      .resolves.toMatchObject({ status: 'success' })
    expect(publicSync).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  })

  it('部分个人响应不会修改上一份完整快照', async () => {
    database = new AppDatabase(':memory:')
    let partial = false
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: { genshin: { sync: async () => ({
        items: [personalMap(partial ? 12 : 66)], accountScope,
        snapshotCompleteness: partial ? 'partial' : 'complete',
        adapterVersion: 'test-v1', message: '读取完成'
      }) } }
    })
    await orchestrator.syncPersonalOnly('genshin', 'exploration')
    partial = true
    const second = await orchestrator.syncPersonalOnly('genshin', 'exploration')

    expect(second.status).toBe('error')
    expect(second.message).toContain('已保留上次个人清单')
    expect(database.listChecklistItems('genshin').find((item) => item.title === '璃月'))
      .toMatchObject({ progressPercent: 66 })
  })

  it('个人活动先激活官方快照，再把语义异常交给 Codex 后台修正', async () => {
    database = new AppDatabase(':memory:')
    database.replacePersonalSnapshot(
      'genshin',
      'events',
      accountScope,
      [{
        remoteKey: 'personal-event:miyoushe:event-api:old',
        category: 'limited_event',
        title: '旧个人活动',
        activityTags: ['战斗'],
        endsAt: '2026-09-01T00:00:00.000Z',
        sourceIdentity: { provider: 'miyoushe', endpoint: 'event-api', externalId: 'old' }
      }],
      'test-v1',
      new Date('2026-08-01T00:00:00.000Z')
    )
    const proposed = {
      remoteKey: 'personal-event:miyoushe:event-api:new',
      category: 'limited_event' as const,
      title: '待核验新活动',
      endsAt: '2026-09-10T00:00:00.000Z',
      sourceIdentity: { provider: 'miyoushe', endpoint: 'event-api', externalId: 'new' }
    }
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: { genshin: { sync: async () => ({
        items: [proposed],
        reviewCandidates: [{
          target: 'events',
          kind: 'personal-item-semantics',
          payload: {
            provider: 'miyoushe', sourceContext: 'event-api', officialEventId: 'new',
            title: proposed.title, observedStatus: { isFinished: false },
            reviewIssues: ['classification'], proposedItem: proposed
          }
        }],
        accountScope,
        snapshotCompleteness: 'complete',
        adapterVersion: 'test-v2',
        message: '个人活动已读取'
      }) } }
    })
    const result = await orchestrator.syncPersonalOnly(
      'genshin',
      'events',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' }
    )
    expect(result).toMatchObject({
      status: 'success',
      sources: [expect.objectContaining({
        pendingReview: 1,
        reviewMode: 'background'
      })]
    })
    expect(database.listChecklistItems('genshin').some((item) => item.title === '旧个人活动'))
      .toBe(false)
    expect(database.listChecklistItems('genshin').some((item) => item.title === proposed.title))
      .toBe(true)
    expect(database.getActiveAiScheduleJob('genshin', 'events', 'personal_review'))
      .toMatchObject({ reviewTargets: [expect.objectContaining({ kind: 'personal-item-semantics' })] })
  })

  it('完整个人快照移除已不在官方结果中的旧项并保留稳定项目 ID', async () => {
    database = new AppDatabase(':memory:')
    const first = database.replacePersonalSnapshot('genshin', 'exploration', accountScope, [
      personalMap(20),
      {
        ...personalMap(30), remoteKey: 'personal-map:miyoushe:7', title: '蒙德',
        sourceIdentity: { provider: 'miyoushe', endpoint: 'personal-map-progress', externalId: '7' }
      }
    ], 'test-v1')
    expect(first.added).toBe(2)
    const stableId = database.listChecklistItems('genshin').find((item) => item.title === '璃月')!.id

    database.replacePersonalSnapshot('genshin', 'exploration', accountScope, [personalMap(100)], 'test-v1')
    const maps = database.listChecklistItems('genshin').filter((item) => item.category === 'exploration')
    expect(maps).toHaveLength(1)
    expect(maps[0]).toMatchObject({ id: stableId, progressPercent: 100, completed: true })
  })

  it('个人同步项不可进入回收站且手动回收站与快照更新隔离', () => {
    database = new AppDatabase(':memory:')
    const mondstadt = {
      ...personalMap(20),
      remoteKey: 'personal-map:miyoushe:7',
      title: '蒙德',
      sourceIdentity: {
        provider: 'miyoushe',
        endpoint: 'personal-map-progress',
        externalId: '7'
      }
    }
    database.replacePersonalSnapshot(
      'genshin',
      'exploration',
      accountScope,
      [personalMap(100), mondstadt],
      'test-v1'
    )
    expect(database.archiveCompletedSection('genshin', ['exploration'])).toBe(0)
    const syncedLiyue = database.listChecklistItems('genshin').find((item) => item.title === '璃月')!
    expect(() => database!.archiveChecklistItem(syncedLiyue.id)).toThrow('系统清单由同步维护，不能删除')
    const manual = database.createChecklistItem({
      gameId: 'genshin',
      category: 'custom',
      title: '稍后恢复的手动事项'
    })
    database.archiveChecklistItem(manual.id)

    expect(() => database!.replacePersonalSnapshot(
      'genshin',
      'exploration',
      accountScope,
      [personalMap(100), { ...mondstadt, progressPercent: 80 }],
      'test-v1'
    )).not.toThrow()
    expect(database.listArchivedChecklistItems('genshin')).toEqual([
      expect.objectContaining({ title: '稍后恢复的手动事项', source: 'manual' })
    ])
    expect(database.listChecklistItems('genshin').filter(
      (item) => item.category === 'exploration'
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '璃月', progressPercent: 100 }),
      expect.objectContaining({ title: '蒙德', progressPercent: 80 })
    ]))

    expect(database.emptyRecycleBin('genshin')).toBe(1)
    expect(database.listArchivedChecklistItems('genshin')).toEqual([])
    expect(database.listChecklistItems('genshin').filter(
      (item) => item.category === 'exploration'
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '璃月', progressPercent: 100 }),
      expect.objectContaining({ title: '蒙德', progressPercent: 80 })
    ]))
  })

  it('活动状态语义未知时不猜完成，但同一官方活动保留用户手工状态', () => {
    database = new AppDatabase(':memory:')
    const event = {
      remoteKey: 'personal-event:miyoushe:event-api:1',
      category: 'limited_event' as const,
      title: '官方活动',
      sourceIdentity: { provider: 'miyoushe', endpoint: 'event-api', externalId: '1' }
    }
    database.replacePersonalSnapshot('genshin', 'events', accountScope, [event], 'test-v1')
    const item = database.listChecklistItems('genshin').find((candidate) => candidate.title === '官方活动')!
    database.updateChecklistItem({ id: item.id, completed: true })
    database.replacePersonalSnapshot('genshin', 'events', accountScope, [event], 'test-v1')
    expect(database.listChecklistItems('genshin').find((candidate) => candidate.id === item.id))
      .toMatchObject({ completed: true })
  })

  it('个人周期快照替换挑战但始终保留固定周常', () => {
    database = new AppDatabase(':memory:')
    database.replacePersonalSnapshot('genshin', 'cycles', accountScope, [{
      remoteKey: 'endgame:spiral-abyss',
      category: 'endgame',
      title: '深境螺旋',
      completed: true,
      periodKey: 'genshin:spiral-abyss:42',
      sourceIdentity: {
        provider: 'miyoushe',
        endpoint: 'personal-challenge-record',
        externalId: 'endgame:spiral-abyss|period:genshin:spiral-abyss:42'
      }
    }], 'test-v1')
    expect(database.listChecklistItems('genshin')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'genshin:weekly', category: 'weekly' }),
      expect.objectContaining({ title: '深境螺旋', source: 'personal_sync', completed: true })
    ]))
  })

  it('凭据验证失败时保留现有清单', async () => {
    database = new AppDatabase(':memory:')
    database.replacePersonalSnapshot('genshin', 'exploration', accountScope, [personalMap(40)], 'test-v1')
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {},
      personalData: { genshin: { sync: async () => {
        throw new SyncVerificationRequiredError('米游社凭据已失效')
      } } }
    })
    const result = await orchestrator.syncPersonalOnly('genshin', 'exploration')
    expect(result.sources[0].status).toBe('verification_required')
    expect(database.listChecklistItems('genshin').find((item) => item.title === '璃月'))
      .toMatchObject({ progressPercent: 40 })
  })

  it('公开资料读取失败时不提前清除当前个人清单', async () => {
    database = new AppDatabase(':memory:')
    database.replacePersonalSnapshot('genshin', 'exploration', accountScope, [personalMap(44)], 'test-v1')
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: { genshin: { sync: async () => { throw new Error('联网失败') } } },
      personalData: {}
    })
    await expect(orchestrator.syncGame('genshin', 'public_schedule', 'exploration'))
      .resolves.toMatchObject({ status: 'error' })
    expect(database.listChecklistItems('genshin').find((item) => item.title === '璃月'))
      .toMatchObject({ source: 'personal_sync', progressPercent: 44 })
  })

  it('取消个人同步会中断适配器且不写入数据', async () => {
    database = new AppDatabase(':memory:')
    const sync = vi.fn(async (_gameId, _target, _progress, signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return { items: [personalMap(88)], accountScope, snapshotCompleteness: 'complete' as const, message: '完成' }
    })
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {}, personalData: { genshin: { sync } }
    })
    const operation = orchestrator.syncPersonalOnly('genshin', 'exploration')
    await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce())
    expect(orchestrator.cancelPersonalSync('genshin', 'exploration')).toBe(true)
    await expect(operation).resolves.toMatchObject({ status: 'cancelled' })
    expect(database.listChecklistItems('genshin').some((item) => item.category === 'exploration')).toBe(false)
  })

  it('同一目标的并发个人同步复用请求，应用退出取消全部任务', async () => {
    database = new AppDatabase(':memory:')
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const sync = vi.fn(async () => {
      await gate
      return { items: [personalMap(55)], accountScope, snapshotCompleteness: 'complete' as const, message: '完成' }
    })
    const orchestrator = new SyncOrchestrator(database, {
      publicSchedule: {}, personalData: { genshin: { sync } }
    })
    const first = orchestrator.syncPersonalData('genshin', 'exploration')
    const second = orchestrator.syncPersonalData('genshin', 'exploration')
    release()
    expect(await second).toEqual(await first)
    expect(sync).toHaveBeenCalledOnce()
  })
})
