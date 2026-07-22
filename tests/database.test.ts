import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database'

let database: AppDatabase | null = null
let temporaryDirectory: string | null = null

afterEach(() => {
  database?.close()
  database = null
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe('AppDatabase', () => {
  it('新用户只初始化四款游戏的主线和支线状态', () => {
    database = new AppDatabase(':memory:')

    expect(database.listGames().map((game) => game.id)).toEqual([
      'genshin',
      'star-rail',
      'zenless',
      'wuthering-waves'
    ])

    for (const game of database.listGames()) {
      const items = database.listChecklistItems(game.id)
      expect(items.map((item) => item.category)).toEqual(['main_quest', 'side_quest'])
    }
    expect(() =>
      database!.createChecklistItem({
        gameId: 'genshin',
        category: 'main_quest',
        title: '第二条主线'
      })
    ).toThrow('不能重复新增')
    expect(() => database!.archiveChecklistItem('genshin:main_quest')).toThrow('固定清单事项不能删除')
  })

  it('新增、编辑、手动完成和软删除事项', () => {
    database = new AppDatabase(':memory:')
    const created = database.createChecklistItem({
      gameId: 'genshin',
      category: 'exploration',
      title: '枫丹探索',
      progressPercent: 42
    })

    expect(created.completed).toBe(false)
    expect(created.progressPercent).toBe(42)

    const completed = database.updateChecklistItem({
      id: created.id,
      title: '枫丹探索收尾',
      completed: true,
      progressPercent: 100
    })
    expect(completed.title).toBe('枫丹探索收尾')
    expect(completed.completed).toBe(true)
    expect(completed.manualCompletionLocked).toBe(true)
    expect(completed.completedAt).not.toBeNull()

    const reopened = database.updateChecklistItem({ id: created.id, completed: false })
    expect(reopened.completed).toBe(false)
    expect(reopened.manualCompletionLocked).toBe(false)
    expect(reopened.completedAt).toBeNull()

    database.archiveChecklistItem(created.id)
    expect(database.listChecklistItems('genshin').some((item) => item.id === created.id)).toBe(false)
    expect(database.listArchivedChecklistItems('genshin').map((item) => item.id)).toContain(created.id)

    const restored = database.restoreChecklistItem(created.id)
    expect(restored.id).toBe(created.id)
    expect(database.listChecklistItems('genshin').some((item) => item.id === created.id)).toBe(true)
  })

  it('关闭并重新打开数据库后保留数据且迁移可重复执行', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-task-manager-test-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    const created = database.createChecklistItem({
      gameId: 'star-rail',
      category: 'custom',
      title: '持久化测试'
    })
    database.close()

    database = new AppDatabase(databasePath)
    const items = database.listChecklistItems('star-rail')
    expect(items.find((item) => item.id === created.id)?.title).toBe('持久化测试')
    expect(items.filter((item) => item.category === 'main_quest')).toHaveLength(1)
    expect(items.filter((item) => item.category === 'side_quest')).toHaveLength(1)
  })

  it('批量删除只归档指定版块内的已完成事项', () => {
    database = new AppDatabase(':memory:')
    const completedEvent = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '已完成活动'
    })
    const pendingEvent = database.createChecklistItem({
      gameId: 'genshin',
      category: 'permanent_event',
      title: '未完成活动'
    })
    const completedCustom = database.createChecklistItem({
      gameId: 'genshin',
      category: 'custom',
      title: '已完成自定义事项'
    })
    database.updateChecklistItem({ id: completedEvent.id, completed: true })
    database.updateChecklistItem({ id: completedCustom.id, completed: true })

    expect(
      database.archiveCompletedSection('genshin', ['limited_event', 'permanent_event'])
    ).toBe(1)

    const remaining = database.listChecklistItems('genshin')
    expect(remaining.some((item) => item.id === completedEvent.id)).toBe(false)
    expect(remaining.some((item) => item.id === pendingEvent.id)).toBe(true)
    expect(remaining.some((item) => item.id === completedCustom.id)).toBe(true)
  })

  it('固定周常不会被删除，并在周一跨周期后恢复为未完成', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'weekly:genshin',
      category: 'weekly',
      title: '周常'
    }])
    const weekly = database.listChecklistItems('genshin').find((item) => item.id === 'genshin:weekly')!
    database.updateChecklistItem({ id: weekly.id, completed: true })

    expect(database.archiveCompletedSection('genshin', ['weekly', 'endgame'])).toBe(0)
    expect(() => database!.archiveChecklistItem(weekly.id)).toThrow('固定清单事项不能删除')

    const nextPeriodReference = new Date(new Date(weekly.endsAt!).getTime() + 1)
    expect(database.resetDueWeeklyItems(nextPeriodReference)).toBeGreaterThanOrEqual(1)
    expect(database.listChecklistItems('genshin').find((item) => item.id === weekly.id)).toMatchObject({
      completed: false,
      manualCompletionLocked: false
    })
  })

  it('同一版块中临期事项优先、完成事项沉底', () => {
    database = new AppDatabase(':memory:')
    const normal = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '普通活动',
      endsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    })
    const urgent = database.createChecklistItem({
      gameId: 'genshin',
      category: 'permanent_event',
      title: '最后一天活动',
      endsAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    })
    database.updateChecklistItem({ id: urgent.id, completed: true })
    const pendingUrgent = database.createChecklistItem({
      gameId: 'genshin',
      category: 'permanent_event',
      title: '未完成的最后一天活动',
      endsAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    })

    const eventIds = database
      .listChecklistItems('genshin')
      .filter((item) => item.category === 'limited_event' || item.category === 'permanent_event')
      .map((item) => item.id)
    expect(eventIds).toEqual([pendingUrgent.id, normal.id, urgent.id])
  })

  it('挑战事项到期后不再自动重置完成状态', () => {
    database = new AppDatabase(':memory:')
    const abyss = database.createChecklistItem({
      gameId: 'genshin',
      category: 'endgame',
      title: '深境螺旋',
      startsAt: '2026-07-01T20:00:00.000Z',
      endsAt: '2026-07-15T20:00:00.000Z',
      modeKey: 'spiral-abyss',
      recurrenceRule: 'monthly-days:1,16@04:00[Asia/Shanghai]'
    })
    database.updateChecklistItem({ id: abyss.id, completed: true, progressPercent: 100 })

    expect(database.resetDueWeeklyItems(new Date('2026-07-16T00:00:00.000Z'))).toBe(0)
    expect(database.listChecklistItems('genshin').find((item) => item.id === abyss.id)).toMatchObject({
      completed: true,
      manualCompletionLocked: true,
      progressPercent: 100,
      startsAt: '2026-07-01T20:00:00.000Z',
      endsAt: '2026-07-15T20:00:00.000Z',
      recurrenceRule: null
    })
  })

  it('按游戏独立保存自动同步模式和范围', () => {
    database = new AppDatabase(':memory:')
    expect(database.getSyncSettings('genshin')).toMatchObject({
      runMode: 'manual',
      autoScope: 'public_schedule'
    })

    database.updateSyncSettings({
      gameId: 'genshin',
      runMode: 'automatic',
      autoScope: 'public_and_personal'
    })

    expect(database.getSyncSettings('genshin')).toMatchObject({
      runMode: 'automatic',
      autoScope: 'public_and_personal'
    })
    expect(database.getSyncSettings('star-rail').runMode).toBe('manual')
    expect(database.listAutomaticSyncSettings().map((settings) => settings.gameId)).toEqual([
      'genshin'
    ])
  })

  it('周常跨周期后自动重置完成状态和手动完成锁', () => {
    database = new AppDatabase(':memory:')
    const weekly = database.createChecklistItem({
      gameId: 'zenless',
      category: 'weekly',
      title: '周常测试'
    })
    expect(weekly).toMatchObject({
      scheduleKind: 'weekly',
      resetWeekday: 1,
      timeZone: 'Asia/Shanghai'
    })
    expect(weekly.periodKey).toMatch(/^weekly:Asia\/Shanghai:1:/)

    const completed = database.updateChecklistItem({ id: weekly.id, completed: true })
    expect(completed.manualCompletionLocked).toBe(true)
    const nextPeriodReference = new Date(new Date(completed.endsAt!).getTime() + 1)

    expect(database.resetDueWeeklyItems(nextPeriodReference)).toBeGreaterThanOrEqual(1)
    const reset = database.listChecklistItems('zenless').find((item) => item.id === weekly.id)!
    expect(reset.completed).toBe(false)
    expect(reset.completedAt).toBeNull()
    expect(reset.manualCompletionLocked).toBe(false)
    expect(reset.periodKey).not.toBe(weekly.periodKey)
  })

  it('同步合并保留手动事项、手动完成锁和已归档远端事项', () => {
    database = new AppDatabase(':memory:')
    const manual = database.createChecklistItem({
      gameId: 'genshin',
      category: 'custom',
      title: '手动事项'
    })

    expect(
      database.mergeSyncedItems('genshin', 'personal_sync', [
        {
          remoteKey: 'abyss:2026-07',
          category: 'endgame',
          title: '深境螺旋',
          completed: false,
          periodKey: '2026-07'
        }
      ])
    ).toEqual({ added: 1, updated: 0, preserved: 0 })

    const remote = database
      .listChecklistItems('genshin')
      .find((item) => item.remoteKey === 'abyss:2026-07')!
    database.updateChecklistItem({ id: remote.id, completed: true })

    expect(
      database.mergeSyncedItems('genshin', 'personal_sync', [
        {
          remoteKey: 'abyss:2026-07',
          category: 'endgame',
          title: '深境螺旋（远端更新）',
          completed: false,
          periodKey: '2026-07'
        }
      ])
    ).toEqual({ added: 0, updated: 1, preserved: 1 })

    const protectedRemote = database
      .listChecklistItems('genshin')
      .find((item) => item.id === remote.id)!
    expect(protectedRemote.completed).toBe(true)
    expect(protectedRemote.title).toBe('深境螺旋（远端更新）')
    expect(database.listChecklistItems('genshin').find((item) => item.id === manual.id)?.title).toBe(
      '手动事项'
    )

    database.archiveChecklistItem(remote.id)
    expect(
      database.mergeSyncedItems('genshin', 'personal_sync', [
        {
          remoteKey: 'abyss:2026-07',
          category: 'endgame',
          title: '深境螺旋',
          completed: true
        }
      ])
    ).toEqual({ added: 0, updated: 0, preserved: 1 })
    expect(database.listChecklistItems('genshin').some((item) => item.id === remote.id)).toBe(false)
  })

  it('同步批次异常时事务回滚且不删除上次成功数据', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('zenless', 'public_schedule', [
      { remoteKey: 'event:stable', category: 'limited_event', title: '已保存活动' }
    ])

    expect(() =>
      database!.mergeSyncedItems('zenless', 'public_schedule', [
        { remoteKey: 'event:new', category: 'limited_event', title: '新活动' },
        { remoteKey: '', category: 'limited_event', title: '非法活动' }
      ])
    ).toThrow('远端事项标识格式不正确')

    const syncedTitles = database
      .listChecklistItems('zenless')
      .filter((item) => item.source === 'public_schedule')
      .map((item) => item.title)
    expect(syncedTitles).toEqual(['已保存活动'])
  })

  it('公开排期和个人数据使用同一规范标识时合并为一条事项', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('genshin', 'public_schedule', [
      {
        remoteKey: 'endgame:abyss:2026-07-b',
        category: 'endgame',
        title: '深境螺旋',
        sourceUrl: 'https://example.com/genshin/abyss',
        startsAt: '2026-07-16T20:00:00.000Z',
        endsAt: '2026-08-01T19:59:59.999Z',
        modeKey: 'abyss'
      }
    ])
    database.mergeSyncedItems('genshin', 'personal_sync', [
      {
        remoteKey: 'endgame:abyss:2026-07-b',
        category: 'endgame',
        title: '个人接口内部名称',
        completed: true,
        progressPercent: 100,
        startsAt: '2026-07-01T00:00:00.000Z',
        modeKey: 'abyss'
      }
    ])

    const matches = database
      .listChecklistItems('genshin')
      .filter((item) => item.remoteKey === 'endgame:abyss:2026-07-b')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      source: 'public_schedule',
      title: '深境螺旋',
      completed: true,
      progressPercent: 100,
      startsAt: '2026-07-16T20:00:00.000Z',
      sourceUrl: 'https://example.com/genshin/abyss',
      modeKey: 'abyss'
    })
  })

  it('个人数据先到达时，后续公开排期仍取得元数据优先级', () => {
    database = new AppDatabase(':memory:')
    const remoteKey = 'endgame:shiyu-defense'
    database.mergeSyncedItems('zenless', 'personal_sync', [
      {
        remoteKey,
        category: 'endgame',
        title: '个人接口内部名称',
        completed: true,
        progressPercent: 80,
        startsAt: '2026-07-01T00:00:00.000Z'
      }
    ])
    database.mergeSyncedItems('zenless', 'public_schedule', [
      {
        remoteKey,
        category: 'endgame',
        title: '式舆防卫战',
        sourceUrl: 'https://example.com/zenless/shiyu',
        startsAt: '2026-07-16T20:00:00.000Z',
        endsAt: '2026-08-01T19:59:59.999Z'
      }
    ])
    database.mergeSyncedItems('zenless', 'personal_sync', [
      {
        remoteKey,
        category: 'endgame',
        title: '又一次个人接口名称',
        completed: false,
        progressPercent: 90,
        startsAt: '2026-07-02T00:00:00.000Z'
      }
    ])

    const matches = database
      .listChecklistItems('zenless')
      .filter((item) => item.remoteKey === remoteKey)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      source: 'public_schedule',
      title: '式舆防卫战',
      completed: false,
      progressPercent: 90,
      startsAt: '2026-07-16T20:00:00.000Z',
      endsAt: '2026-08-01T19:59:59.999Z',
      sourceUrl: 'https://example.com/zenless/shiyu'
    })
  })

  it('挑战玩法进入新周期时新增清单并保留上一期完成记录', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('zenless', 'public_schedule', [
      {
        remoteKey: 'endgame:shiyu-defense',
        category: 'endgame',
        title: '式舆防卫战',
        periodKey: '2026-07-a',
        modeKey: 'shiyu-defense'
      }
    ])
    const item = database
      .listChecklistItems('zenless')
      .find((candidate) => candidate.remoteKey === 'endgame:shiyu-defense')!
    database.updateChecklistItem({ id: item.id, completed: true })

    database.mergeSyncedItems('zenless', 'public_schedule', [
      {
        remoteKey: 'endgame:shiyu-defense:2026-07-b',
        category: 'endgame',
        title: '式舆防卫战',
        periodKey: '2026-07-b',
        modeKey: 'shiyu-defense'
      }
    ])

    const periods = database.listChecklistItems('zenless')
      .filter((candidate) => candidate.modeKey === 'shiyu-defense')
    expect(periods).toHaveLength(2)
    expect(periods.find((candidate) => candidate.id === item.id)).toMatchObject({
      periodKey: '2026-07-a',
      completed: true,
      manualCompletionLocked: true
    })
    expect(periods.find((candidate) => candidate.periodKey === '2026-07-b')).toMatchObject({
      periodKey: '2026-07-b',
      completed: false,
      completedAt: null,
      manualCompletionLocked: false
    })
  })

  it('个人战绩只更新当前挑战周期，不改写已完成历史期', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('zenless', 'public_schedule', [
      {
        remoteKey: 'official:shiyu:2026-07-a',
        category: 'endgame',
        title: '式舆防卫战·上一期',
        startsAt: '2026-07-01T20:00:00.000Z',
        endsAt: '2026-07-15T19:59:59.999Z',
        periodKey: 'public-period-a',
        modeKey: 'shiyu-defense'
      },
      {
        remoteKey: 'official:shiyu:2026-07-b',
        category: 'endgame',
        title: '式舆防卫战·本期',
        startsAt: '2026-07-15T20:00:00.000Z',
        endsAt: '2026-08-01T19:59:59.999Z',
        periodKey: 'public-period-b',
        modeKey: 'shiyu-defense'
      }
    ], '2026-07-20T00:00:00.000Z')
    const history = database.listChecklistItems('zenless')
      .find((item) => item.periodKey === 'public-period-a')!
    database.updateChecklistItem({ id: history.id, completed: true })

    database.mergeSyncedItems('zenless', 'personal_sync', [{
      remoteKey: 'endgame:shiyu-defense',
      category: 'endgame',
      title: '个人接口名称',
      completed: true,
      periodKey: 'personal-schedule-42',
      modeKey: 'shiyu-defense'
    }], '2026-07-20T01:00:00.000Z')

    const periods = database.listChecklistItems('zenless')
      .filter((item) => item.modeKey === 'shiyu-defense')
    expect(periods).toHaveLength(2)
    expect(periods.find((item) => item.id === history.id)).toMatchObject({
      title: '式舆防卫战·上一期',
      completed: true,
      periodKey: 'public-period-a'
    })
    expect(periods.find((item) => item.periodKey === 'personal-schedule-42')).toMatchObject({
      title: '式舆防卫战·本期',
      completed: true,
      source: 'public_schedule'
    })
  })

  it('可检测其他本地进程写入数据库，供 AI 命令触发界面刷新', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-task-manager-version-test-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    const before = database.getDataVersion()
    const externalConnection = new AppDatabase(databasePath)
    try {
      externalConnection.createChecklistItem({
        gameId: 'wuthering-waves',
        category: 'custom',
        title: '外部 AI 写入'
      })
      expect(database.getDataVersion()).toBeGreaterThan(before)
    } finally {
      externalConnection.close()
    }
  })

  it('已完成初始同步的游戏在下次启动时补齐固定周常', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-task-manager-weekly-test-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    database.recordSyncOutcome('genshin', 'success', '初始同步完成', true)
    database.close()

    database = new AppDatabase(databasePath)
    expect(database.listChecklistItems('genshin').find((item) => item.id === 'genshin:weekly'))
      .toMatchObject({
        category: 'weekly',
        title: '周常',
        completed: false,
        scheduleKind: 'weekly',
        resetWeekday: 1,
        timeZone: 'Asia/Shanghai'
      })
    expect(database.listChecklistItems('star-rail').some((item) => item.category === 'weekly'))
      .toBe(false)
  })

  it('已安装 Codex 插件时可在没有活动心跳的情况下先排队', () => {
    database = new AppDatabase(':memory:')

    expect(() => database!.createAiScheduleJob('genshin', 'public_schedule')).toThrow('尚未连接')
    const queued = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date('2026-07-21T14:45:00.000Z'),
      true,
      'all',
      'Asia/Shanghai'
    )

    expect(queued).toMatchObject({
      gameId: 'genshin',
      scope: 'public_schedule',
      target: 'all',
      userTimeZone: 'Asia/Shanghai',
      status: 'pending',
      agentId: null,
      agentName: null
    })

    const upgraded = database.createAiScheduleJob(
      'genshin',
      'public_and_personal',
      new Date('2026-07-21T14:46:00.000Z'),
      true
    )
    expect(upgraded).toMatchObject({ id: queued.id, scope: 'public_and_personal' })
    expect(database.getSyncSettings('genshin').lastScope).toBe('public_and_personal')
  })

  it('公开排期回写后保留同轮个人数据需要验证的状态', () => {
    database = new AppDatabase(':memory:')
    database.registerAiScheduleAgent('agent-personal-state', '测试 Agent')
    const queued = database.createAiScheduleJob(
      'zenless',
      'public_and_personal',
      new Date(),
      false,
      'events'
    )
    const claimed = database.claimAiScheduleJob('agent-personal-state')!
    expect(claimed.id).toBe(queued.id)
    database.recordSyncOutcome(
      'zenless',
      'verification_required',
      '米游社需要完成滑块或设备验证',
      false
    )

    database.applyAiScheduleJob(
      queued.id,
      'agent-personal-state',
      [{
        remoteKey: 'event:test-public',
        category: 'limited_event',
        title: '公开活动'
      }],
      []
    )

    expect(database.getSyncSettings('zenless')).toMatchObject({
      status: 'verification_required',
      message: expect.stringContaining('米游社需要完成滑块或设备验证')
    })
    expect(database.getSyncSettings('zenless').lastSuccessAt).not.toBeNull()
  })

  it('版块同步任务拒绝跨版块回写', () => {
    database = new AppDatabase(':memory:')
    database.registerAiScheduleAgent('agent-section', '版块测试 Agent')
    const queued = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date('2026-07-22T11:00:00.000Z'),
      false,
      'events'
    )
    database.claimAiScheduleJob('agent-section', new Date('2026-07-22T11:01:00.000Z'))

    expect(() => database!.applyAiScheduleJob(
      queued.id,
      'agent-section',
      [{ remoteKey: 'map:natlan', category: 'exploration', title: '纳塔' }],
      []
    )).toThrow('只允许回写“events”版块')
  })

  it('原神周期同步必须同时包含三种挑战并自动补齐周常', () => {
    database = new AppDatabase(':memory:')
    database.registerAiScheduleAgent('agent-genshin-cycles', '原神周期测试 Agent')
    const queued = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date('2026-07-22T11:00:00.000Z'),
      false,
      'cycles'
    )
    database.claimAiScheduleJob('agent-genshin-cycles', new Date('2026-07-22T11:01:00.000Z'))

    expect(() => database!.applyAiScheduleJob(
      queued.id,
      'agent-genshin-cycles',
      [{
        remoteKey: 'genshin:stygian-onslaught:2026-07',
        category: 'endgame',
        title: '幽境危战',
        modeKey: 'stygian-onslaught',
        periodKey: '2026-07'
      }],
      []
    )).toThrow('缺少：深境螺旋、幻想真境剧诗')

    database.applyAiScheduleJob(
      queued.id,
      'agent-genshin-cycles',
      [
        {
          remoteKey: 'genshin:spiral-abyss:2026-07',
          category: 'endgame',
          title: '深境螺旋',
          modeKey: 'spiral-abyss',
          periodKey: '2026-07'
        },
        {
          remoteKey: 'genshin:imaginarium-theater:2026-07',
          category: 'endgame',
          title: '幻想真境剧诗',
          modeKey: 'imaginarium-theater',
          periodKey: '2026-07'
        },
        {
          remoteKey: 'genshin:stygian-onslaught:2026-07',
          category: 'endgame',
          title: '幽境危战',
          modeKey: 'stygian-onslaught',
          periodKey: '2026-07'
        }
      ],
      []
    )

    const cycles = database.listChecklistItems('genshin')
      .filter((item) => item.category === 'weekly' || item.category === 'endgame')
    expect(cycles.map((item) => item.modeKey).filter(Boolean).sort()).toEqual([
      'imaginarium-theater',
      'spiral-abyss',
      'stygian-onslaught'
    ])
    expect(cycles.find((item) => item.id === 'genshin:weekly')).toMatchObject({
      title: '周常',
      category: 'weekly'
    })
  })

  it('四款游戏的周期同步都拒绝遗漏主要挑战玩法', () => {
    database = new AppDatabase(':memory:')
    database.registerAiScheduleAgent('agent-cycle-completeness', '周期完整性测试 Agent')
    const cases = [
      ['genshin', '深境螺旋、幻想真境剧诗、幽境危战'],
      ['star-rail', '混沌回忆、虚构叙事、末日幻影、异相仲裁'],
      ['zenless', '式舆防卫战、危局强袭战'],
      ['wuthering-waves', '逆境深塔、冥歌海墟']
    ] as const

    for (const [gameId, missingTitles] of cases) {
      const queued = database.createAiScheduleJob(gameId, 'public_schedule', new Date(), false, 'cycles')
      database.claimAiScheduleJob('agent-cycle-completeness')
      expect(() => database!.applyAiScheduleJob(
        queued.id,
        'agent-cycle-completeness',
        [],
        []
      )).toThrow(`周期同步缺少：${missingTitles}`)
    }
  })

  it('公开地图目录新增为零进度，个人数据只补充对应探索度', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'official-map:natlan',
      category: 'exploration',
      title: '纳塔',
      parentTitle: '提瓦特大陆',
      modeKey: 'region:natlan'
    }])
    expect(database.listChecklistItems('genshin').find((item) => item.modeKey === 'region:natlan'))
      .toMatchObject({ progressPercent: 0, completed: false })

    database.mergeSyncedItems('genshin', 'personal_sync', [{
      remoteKey: 'chronicle:natlan',
      category: 'exploration',
      title: '纳塔个人探索',
      modeKey: 'region:natlan',
      progressPercent: 100
    }])
    const maps = database.listChecklistItems('genshin').filter((item) => item.modeKey === 'region:natlan')
    expect(maps).toHaveLength(1)
    expect(maps[0]).toMatchObject({ title: '纳塔', progressPercent: 100, completed: true })
  })

  it('个人战绩可按模式键补全公开排期，即使两个来源的远端键不同', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'official:hard-challenge:202607',
      category: 'endgame',
      title: '幽境危战',
      modeKey: 'stygian-onslaught',
      periodKey: 'official-period-1',
      startsAt: '2026-07-20T02:00:00.000Z',
      endsAt: '2026-08-10T01:59:59.000Z'
    }])

    database.mergeSyncedItems('genshin', 'personal_sync', [{
      remoteKey: 'endgame:stygian-onslaught',
      category: 'endgame',
      title: '幽境危战（个人数据）',
      modeKey: 'stygian-onslaught',
      periodKey: 'personal-period-1',
      completed: true,
      progressPercent: 100
    }])

    const items = database.listChecklistItems('genshin').filter((item) => item.modeKey === 'stygian-onslaught')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: '幽境危战',
      source: 'public_schedule',
      completed: true,
      progressPercent: 100,
      remoteKey: 'official:hard-challenge:202607'
    })
  })

  it('成功同步超过时限后只标记过期并保留最后成功时间', () => {
    database = new AppDatabase(':memory:')
    database.recordSyncOutcome('genshin', 'success', '同步成功')
    const success = database.getSyncSettings('genshin')
    const future = new Date(new Date(success.lastSuccessAt!).getTime() + 25 * 60 * 60 * 1000)

    expect(database.markStaleSyncStates(future)).toBe(1)
    expect(database.getSyncSettings('genshin')).toMatchObject({
      status: 'stale',
      lastSuccessAt: success.lastSuccessAt
    })
  })

  it('旧程序拒绝打开更高版本数据库，避免降级写入', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-newer-schema-test-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    database.close()
    database = null

    const newerDatabase = new DatabaseSync(databasePath)
    newerDatabase.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(CURRENT_SCHEMA_VERSION + 1)
    newerDatabase.close()

    expect(() => new AppDatabase(databasePath)).toThrow(
      `期望 ${CURRENT_SCHEMA_VERSION}，实际 ${CURRENT_SCHEMA_VERSION + 1}`
    )
  })
})
