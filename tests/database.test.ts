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
  it('只初始化四款支持的游戏和每款游戏的主支线状态', () => {
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

    expect(database.resetDueWeeklyItems(nextPeriodReference)).toBe(1)
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

  it('挑战玩法进入新周期时清除上一周期完成状态和手动完成锁', () => {
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
        remoteKey: 'endgame:shiyu-defense',
        category: 'endgame',
        title: '式舆防卫战',
        periodKey: '2026-07-b',
        modeKey: 'shiyu-defense'
      }
    ])

    const nextPeriod = database.listChecklistItems('zenless').find((candidate) => candidate.id === item.id)!
    expect(nextPeriod).toMatchObject({
      periodKey: '2026-07-b',
      completed: false,
      completedAt: null,
      manualCompletionLocked: false
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

  it('已安装 Codex 插件时可在没有活动心跳的情况下先排队', () => {
    database = new AppDatabase(':memory:')

    expect(() => database!.createAiScheduleJob('genshin', 'public_schedule')).toThrow('尚未连接')
    const queued = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date('2026-07-21T14:45:00.000Z'),
      true
    )

    expect(queued).toMatchObject({
      gameId: 'genshin',
      scope: 'public_schedule',
      status: 'pending',
      agentId: null,
      agentName: null
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
