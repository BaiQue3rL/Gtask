import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database'
import { getBundledMapCatalog } from '../src/main/sync/map-catalog'

let database: AppDatabase | null = null
let temporaryDirectory: string | null = null

afterEach(() => {
  database?.close()
  database = null
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe('AppDatabase', () => {
  it('周期挑战到期后生成当前预测期，并允许官方延期校时恢复手工状态', () => {
    database = new AppDatabase(':memory:')
    database.replacePublicCatalog('genshin', 'cycles', [{
      remoteKey: 'endgame:spiral-abyss',
      category: 'endgame',
      title: '深境螺旋·旧后缀',
      completed: false,
      startsAt: '2026-06-15T20:00:00.000Z',
      endsAt: '2026-07-16T20:00:00.000Z',
      periodKey: 'official:old',
      scheduleKind: 'remote_schedule',
      modeKey: 'spiral-abyss'
    }], '2026-07-01T00:00:00.000Z')
    const before = database.listChecklistItems('genshin').find(
      (item) => item.modeKey === 'spiral-abyss'
    )!
    database.updateChecklistItem({ id: before.id, completed: true })

    expect(database.rolloverDueCycleItems(new Date('2026-08-01T00:00:00.000Z'))).toBe(1)
    const predicted = database.listChecklistItems('genshin').find((item) => item.id === before.id)!
    expect(predicted).toMatchObject({
      title: '深境螺旋',
      completed: false,
      modeKey: 'spiral-abyss',
      periodKey: expect.stringContaining('predicted:genshin:spiral-abyss:')
    })
    expect(Date.parse(predicted.endsAt!)).toBeGreaterThan(Date.parse('2026-08-01T00:00:00.000Z'))

    database.replacePublicCatalog('genshin', 'cycles', [{
      remoteKey: 'endgame:spiral-abyss',
      category: 'endgame',
      title: '深境螺旋',
      startsAt: '2026-06-15T20:00:00.000Z',
      endsAt: '2026-08-05T20:00:00.000Z',
      periodKey: 'official:delayed',
      scheduleKind: 'remote_schedule',
      modeKey: 'spiral-abyss'
    }], '2026-08-01T01:00:00.000Z')

    expect(database.listChecklistItems('genshin').find((item) => item.id === before.id)).toMatchObject({
      completed: true,
      periodKey: 'official:delayed',
      endsAt: '2026-08-05T20:00:00.000Z'
    })
  })

  it('持久化仅供 Gtask 后台使用的 Codex 推理设置', () => {
    database = new AppDatabase(':memory:')
    expect(database.getCodexWorkerPreferences()).toEqual({
      strategy: 'fixed',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium'
    })

    expect(database.updateCodexWorkerPreferences({
      strategy: 'fixed',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh'
    })).toEqual({
      strategy: 'fixed',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh'
    })
  })

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

  it('活动玩法标签可编辑，切出活动分类后自动清空', () => {
    database = new AppDatabase(':memory:')
    const created = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '玩法标签活动',
      activityTags: ['战斗', '跑酷']
    })
    expect(created.activityTags).toEqual(['战斗', '跑酷'])

    const updated = database.updateChecklistItem({
      id: created.id,
      activityTags: ['解谜']
    })
    expect(updated.activityTags).toEqual(['解谜'])

    const moved = database.updateChecklistItem({
      id: created.id,
      category: 'custom'
    })
    expect(moved.activityTags).toEqual([])
  })

  it('公开资料刷新不会融合或改写旧个人活动', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('star-rail', 'personal_sync', [{
      remoteKey: 'personal:event:legacy',
      category: 'limited_event',
      title: '旧活动',
      startsAt: '2026-07-20T02:00:00.000Z',
      endsAt: '2026-08-10T01:59:00.000Z'
    }])
    expect(database.listChecklistItems('star-rail').find((item) => item.title === '旧活动'))
      .toMatchObject({ activityTags: [] })

    database.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'public:event:legacy',
      category: 'limited_event',
      title: '旧活动',
      activityTags: ['战斗'],
      startsAt: '2026-07-20T02:00:00.000Z',
      endsAt: '2026-08-10T01:59:00.000Z'
    }])
    expect(database.listChecklistItems('star-rail').filter((item) => item.title === '旧活动'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ source: 'personal_sync', activityTags: [] }),
        expect.objectContaining({ source: 'public_schedule', activityTags: ['战斗'] })
      ]))
  })

  it('四款游戏的活动同步都会把有效未知活动列为强制标签补全目标', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-26T00:00:00.000Z')
    database.registerAiScheduleAgent('tag-target-agent', '标签补全 Agent', reference)

    for (const gameId of ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const) {
      database.mergeSyncedItems(gameId, 'public_schedule', [
        {
          remoteKey: `${gameId}:active-unknown`,
          category: 'limited_event',
          title: `${gameId} 有效未知活动`,
          startsAt: '2026-07-20T00:00:00.000Z',
          endsAt: '2026-08-20T00:00:00.000Z'
        },
        {
          remoteKey: `${gameId}:expired-unknown`,
          category: 'limited_event',
          title: `${gameId} 已过期未知活动`,
          startsAt: '2026-06-01T00:00:00.000Z',
          endsAt: '2026-06-20T00:00:00.000Z'
        },
        {
          remoteKey: `${gameId}:classified`,
          category: 'limited_event',
          title: `${gameId} 已分类活动`,
          activityTags: ['战斗'],
          startsAt: '2026-07-20T00:00:00.000Z',
          endsAt: '2026-08-20T00:00:00.000Z'
        },
        {
          remoteKey: `${gameId}:generic-placeholder`,
          category: 'limited_event',
          title: `${gameId} 泛化占位活动`,
          activityTags: ['活动玩法'],
          startsAt: '2026-07-20T00:00:00.000Z',
          endsAt: '2026-08-20T00:00:00.000Z'
        }
      ])
      const queued = database.createAiScheduleJob(
        gameId,
        'public_schedule',
        reference,
        false,
        'events'
      )
      const claimed = database.claimAiScheduleJob('tag-target-agent', reference)!
      expect(claimed.id).toBe(queued.id)
      expect(claimed.activityTagTargets.map((target) => target.title)).toEqual([
        `${gameId} 有效未知活动`,
        `${gameId} 泛化占位活动`
      ])
      database.failAiScheduleJob(queued.id, 'tag-target-agent', '测试结束', reference)
    }
  })

  it('活动标签无法确认时允许留空，不阻塞其他可靠清单结果', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-26T00:00:00.000Z')
    database.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'personal:event:must-enrich',
      category: 'limited_event',
      title: '必须补全的旧活动',
      startsAt: '2026-07-20T00:00:00.000Z',
      endsAt: '2026-08-20T00:00:00.000Z'
    }])
    database.registerAiScheduleAgent('tag-coverage-agent', '标签覆盖 Agent', reference)
    const queued = database.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      reference,
      false,
      'events'
    )
    database.claimAiScheduleJob('tag-coverage-agent', reference)

    const result = database.applyAiScheduleJob(
      queued.id,
      'tag-coverage-agent',
      [{
        remoteKey: 'public:event:new',
        category: 'limited_event',
        title: '本轮新增活动',
        startsAt: '2026-07-26T10:00:00+08:00',
        endsAt: '2026-08-10T03:59:00+08:00'
      }],
      [],
      reference
    )
    expect(database.listChecklistItems('star-rail').some((item) => item.title === '本轮新增活动'))
      .toBe(true)
    expect(database.listChecklistItems('star-rail').find(
      (item) => item.title === '必须补全的旧活动'
    )?.activityTags).toEqual([])
    expect(result.job.status).toBe('completed')
  })

  it('标签专用回写只修改玩法标签并保留个人活动的时间、来源和完成状态', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-26T00:00:00.000Z')
    database.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'personal:event:tag-only',
      category: 'limited_event',
      title: '标签专用回写活动',
      completed: true,
      startsAt: '2026-07-20T00:00:00.000Z',
      endsAt: '2026-08-20T00:00:00.000Z'
    }], reference.toISOString())
    const before = database.listChecklistItems('star-rail')
      .find((item) => item.title === '标签专用回写活动')!
    database.registerAiScheduleAgent('tag-only-agent', '标签专用 Agent', reference)
    const queued = database.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      reference,
      false,
      'events'
    )
    const target = database.claimAiScheduleJob('tag-only-agent', reference)!.activityTagTargets[0]

    const result = database.applyAiScheduleJob(
      queued.id,
      'tag-only-agent',
      [],
      [],
      reference,
      [{
        itemId: target.itemId,
        title: target.title,
        activityTags: ['签到', '任务', '节庆'],
        sourceUrl: 'https://example.com/cn/tag-proof',
        confidence: 0.98
      }]
    )

    const after = database.listChecklistItems('star-rail')
      .find((item) => item.id === before.id)!
    expect(after).toMatchObject({
      activityTags: ['签到', '任务', '节庆'],
      source: 'public_schedule',
      remoteKey: before.remoteKey,
      startsAt: before.startsAt,
      endsAt: before.endsAt,
      completed: false
    })
    expect(result.job).toMatchObject({ status: 'completed' })
    expect(database.getSyncSettings('star-rail')).toMatchObject({ status: 'success' })
  })

  it('无法确认的活动不能用未知标签结束任务，必须继续检索', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-26T00:00:00.000Z')
    database.mergeSyncedItems('zenless', 'public_schedule', [{
      remoteKey: 'personal:event:unresolved',
      category: 'limited_event',
      title: '资料不足的活动',
      startsAt: '2026-07-20T00:00:00.000Z',
      endsAt: '2026-08-20T00:00:00.000Z'
    }])
    database.registerAiScheduleAgent('unresolved-tag-agent', '未知标签 Agent', reference)
    const queued = database.createAiScheduleJob(
      'zenless',
      'public_schedule',
      reference,
      false,
      'events'
    )
    const target = database.claimAiScheduleJob('unresolved-tag-agent', reference)!.activityTagTargets[0]

    expect(() => database!.applyAiScheduleJob(
      queued.id,
      'unresolved-tag-agent',
      [],
      [],
      reference,
      [{
        itemId: target.itemId,
        title: target.title,
        activityTags: ['未知', '任务', '节庆'],
        sourceUrl: 'https://example.com/cn/unresolved',
        confidence: 0.95,
        unresolvedReason: '已交叉检索官方公告和中文社区，但均未公布具体玩法'
      }]
    )).toThrow('必须提供 1 到 5 个有证据、含核心玩法的标签')
    expect(database.getActiveAiScheduleJob('zenless', 'events', 'public_catalog'))
      .toMatchObject({ id: queued.id, status: 'claimed' })
  })

  it('启动时把旧限时活动的空标签、待识别和英文分类键统一为中文', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-activity-tags-test-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    const empty = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '旧空标签活动'
    })
    const legacy = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '旧待识别活动',
      activityTags: ['未知']
    })
    const english = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '旧英文标签活动',
      activityTags: ['战斗']
    })
    const structural = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '旧结构标签活动',
      activityTags: ['战斗']
    })
    database.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    raw.prepare('UPDATE checklist_items SET activity_tags_json = ? WHERE id = ?')
      .run('["待识别"]', legacy.id)
    raw.prepare('UPDATE checklist_items SET activity_tags_json = ? WHERE id = ?')
      .run('["shooting","puzzle"]', english.id)
    raw.prepare('UPDATE checklist_items SET activity_tags_json = ? WHERE id = ?')
      .run('["限时活动","个人数据","战斗"]', structural.id)
    raw.close()

    database = new AppDatabase(databasePath)
    expect(database.listChecklistItems('genshin').find((item) => item.id === empty.id))
      .toMatchObject({ activityTags: ['未知'] })
    expect(database.listChecklistItems('genshin').find((item) => item.id === legacy.id))
      .toMatchObject({ activityTags: ['未知'] })
    expect(database.listChecklistItems('genshin').find((item) => item.id === english.id))
      .toMatchObject({ activityTags: ['射击', '解谜'] })
    expect(database.listChecklistItems('genshin').find((item) => item.id === structural.id))
      .toMatchObject({ activityTags: ['战斗'] })
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

  it('批量删除只归档自定义清单内的已完成手动事项', () => {
    database = new AppDatabase(':memory:')
    const completedEvent = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '已完成活动'
    })
    const pendingEvent = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '未完成活动'
    })
    const completedCustom = database.createChecklistItem({
      gameId: 'genshin',
      category: 'custom',
      title: '已完成自定义事项'
    })
    database.updateChecklistItem({ id: completedEvent.id, completed: true })
    database.updateChecklistItem({ id: completedCustom.id, completed: true })

    expect(database.archiveCompletedSection('genshin', ['limited_event'])).toBe(0)
    expect(database.archiveCompletedSection('genshin', ['custom'])).toBe(1)

    const remaining = database.listChecklistItems('genshin')
    expect(remaining.some((item) => item.id === completedEvent.id)).toBe(true)
    expect(remaining.some((item) => item.id === pendingEvent.id)).toBe(true)
    expect(remaining.some((item) => item.id === completedCustom.id)).toBe(false)
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

  it('同步来源提供的周常会归并到每个游戏唯一的固定周常', () => {
    database = new AppDatabase(':memory:')
    database!.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'star-rail:weekly:simulated-universe',
      category: 'weekly',
      title: '货币战争&模拟宇宙周期积分'
    }])
    database!.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'star-rail:weekly:another-source',
      category: 'weekly',
      title: '其他周常名称'
    }])

    const weeklyItems = database!.listChecklistItems('star-rail')
      .filter((item) => item.category === 'weekly')
    expect(weeklyItems).toHaveLength(1)
    expect(weeklyItems[0]).toMatchObject({
      id: 'star-rail:weekly',
      title: '周常',
      remoteKey: 'weekly:star-rail',
      scheduleKind: 'weekly'
    })
  })

  it('目录覆盖度只会由局部升级为完整，不会被后续个人增量降级', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('genshin', 'events', 'personal_data', 'partial')
    expect(database.getSyncTargetStates('genshin')).toContainEqual(expect.objectContaining({
      target: 'events',
      catalogCoverage: 'partial',
      catalogSource: 'personal_data'
    }))
    database.recordCatalogCoverage('genshin', 'events', 'public_schedule', 'complete')
    database.recordCatalogCoverage('genshin', 'events', 'personal_data', 'partial')
    expect(database.getSyncTargetStates('genshin')).toContainEqual(expect.objectContaining({
      target: 'events',
      catalogCoverage: 'complete',
      catalogSource: 'public_schedule'
    }))
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
      category: 'limited_event',
      title: '最后一天活动',
      endsAt: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString()
    })
    database.updateChecklistItem({ id: urgent.id, completed: true })
    const pendingUrgent = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '未完成的最后一天活动',
      endsAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
    })
    const upcoming = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '即将开始但尚未开放的活动',
      startsAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      endsAt: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
    })

    const eventIds = database
      .listChecklistItems('genshin')
      .filter((item) => item.category === 'limited_event')
      .map((item) => item.id)
    expect(eventIds).toEqual([pendingUrgent.id, normal.id, upcoming.id, urgent.id])
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

  it('同步设置固定为手动模式', () => {
    database = new AppDatabase(':memory:')
    expect(database.getSyncSettings('genshin')).toMatchObject({
      runMode: 'manual',
      autoScope: 'public_schedule'
    })
    expect(database.getSyncSettings('star-rail')).toMatchObject({
      runMode: 'manual',
      autoScope: 'public_schedule'
    })
  })

  it('分别记录全局和版块同步时间', () => {
    database = new AppDatabase(':memory:')
    expect(database.getSyncTargetStates('genshin')).toEqual([
      { gameId: 'genshin', target: 'all', lastSuccessAt: null, lastAttemptAt: null, status: 'idle', catalogCoverage: 'empty', catalogSource: null },
      { gameId: 'genshin', target: 'tasks', lastSuccessAt: null, lastAttemptAt: null, status: 'idle', catalogCoverage: 'empty', catalogSource: null },
      { gameId: 'genshin', target: 'events', lastSuccessAt: null, lastAttemptAt: null, status: 'idle', catalogCoverage: 'empty', catalogSource: null },
      { gameId: 'genshin', target: 'cycles', lastSuccessAt: null, lastAttemptAt: null, status: 'idle', catalogCoverage: 'empty', catalogSource: null },
      { gameId: 'genshin', target: 'exploration', lastSuccessAt: null, lastAttemptAt: null, status: 'idle', catalogCoverage: 'empty', catalogSource: null }
    ])

    database.recordSyncTargetSuccess('genshin', 'events', new Date('2026-07-22T12:00:00.000Z'))
    expect(database.getSyncTargetStates('genshin')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gameId: 'genshin', target: 'all', lastSuccessAt: null }),
        expect.objectContaining({
          gameId: 'genshin',
          target: 'events',
          lastSuccessAt: '2026-07-22T12:00:00.000Z',
          lastAttemptAt: '2026-07-22T12:00:00.000Z',
          status: 'success'
        })
      ])
    )

    database.recordSyncTargetAttempt(
      'genshin',
      'events',
      'error',
      new Date('2026-07-22T12:30:00.000Z')
    )
    expect(database.getSyncTargetStates('genshin')).toContainEqual(expect.objectContaining({
      target: 'events',
      lastSuccessAt: '2026-07-22T12:00:00.000Z',
      lastAttemptAt: '2026-07-22T12:30:00.000Z',
      status: 'error'
    }))

    database.recordSyncTargetSuccess('genshin', 'all', new Date('2026-07-22T13:00:00.000Z'), true)
    expect(database.getSyncTargetStates('genshin').every(
      (state) => state.lastSuccessAt === '2026-07-22T13:00:00.000Z'
    )).toBe(true)
  })

  it('清空回收站仅永久删除当前游戏的已归档事项', () => {
    database = new AppDatabase(':memory:')
    const genshin = database.createChecklistItem({
      gameId: 'genshin',
      category: 'custom',
      title: '原神回收项'
    })
    const starRail = database.createChecklistItem({
      gameId: 'star-rail',
      category: 'custom',
      title: '星铁回收项'
    })
    database.archiveChecklistItem(genshin.id)
    database.archiveChecklistItem(starRail.id)
    expect(database.emptyRecycleBin('genshin')).toBe(1)
    expect(database.listArchivedChecklistItems('genshin')).toEqual([])
    expect(database.listArchivedChecklistItems('star-rail')).toHaveLength(1)
  })

  it('changes the checklist revision only for checklist item writes', () => {
    database = new AppDatabase(':memory:')
    const initialRevision = database.getChecklistRevision()
    database.registerAiScheduleAgent(
      'revision-agent',
      'Revision Agent',
      new Date('2026-07-31T12:00:00.000Z')
    )
    database.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      new Date('2026-07-31T12:00:01.000Z'),
      false,
      'events'
    )
    expect(database.getChecklistRevision()).toBe(initialRevision)

    database.createChecklistItem({
      gameId: 'star-rail',
      category: 'custom',
      title: 'Revision marker'
    })
    expect(database.getChecklistRevision()).not.toBe(initialRevision)
  })

  it('版更校时只更新时间，同版本保留状态，新版本和到期时重置任务', () => {
    database = new AppDatabase(':memory:')
    const quest = (category: 'main_quest' | 'side_quest') =>
      database!.listChecklistItems('genshin').find((item) => item.category === category)!
    const versionItems = (periodKey: string, startsAt: string, endsAt: string) => [
      {
        remoteKey: 'version:main',
        category: 'main_quest' as const,
        title: '主线任务',
        periodKey,
        startsAt,
        endsAt,
        scheduleKind: 'fixed_window' as const,
        timeZone: 'Asia/Shanghai',
        sourceUrl: 'https://example.com/version'
      },
      {
        remoteKey: 'version:side',
        category: 'side_quest' as const,
        title: '支线任务',
        periodKey,
        startsAt,
        endsAt,
        scheduleKind: 'fixed_window' as const,
        timeZone: 'Asia/Shanghai',
        sourceUrl: 'https://example.com/version'
      }
    ]

    database.updateChecklistItem({ id: 'genshin:main_quest', completed: true })
    database.mergeSyncedItems(
      'genshin',
      'public_schedule',
      versionItems('genshin:version:6.0', '2026-07-01T02:00:00.000Z', '2026-08-01T02:00:00.000Z'),
      '2026-07-24T12:00:00.000Z'
    )
    expect(quest('main_quest')).toMatchObject({
      completed: true,
      endsAt: '2026-08-01T02:00:00.000Z',
      periodKey: 'genshin:version:6.0'
    })

    database.mergeSyncedItems(
      'genshin',
      'public_schedule',
      versionItems('genshin:version:6.0', '2026-07-01T02:00:00.000Z', '2026-08-05T02:00:00.000Z'),
      '2026-07-25T12:00:00.000Z'
    )
    expect(quest('main_quest')).toMatchObject({
      completed: true,
      endsAt: '2026-08-05T02:00:00.000Z'
    })

    database.mergeSyncedItems(
      'genshin',
      'public_schedule',
      versionItems('genshin:version:6.1', '2026-08-05T02:00:00.000Z', '2026-09-16T02:00:00.000Z'),
      '2026-08-05T03:00:00.000Z'
    )
    expect(quest('main_quest')).toMatchObject({
      completed: false,
      completedAt: null,
      manualCompletionLocked: false,
      periodKey: 'genshin:version:6.1'
    })

    database.updateChecklistItem({ id: 'genshin:main_quest', completed: true })
    database.updateChecklistItem({ id: 'genshin:side_quest', completed: true })
    expect(database.resetDueQuestItems(new Date('2026-09-16T02:00:01.000Z'))).toBe(2)
    expect(quest('main_quest')).toMatchObject({
      completed: false,
      startsAt: null,
      endsAt: null,
      resetRule: '待同步新版本时间'
    })
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

    expect(() => database!.archiveChecklistItem(remote.id)).toThrow('系统清单由同步维护，不能删除')
    expect(
      database.mergeSyncedItems('genshin', 'personal_sync', [
        {
          remoteKey: 'abyss:2026-07',
          category: 'endgame',
          title: '深境螺旋',
          completed: true
        }
      ])
    ).toEqual({ added: 0, updated: 1, preserved: 0 })
    expect(database.listChecklistItems('genshin').some((item) => item.id === remote.id)).toBe(true)
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

  it.skip('旧融合流程：公开排期和个人数据使用同一规范标识时合并', () => {
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
      progressPercent: null,
      startsAt: '2026-07-16T20:00:00.000Z',
      sourceUrl: 'https://example.com/genshin/abyss',
      modeKey: 'abyss'
    })
  })

  it('四款游戏同一期挑战即使远端键和周期键格式变化也只保留一项', () => {
    database = new AppDatabase(':memory:')
    const gameIds = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const

    for (const gameId of gameIds) {
      const modeKey = `mode-${gameId}`
      const startsAt = '2026-07-20T04:00:00+08:00'
      const endsAt = '2026-08-17T03:59:00+08:00'
      database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `${gameId}:endgame:first-key`,
        category: 'endgame',
        title: `${gameId} 周期挑战`,
        modeKey,
        periodKey: '2026-07-20',
        startsAt,
        endsAt
      }])
      const original = database.listChecklistItems(gameId)
        .find((item) => item.modeKey === modeKey)!
      database.updateChecklistItem({ id: original.id, completed: true })

      expect(database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `${gameId}:endgame:renamed-key`,
        category: 'endgame',
        title: `${gameId} 周期挑战`,
        modeKey,
        periodKey: '2026-07-20_2026-08-17',
        startsAt,
        endsAt
      }])).toEqual({ added: 0, updated: 1, preserved: 0 })

      expect(database.listChecklistItems(gameId)
        .filter((item) => item.modeKey === modeKey)).toEqual([
        expect.objectContaining({
          id: original.id,
          periodKey: '2026-07-20_2026-08-17',
          completed: true,
          manualCompletionLocked: true
        })
      ])
    }
  })

  it('四款游戏的活动、地图、周常和固定任务不会因远端键变化产生重复项', () => {
    database = new AppDatabase(':memory:')
    const gameIds = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const

    for (const gameId of gameIds) {
      const eventTitle = `${gameId} 同步活动`
      const startsAt = '2026-07-20T04:00:00+08:00'
      const endsAt = '2026-08-17T03:59:00+08:00'
      database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `${gameId}:event:first-key`,
        category: 'limited_event',
        title: eventTitle,
        activityTags: ['战斗'],
        startsAt,
        endsAt
      }])
      database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `${gameId}:event:renamed-key`,
        category: 'limited_event',
        title: eventTitle,
        activityTags: ['战斗'],
        startsAt,
        endsAt
      }])

      const regionTitle = `${gameId} 测试区域`
      database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `${gameId}:region:first-key`,
        category: 'exploration',
        title: regionTitle,
        modeKey: `${gameId}:region:first-mode`
      }])
      database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `${gameId}:region:renamed-key`,
        category: 'exploration',
        title: regionTitle,
        modeKey: `${gameId}:region:renamed-mode`
      }])

      database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `${gameId}:weekly:first-key`,
        category: 'weekly',
        title: '任意周常名称'
      }])
      database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `${gameId}:weekly:renamed-key`,
        category: 'weekly',
        title: '另一个周常名称'
      }])

      const items = database.listChecklistItems(gameId)
      expect(items.filter((item) => item.title === eventTitle)).toHaveLength(1)
      expect(items.filter((item) => item.title === regionTitle)).toHaveLength(1)
      expect(items.filter((item) => item.category === 'weekly')).toHaveLength(1)
      expect(items.filter((item) => item.category === 'main_quest')).toHaveLength(1)
      expect(items.filter((item) => item.category === 'side_quest')).toHaveLength(1)
    }
  })

  it('启动时不归并仍有效的历史挑战，并硬删除已经到期的系统挑战', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-endgame-duplicate-cleanup-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    database.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    const insert = raw.prepare(`
      INSERT INTO checklist_items(
        id, game_id, category, title, completed, starts_at, ends_at,
        period_key, mode_key, source, remote_key, manual_completion_locked,
        completed_at, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, 'endgame', ?, ?, ?, ?, ?, ?, 'public_schedule', ?, ?, ?, ?, ?, ?)
    `)
    const gameIds = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const
    for (const gameId of gameIds) {
      insert.run(
        `${gameId}:duplicate:pending`,
        gameId,
        `${gameId} 历史挑战`,
        0,
        '2026-07-20T04:00:00+08:00',
        '2026-08-17T03:59:00+08:00',
        '2026-07-20_2026-08-17',
        `${gameId}:historical-mode`,
        `${gameId}:new-key`,
        0,
        null,
        '2026-07-25T13:49:00.000Z',
        '2026-07-25T13:49:00.000Z',
        '2026-07-25T13:49:00.000Z'
      )
      insert.run(
        `${gameId}:duplicate:completed`,
        gameId,
        `${gameId} 历史挑战`,
        1,
        '2026-07-20T04:00:00+08:00',
        '2026-08-17T03:59:00+08:00',
        '2026-07-20',
        `${gameId}:historical-mode`,
        `${gameId}:old-key`,
        1,
        '2026-07-25T13:40:00.000Z',
        '2026-07-25T13:40:00.000Z',
        '2026-07-25T13:40:00.000Z',
        '2026-07-25T13:40:00.000Z'
      )
    }
    insert.run(
      'zenless:separate-period:first',
      'zenless',
      '绝区零 独立历史期',
      1,
      '2026-06-01T04:00:00+08:00',
      '2026-06-15T03:59:00+08:00',
      '2026-06-a',
      'zenless:separate-period-mode',
      'zenless:stable-mode-key:first',
      1,
      '2026-06-10T00:00:00.000Z',
      '2026-06-10T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
      '2026-06-10T00:00:00.000Z'
    )
    insert.run(
      'zenless:separate-period:second',
      'zenless',
      '绝区零 独立历史期',
      0,
      '2026-06-15T04:00:00+08:00',
      '2026-07-01T03:59:00+08:00',
      '2026-06-b',
      'zenless:separate-period-mode',
      'zenless:stable-mode-key:second',
      0,
      null,
      '2026-06-20T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
      '2026-06-20T00:00:00.000Z'
    )
    raw.close()

    database = new AppDatabase(databasePath)
    for (const gameId of gameIds) {
      expect(database.listChecklistItems(gameId)
        .filter((item) => item.modeKey === `${gameId}:historical-mode`)).toHaveLength(2)
      expect(database.listArchivedChecklistItems(gameId)
        .filter((item) => item.modeKey === `${gameId}:historical-mode`)).toHaveLength(0)
    }
    expect(database.listChecklistItems('zenless')
      .filter((item) => item.modeKey === 'zenless:separate-period-mode')).toHaveLength(0)
  })

  it.skip('旧融合流程：个人活动按中文名和时间回填公开排期', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'event:public:paper-bird',
      category: 'limited_event',
      title: '折纸小鸟对对碰',
      startsAt: '2026-07-01T04:00:00.000Z',
      endsAt: '2026-07-30T03:59:59.000Z',
      sourceUrl: 'https://example.com/star-rail/events'
    }])
    database.mergeSyncedItems('star-rail', 'personal_sync', [{
      remoteKey: 'event:miyoushe:5001',
      category: 'limited_event',
      title: '折纸小鸟对对碰',
      completed: true,
      progressPercent: 100,
      startsAt: '2026-07-01T04:00:00.000Z',
      endsAt: '2026-07-30T03:59:59.000Z',
      modeKey: 'official-event-5001'
    }])

    const matches = database.listChecklistItems('star-rail')
      .filter((item) => item.category === 'limited_event')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      title: '折纸小鸟对对碰',
      completed: true,
      progressPercent: null,
      source: 'public_schedule',
      remoteKey: 'event:public:paper-bird'
    })
  })

  it.skip('旧融合流程：个人活动标题子串匹配公开活动', () => {
    database = new AppDatabase(':memory:')
    const startsAt = '2026-07-18T02:00:00.000Z'
    const endsAt = '2026-08-02T19:59:59.000Z'
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'event:public:heated-battle',
      category: 'limited_event',
      title: '「七圣召唤」热斗模式：自行巧局',
      startsAt,
      endsAt
    }])
    database.mergeSyncedItems('genshin', 'personal_sync', [{
      remoteKey: 'event:miyoushe:336',
      category: 'limited_event',
      title: '活动日历内部标题',
      startsAt,
      endsAt,
      completed: false
    }])
    const duplicate = database.listChecklistItems('genshin')
      .find((item) => item.remoteKey === 'event:miyoushe:336')!
    database.updateChecklistItem({ id: duplicate.id, title: '热斗模式：自行巧局' })

    database.mergeSyncedItems('genshin', 'personal_sync', [{
      remoteKey: 'event:miyoushe:336',
      category: 'limited_event',
      title: '热斗模式：自行巧局',
      startsAt,
      endsAt,
      completed: true
    }])

    const active = database.listChecklistItems('genshin')
      .filter((item) => item.category === 'limited_event')
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({
      title: '「七圣召唤」热斗模式：自行巧局',
      source: 'public_schedule',
      completed: true
    })
    expect(database.listArchivedChecklistItems('genshin')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: duplicate.id, source: 'personal_sync' })
      ])
    )
  })

  it('四款游戏的无时间个人条目都不能凭空创建为活动', () => {
    database = new AppDatabase(':memory:')
    const gameIds = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const

    for (const gameId of gameIds) {
      const result = database.mergeSyncedItems(gameId, 'personal_sync', [{
        remoteKey: `event:personal:untimed:${gameId}`,
        category: 'limited_event',
        title: `${gameId} 无时间功能条目`,
        completed: true
      }])

      expect(result).toEqual({ added: 0, updated: 0, preserved: 1 })
      expect(database.listChecklistItems(gameId)
        .filter((item) => item.category === 'limited_event')).toHaveLength(0)
    }
  })

  it('底层合并器不按历史挑战名称替 Codex 决定分类', () => {
    database = new AppDatabase(':memory:')
    const cases = [
      ['genshin', '幽境危战·本期'],
      ['star-rail', '虚构叙事·本期'],
      ['zenless', '危局强袭战·本期'],
      ['wuthering-waves', '逆境深塔·本期']
    ] as const

    for (const [gameId, title] of cases) {
      const result = database.mergeSyncedItems(gameId, 'personal_sync', [{
        remoteKey: `event:personal:misclassified:${gameId}`,
        category: 'limited_event',
        title,
        startsAt: '2026-07-20T02:00:00.000Z',
        endsAt: '2026-07-27T01:59:59.000Z',
        completed: true
      }])

      expect(result).toEqual({ added: 1, updated: 0, preserved: 0 })
      expect(database.listChecklistItems(gameId)
        .filter((item) => item.category === 'limited_event')).toHaveLength(1)
    }
  })

  it('四款游戏的未来活动都不能被个人数据提前标记完成', () => {
    database = new AppDatabase(':memory:')
    const gameIds = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const

    for (const gameId of gameIds) {
      database.mergeSyncedItems(gameId, 'personal_sync', [{
        remoteKey: `event:future:${gameId}`,
        category: 'limited_event',
        title: `${gameId} 未来活动`,
        startsAt: '2026-08-01T10:00:00+08:00',
        endsAt: '2026-08-10T03:59:00+08:00',
        completed: true,
        progressPercent: 100
      }], '2026-07-23T12:00:00.000Z')

      expect(database.listChecklistItems(gameId)
        .find((item) => item.remoteKey === `event:future:${gameId}`)).toMatchObject({
          completed: false,
          progressPercent: null
        })
    }
  })

  it.skip('旧融合流程：启动时保留 Codex 写入的个人活动状态', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-task-manager-star-rail-completion-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    database.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'event:public:auto-wrong',
      category: 'limited_event',
      title: '接口误完成活动',
      startsAt: '2026-07-15T11:00:00+08:00',
      endsAt: '2026-08-26T03:59:00+08:00'
    }])
    database.mergeSyncedItems('star-rail', 'personal_sync', [{
      remoteKey: 'event:personal:auto-wrong',
      category: 'limited_event',
      title: '接口误完成活动',
      startsAt: '2026-07-15T11:00:00+08:00',
      endsAt: '2026-08-26T03:59:00+08:00',
      completed: true,
      progressPercent: 100
    }], '2026-07-23T12:00:00.000Z')
    const automatic = database.listChecklistItems('star-rail')
      .find((item) => item.title === '接口误完成活动')!
    const manual = database.createChecklistItem({
      gameId: 'star-rail',
      category: 'limited_event',
      title: '用户手动完成活动'
    })
    database.updateChecklistItem({ id: manual.id, completed: true })
    database.close()

    database = new AppDatabase(databasePath)
    expect(database.listChecklistItems('star-rail')
      .find((item) => item.id === automatic.id)).toMatchObject({
        completed: true,
        progressPercent: null,
        manualCompletionLocked: false
      })
    expect(database.listChecklistItems('star-rail')
      .find((item) => item.id === manual.id)).toMatchObject({
        completed: true,
        manualCompletionLocked: true
      })
  })

  it.skip('旧融合流程：无时间个人条目补充公开活动', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('wuthering-waves', 'public_schedule', [{
      remoteKey: 'event:public:double-drop',
      category: 'limited_event',
      title: '材料双倍活动',
      startsAt: '2026-07-20T02:00:00.000Z',
      endsAt: '2026-07-27T01:59:59.000Z'
    }])

    const result = database.mergeSyncedItems('wuthering-waves', 'personal_sync', [{
      remoteKey: 'event:personal:double-drop',
      category: 'limited_event',
      title: '材料双倍活动',
      completed: true
    }])

    expect(result).toEqual({ added: 0, updated: 1, preserved: 0 })
    expect(database.listChecklistItems('wuthering-waves')
      .filter((item) => item.category === 'limited_event')).toEqual([
        expect.objectContaining({
          title: '材料双倍活动',
          source: 'public_schedule',
          completed: true,
          startsAt: '2026-07-20T02:00:00.000Z',
          endsAt: '2026-07-27T01:59:59.000Z',
          remoteKey: 'event:public:double-drop'
        })
      ])
  })

  it('启动时不再擅自归档 Codex 尚未处理的无时间个人活动', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-task-manager-untimed-cleanup-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    database.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    const insert = raw.prepare(`
      INSERT INTO checklist_items(
        id, game_id, category, title, source, remote_key, created_at, updated_at
      ) VALUES (?, ?, 'limited_event', ?, 'personal_sync', ?, ?, ?)
    `)
    for (const gameId of ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const) {
      insert.run(
        `untimed-${gameId}`,
        gameId,
        `${gameId} 历史无时间条目`,
        `event:personal:legacy:${gameId}`,
        '2026-07-23T00:00:00.000Z',
        '2026-07-23T00:00:00.000Z'
      )
    }
    raw.close()

    database = new AppDatabase(databasePath)
    for (const gameId of ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const) {
      expect(database.listChecklistItems(gameId)
        .some((item) => item.id === `untimed-${gameId}`)).toBe(true)
      expect(database.listArchivedChecklistItems(gameId)
        .some((item) => item.id === `untimed-${gameId}`)).toBe(false)
    }
  })

  it('启动时不再按标题关键词擅自归档疑似错位活动', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-task-manager-section-cleanup-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    database.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    raw.prepare(`
      INSERT INTO checklist_items(
        id, game_id, category, title, source, remote_key, created_at, updated_at
      ) VALUES (?, 'genshin', 'limited_event', ?, 'personal_sync', ?, ?, ?)
    `).run(
      'misclassified-stygian',
      '幽境危战·栗烈之役',
      'event:miyoushe:333',
      '2026-07-23T00:00:00.000Z',
      '2026-07-23T00:00:00.000Z'
    )
    raw.close()

    database = new AppDatabase(databasePath)
    expect(database.listChecklistItems('genshin')
      .some((item) => item.id === 'misclassified-stygian')).toBe(true)
    expect(database.listArchivedChecklistItems('genshin')
      .some((item) => item.id === 'misclassified-stygian')).toBe(false)
  })

  it.skip('旧融合流程：个人地图进度回填公开地图', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'exploration:public:fontaine',
      category: 'exploration',
      title: '枫丹',
      parentTitle: '提瓦特大陆'
    }])
    expect(database.listChecklistItems('genshin').find((item) => item.title === '枫丹'))
      .toMatchObject({ progressPercent: 0, completed: false })

    database.mergeSyncedItems('genshin', 'personal_sync', [{
      remoteKey: 'exploration:world:6',
      category: 'exploration',
      title: '枫丹',
      parentTitle: '世界探索',
      progressPercent: 87.5,
      completed: false,
      modeKey: 'world-exploration-6'
    }])

    const matches = database.listChecklistItems('genshin')
      .filter((item) => item.category === 'exploration' && item.title === '枫丹')
    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      progressPercent: 87.5,
      completed: false,
      source: 'public_schedule',
      remoteKey: 'exploration:public:fontaine'
    })
  })

  it('地图层级只做引用与循环校验，不硬编码游戏目录', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('star-rail', 'public_schedule', [
      {
        remoteKey: 'map:world:a',
        category: 'exploration',
        title: '自定义主区域',
        mapNodeKind: 'region'
      },
      {
        remoteKey: 'map:world:a:independent',
        category: 'exploration',
        title: '自定义二级区域',
        mapNodeKind: 'subregion',
        parentTitle: '自定义主区域',
        parentRemoteKey: 'map:world:a'
      }
    ])
    expect(database.listChecklistItems('star-rail').find(
      (item) => item.remoteKey === 'map:world:a:independent'
    )).toMatchObject({
      mapNodeKind: 'subregion',
      parentRemoteKey: 'map:world:a',
      progressPercent: 0
    })

    expect(() => database!.mergeSyncedItems('star-rail', 'public_schedule', [
      {
        remoteKey: 'map:loop:a',
        category: 'exploration',
        title: '循环 A',
        mapNodeKind: 'subregion',
        parentRemoteKey: 'map:loop:b'
      },
      {
        remoteKey: 'map:loop:b',
        category: 'exploration',
        title: '循环 B',
        mapNodeKind: 'subregion',
        parentRemoteKey: 'map:loop:a'
      }
    ])).toThrow('上级必须是一级主地区')
  })

  it('一级地图完成状态原子级联到全部二级地区', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('genshin', 'public_schedule', [
      {
        remoteKey: 'map:liyue',
        category: 'exploration',
        title: '璃月',
        mapNodeKind: 'region'
      },
      {
        remoteKey: 'map:liyue:minlin',
        category: 'exploration',
        title: '珉林',
        mapNodeKind: 'subregion',
        parentRemoteKey: 'map:liyue'
      },
      {
        remoteKey: 'map:liyue:chasm',
        category: 'exploration',
        title: '层岩巨渊',
        mapNodeKind: 'subregion',
        parentRemoteKey: 'map:liyue'
      }
    ])
    const region = database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'map:liyue'
    )!

    expect(database.setChecklistCompletion(region.id, true)).toHaveLength(3)
    expect(database.listChecklistItems('genshin').filter(
      (item) => item.remoteKey?.startsWith('map:liyue')
    ).every((item) => item.completed)).toBe(true)

    expect(database.setChecklistCompletion(region.id, false)).toHaveLength(3)
    expect(database.listChecklistItems('genshin').filter(
      (item) => item.remoteKey?.startsWith('map:liyue')
    ).every((item) => !item.completed)).toBe(true)
  })

  it.skip('旧融合流程：公开排期覆盖个人元数据', () => {
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
      progressPercent: null,
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

  it.skip('旧融合流程：个人战绩匹配公开挑战周期', () => {
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
    expect(periods.find((item) => item.periodKey === 'public-period-b')).toMatchObject({
      title: '式舆防卫战·本期',
      completed: true,
      source: 'public_schedule'
    })
  })

  it.skip('旧融合流程：个人挑战按标题归并公开模式', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('wuthering-waves', 'public_schedule', [{
      remoteKey: 'official:whimpering-wastes:2026-07',
      category: 'endgame',
      title: '冥歌海墟',
      startsAt: '2026-07-06T04:00:00+08:00',
      endsAt: '2026-08-03T03:59:00+08:00',
      periodKey: '2026-07',
      modeKey: 'whimpering-wastes'
    }], '2026-07-20T00:00:00.000Z')

    const result = database.mergeSyncedItems('wuthering-waves', 'personal_sync', [{
      remoteKey: 'endgame:legacy-slash',
      category: 'endgame',
      title: '冥歌海墟',
      completed: true,
      periodKey: 'wuthering-waves:legacy-slash:current',
      modeKey: 'legacy-slash'
    }], '2026-07-20T01:00:00.000Z')

    expect(result).toMatchObject({ added: 0, updated: 1 })
    expect(database.listChecklistItems('wuthering-waves')
      .filter((item) => item.title === '冥歌海墟')).toEqual([
      expect.objectContaining({
        source: 'public_schedule',
        completed: true,
        periodKey: '2026-07',
        modeKey: 'whimpering-wastes',
        endsAt: '2026-08-03T03:59:00+08:00'
      })
    ])
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
      agentName: null,
      progressPhase: 'queued',
      progressCurrent: null,
      progressTotal: null,
      message: '同步任务正在排队'
    })
    expect(database.getActiveAiScheduleJob('genshin')?.id).toBe(queued.id)

    database.registerAiScheduleAgent('progress-agent', '进度测试 Agent')
    const claimed = database.claimAiScheduleJob('progress-agent', new Date('2026-07-21T14:47:00.000Z'))
    expect(claimed).toMatchObject({
      id: queued.id,
      progressPhase: 'searching',
      progressCurrent: 0
    })
    const progress = database.updateAiScheduleJobProgress(
      queued.id,
      'progress-agent',
      'verifying',
      '正在核验第 2 个资料来源',
      2,
      4,
      new Date('2026-07-21T14:48:00.000Z')
    )
    expect(progress).toMatchObject({
      progressPhase: 'verifying',
      progressCurrent: 2,
      progressTotal: 4,
      message: '正在核验第 2 个资料来源'
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

  it('按任务精确领取并只使用当前配置重试基础设施故障', () => {
    database = new AppDatabase(':memory:')
    const first = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date('2026-08-01T12:00:00.000Z'),
      true,
      'events'
    )
    const selected = database.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      new Date('2026-08-01T12:00:01.000Z'),
      true,
      'cycles'
    )
    database.registerAiScheduleAgent(
      'route-agent',
      '路由测试 Agent',
      new Date('2026-08-01T12:00:02.000Z')
    )

    const claimed = database.claimAiScheduleJob(
      'route-agent',
      new Date('2026-08-01T12:00:10.000Z'),
      selected.id,
      { model: 'gpt-5.6-terra', reasoningEffort: 'medium' }
    )!
    expect(claimed).toMatchObject({
      id: selected.id,
      routingTier: 0,
      attemptCount: 1,
      assignedModel: 'gpt-5.6-terra',
      assignedReasoningEffort: 'medium'
    })
    expect(database.getActiveAiScheduleJob('genshin', 'events')?.id).toBe(first.id)

    const retried = database.requeueAiScheduleJobAttempt(
      selected.id,
      'route-agent',
      'infrastructure_error',
      '临时连接失败',
      new Date('2026-08-01T12:00:40.000Z')
    )
    expect(retried).toMatchObject({
      status: 'pending',
      routingTier: 0,
      attemptCount: 1,
      lastFailureKind: 'infrastructure_error'
    })

    database.claimAiScheduleJob(
      'route-agent',
      new Date('2026-08-01T12:01:00.000Z'),
      selected.id,
      { model: 'gpt-5.6-terra', reasoningEffort: 'medium' }
    )
    const failed = database.requeueAiScheduleJobAttempt(
      selected.id,
      'route-agent',
      'semantic_unresolved',
      '来源语义冲突，当前配置无法可靠完成',
      new Date('2026-08-01T12:02:00.000Z')
    )
    expect(failed).toMatchObject({
      status: 'failed',
      routingTier: 0,
      attemptCount: 2,
      lastFailureKind: 'semantic_unresolved'
    })
    expect(database.getAiScheduleJobAttemptRuntimeMs(
      selected.id,
      new Date('2026-08-01T12:02:00.000Z')
    )).toBe(90_000)
  })

  it('Codex 在接单前退出只重试一次基础设施故障且不会切换配置', () => {
    database = new AppDatabase(':memory:')
    const job = database.createAiScheduleJob(
      'zenless',
      'public_schedule',
      new Date('2026-08-01T12:00:00.000Z'),
      true,
      'events'
    )
    const failLaunch = (
      startedAt: string,
      completedAt: string,
      failureKind: 'timeout' | 'infrastructure_error'
    ) => database!.recordAiScheduleJobLaunchFailure(
      job.id,
      'preclaim-agent',
      { model: 'gpt-5.6-terra', reasoningEffort: 'medium', startedAt },
      failureKind,
      '模型连接未完成',
      new Date(completedAt)
    )

    expect(failLaunch(
      '2026-08-01T12:00:00.000Z',
      '2026-08-01T12:00:30.000Z',
      'infrastructure_error'
    )).toMatchObject({ status: 'pending', routingTier: 0, attemptCount: 1 })
    expect(failLaunch(
      '2026-08-01T12:01:00.000Z',
      '2026-08-01T12:01:30.000Z',
      'infrastructure_error'
    )).toMatchObject({ status: 'failed', routingTier: 0, attemptCount: 2 })
    expect(database.getAiScheduleJobAttemptRuntimeMs(
      job.id,
      new Date('2026-08-01T12:04:00.000Z')
    )).toBe(60_000)
  })

  it('separately records the last completed Codex catalog audit', () => {
    database = new AppDatabase(':memory:')
    const requestedAt = new Date('2026-07-31T00:00:00.000Z')
    const completedAt = new Date('2026-07-31T00:02:00.000Z')
    const job = database.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      requestedAt,
      true,
      'exploration'
    )
    database.registerAiScheduleAgent('map-audit-agent', '地图增量核验 Agent', requestedAt)
    database.claimAiScheduleJob('map-audit-agent', requestedAt)

    expect(database.getLastCompletedCatalogAuditAt('star-rail', 'exploration')).toBeNull()

    database.applyAiScheduleJob(
      job.id,
      'map-audit-agent',
      [],
      [],
      completedAt,
      [],
      [],
      [],
      'zh-CN'
    )

    expect(database.getLastCompletedCatalogAuditAt('star-rail', 'exploration'))
      .toBe(completedAt.toISOString())
    expect(database.getLastCompletedCatalogAuditAt('genshin', 'exploration')).toBeNull()
  })

  it('同一游戏的不同版块任务可同时排队且不会互相覆盖', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-26T14:00:00.000Z')
    const eventsJob = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      reference,
      true,
      'events'
    )
    const cyclesJob = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date(reference.getTime() + 1_000),
      true,
      'cycles'
    )

    expect(eventsJob.id).not.toBe(cyclesJob.id)
    expect(database.listActiveAiScheduleJobs('genshin').map((job) => job.target))
      .toEqual(['events', 'cycles'])
    expect(database.getActiveAiScheduleJob('genshin', 'events')?.id).toBe(eventsJob.id)
    expect(database.getActiveAiScheduleJob('genshin', 'cycles')?.id).toBe(cyclesJob.id)
    expect(database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date(reference.getTime() + 2_000),
      true,
      'events'
    ).id).toBe(eventsJob.id)
    expect(() => database!.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date(reference.getTime() + 3_000),
      true,
      'all'
    )).toThrow('全局同步')
  })

  it('公开资料提交语言必须与统一接口请求上下文一致', () => {
    database = new AppDatabase(':memory:')
    database.registerAiScheduleAgent('locale-agent', '语言契约 Agent')
    const queued = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date('2026-07-26T12:00:00.000Z'),
      false,
      'events',
      {
        outputLocale: 'en-US',
        userTimeZone: 'America/Los_Angeles'
      }
    )
    database.claimAiScheduleJob('locale-agent', new Date('2026-07-26T12:00:01.000Z'))

    expect(queued).toMatchObject({
      outputLocale: 'en-US',
      userTimeZone: 'America/Los_Angeles',
      requestContext: {
        outputLocale: 'en-US',
        userTimeZone: 'America/Los_Angeles'
      },
      contract: {
        schemaVersion: 11,
        decisionAuthority: 'codex',
        executorPolicy: 'mechanical_validation_only'
      }
    })
    expect(() => database!.applyAiScheduleJob(
      queued.id,
      'locale-agent',
      [],
      [],
      new Date('2026-07-26T12:00:02.000Z'),
      [],
      [],
      [],
      'zh-CN'
    )).toThrow('提交内容语言与接口请求语言不一致')
  })

  it('Codex 长时间未接单时保持排队，等待可用 Worker 或用户取消', () => {
    database = new AppDatabase(':memory:')
    const queuedAt = new Date('2026-07-24T10:00:00.000Z')
    const queued = database.createAiScheduleJob(
      'wuthering-waves',
      'public_schedule',
      queuedAt,
      true,
      'tasks',
      'Asia/Shanghai'
    )

    expect(database.expireUnclaimedAiScheduleJobs(
      new Date('2026-07-24T10:04:59.999Z')
    )).toBe(0)
    expect(database.getActiveAiScheduleJob('wuthering-waves')?.id).toBe(queued.id)

    expect(database.expireUnclaimedAiScheduleJobs(
      new Date('2026-07-24T11:05:00.001Z')
    )).toBe(0)
    expect(database.getActiveAiScheduleJob('wuthering-waves')).toMatchObject({
      id: queued.id,
      status: 'pending'
    })
  })

  it('Codex 接单后十五分钟无进度时重新排队且不会因等待继续失败', () => {
    database = new AppDatabase(':memory:')
    const startedAt = new Date('2026-07-24T10:00:00.000Z')
    database.registerAiScheduleAgent('stale-agent', '掉线 Agent', startedAt)
    const queued = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      startedAt,
      false,
      'events'
    )
    database.claimAiScheduleJob('stale-agent', startedAt)

    expect(database.maintainAiScheduleJobs(
      new Date('2026-07-24T10:15:00.001Z')
    )).toEqual({ requeued: 1, expired: 0 })
    expect(database.getActiveAiScheduleJob('genshin')).toMatchObject({
      id: queued.id,
      status: 'pending',
      progressPhase: 'queued',
      message: '处理超时，任务已重新排队'
    })

    expect(database.maintainAiScheduleJobs(
      new Date('2026-07-24T10:20:00.002Z')
    )).toEqual({ requeued: 0, expired: 0 })
    expect(database.getActiveAiScheduleJob('genshin')).toMatchObject({
      id: queued.id,
      status: 'pending'
    })
  })

  it('Codex 自动启动和连接重试会刷新等待进度及超时计时', () => {
    database = new AppDatabase(':memory:')
    const startedAt = new Date('2026-07-24T10:00:00.000Z')
    database.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      startedAt,
      true,
      'tasks'
    )
    database.updatePendingAiScheduleJobsMessage(
      'Codex 正在连接模型，重试 2/5',
      2,
      5,
      new Date('2026-07-24T10:04:00.000Z')
    )

    expect(database.getActiveAiScheduleJob('star-rail')).toMatchObject({
      status: 'pending',
      progressPhase: 'queued',
      progressCurrent: 2,
      progressTotal: 5,
      message: 'Codex 正在连接模型，重试 2/5'
    })
    expect(database.maintainAiScheduleJobs(
      new Date('2026-07-24T10:08:00.000Z')
    )).toEqual({ requeued: 0, expired: 0 })
  })

  it('应用关闭时只把后台 Codex 领取的任务立即放回队列', () => {
    database = new AppDatabase(':memory:')
    const startedAt = new Date('2026-07-24T10:00:00.000Z')
    database.registerAiScheduleAgent('gacha-app-background-worker', '后台 Codex', startedAt)
    database.createAiScheduleJob('zenless', 'public_schedule', startedAt, false, 'events')
    database.claimAiScheduleJob('gacha-app-background-worker', startedAt)

    expect(database.requeueClaimedAiScheduleJobsByAgent(
      'another-agent',
      new Date('2026-07-24T10:01:00.000Z')
    )).toBe(0)
    expect(database.requeueClaimedAiScheduleJobsByAgent(
      'gacha-app-background-worker',
      new Date('2026-07-24T10:01:00.000Z')
    )).toBe(1)
    expect(database.getActiveAiScheduleJob('zenless')).toMatchObject({
      status: 'pending',
      message: '应用已关闭，任务将在下次启动后继续'
    })
  })

  it('四个唯一 Agent 可以并行领取四个游戏的独立任务', () => {
    database = new AppDatabase(':memory:')
    const startedAt = new Date('2026-07-24T10:00:00.000Z')
    const gameIds = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const
    for (const [index, gameId] of gameIds.entries()) {
      const agentId = `gacha-app-background-worker-${index + 1}`
      database.registerAiScheduleAgent(agentId, `后台 Codex ${index + 1}`, startedAt)
      database.createAiScheduleJob(gameId, 'public_schedule', startedAt, false, 'all')
    }

    const claimed = gameIds.map((_gameId, index) =>
      database!.claimAiScheduleJob(
        `gacha-app-background-worker-${index + 1}`,
        new Date(startedAt.getTime() + index)
      )
    )

    expect(claimed.map((job) => job?.gameId)).toEqual(gameIds)
    expect(new Set(claimed.map((job) => job?.agentId)).size).toBe(4)
    for (const gameId of gameIds) {
      expect(database.getActiveAiScheduleJob(gameId)?.status).toBe('claimed')
    }
  })

  it('持续上报进度的 Codex 任务不会按最初接单时间误判超时', () => {
    database = new AppDatabase(':memory:')
    const queuedAt = new Date('2026-07-23T10:00:00.000Z')
    database.registerAiScheduleAgent('long-running-agent', '长任务 Agent', queuedAt)
    const queued = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      queuedAt,
      false,
      'events'
    )
    database.claimAiScheduleJob('long-running-agent', queuedAt)
    database.updateAiScheduleJobProgress(
      queued.id,
      'long-running-agent',
      'verifying',
      '仍在交叉核验来源',
      4,
      5,
      new Date('2026-07-23T10:14:00.000Z')
    )

    expect(database.claimAiScheduleJob(
      'long-running-agent',
      new Date('2026-07-23T10:16:00.000Z')
    )).toBeNull()
    expect(database.getActiveAiScheduleJob('genshin')).toMatchObject({
      id: queued.id,
      status: 'claimed',
      progressPhase: 'verifying',
      progressCurrent: 4
    })

    expect(database.claimAiScheduleJob(
      'long-running-agent',
      new Date('2026-07-23T10:31:00.000Z')
    )).toMatchObject({
      id: queued.id,
      status: 'claimed',
      progressPhase: 'searching',
      progressCurrent: 0
    })
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
        title: '公开活动',
        activityTags: ['战斗', '挑战', '剧情'],
        startsAt: '2026-07-20T10:00:00+08:00',
        endsAt: '2026-08-01T03:59:00+08:00'
      }],
      []
    )

    expect(database.getSyncSettings('zenless')).toMatchObject({
      status: 'verification_required',
      message: expect.stringContaining('米游社需要完成滑块或设备验证')
    })
    expect(database.getSyncSettings('zenless').lastSuccessAt).not.toBeNull()
  })

  it('后续全局同步也会保存已核验版块并继续追查缺失版块', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-25T12:00:00.000Z')
    database.registerAiScheduleAgent('agent-partial-all', '部分同步 Agent', reference)
    const queued = database.createAiScheduleJob(
      'wuthering-waves',
      'public_schedule',
      reference,
      false,
      'all'
    )
    database.claimAiScheduleJob('agent-partial-all', reference)

    const result = database.applyAiScheduleJob(
      queued.id,
      'agent-partial-all',
      [
        {
          remoteKey: 'version:wuthering-waves:main',
          category: 'main_quest',
          title: '主线任务',
          startsAt: '2026-07-02T10:00:00+08:00',
          endsAt: '2026-08-13T05:59:59+08:00',
          periodKey: 'wuthering-waves:version:3.5',
          scheduleKind: 'fixed_window',
          timeZone: 'Asia/Shanghai'
        },
        {
          remoteKey: 'version:wuthering-waves:side',
          category: 'side_quest',
          title: '支线任务',
          startsAt: '2026-07-02T10:00:00+08:00',
          endsAt: '2026-08-13T05:59:59+08:00',
          periodKey: 'wuthering-waves:version:3.5',
          scheduleKind: 'fixed_window',
          timeZone: 'Asia/Shanghai'
        },
        {
          remoteKey: 'wuthering-waves:event:test',
          category: 'limited_event',
          title: '已核验限时活动',
          activityTags: ['战斗', '挑战', '剧情'],
          startsAt: '2026-07-20T10:00:00+08:00',
          endsAt: '2026-08-01T03:59:59+08:00'
        }
      ],
      [],
      reference
    )

    expect(result.job).toMatchObject({
      status: 'claimed',
      progressPhase: 'retrying',
      message: expect.stringContaining('继续检索周期事项、地图探索')
    })
    expect(result.remainingTargets).toEqual(['cycles', 'exploration'])
    expect(database.getSyncSettings('wuthering-waves')).toMatchObject({
      status: 'stale',
      lastSuccessAt: null,
      message: expect.stringContaining('继续检索周期事项、地图探索')
    })
    expect(database.getSyncTargetStates('wuthering-waves')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ gameId: 'wuthering-waves', target: 'all', lastSuccessAt: null, status: 'stale' }),
        expect.objectContaining({ gameId: 'wuthering-waves', target: 'tasks', lastSuccessAt: reference.toISOString() }),
        expect.objectContaining({ gameId: 'wuthering-waves', target: 'events', lastSuccessAt: reference.toISOString() }),
        expect.objectContaining({ gameId: 'wuthering-waves', target: 'cycles', lastSuccessAt: null }),
        expect.objectContaining({ gameId: 'wuthering-waves', target: 'exploration', lastSuccessAt: null })
      ])
    )
  })

  it('首次全局同步保存已核验版块但必须继续补齐全部版块后才能结束', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-25T12:00:00.000Z')
    database.registerAiScheduleAgent('agent-initial-all', '首次同步 Agent', reference)
    const queued = database.createAiScheduleJob(
      'wuthering-waves',
      'public_schedule',
      reference,
      false,
      'all'
    )
    database.claimAiScheduleJob('agent-initial-all', reference)

    const partial = database.applyAiScheduleJob(
      queued.id,
      'agent-initial-all',
      [
        {
          remoteKey: 'version:wuthering-waves:main',
          category: 'main_quest',
          title: '主线任务',
          startsAt: '2026-07-02T10:00:00+08:00',
          endsAt: '2026-08-13T05:59:59+08:00',
          periodKey: 'wuthering-waves:version:3.5',
          scheduleKind: 'fixed_window',
          timeZone: 'Asia/Shanghai'
        },
        {
          remoteKey: 'version:wuthering-waves:side',
          category: 'side_quest',
          title: '支线任务',
          startsAt: '2026-07-02T10:00:00+08:00',
          endsAt: '2026-08-13T05:59:59+08:00',
          periodKey: 'wuthering-waves:version:3.5',
          scheduleKind: 'fixed_window',
          timeZone: 'Asia/Shanghai'
        },
        {
          remoteKey: 'wuthering-waves:event:test',
          category: 'limited_event',
          title: '首次同步活动',
          activityTags: ['战斗', '挑战', '剧情'],
          startsAt: '2026-07-20T10:00:00+08:00',
          endsAt: '2026-08-01T03:59:59+08:00'
        }
      ],
      [],
      reference
    )

    expect(partial.job).toMatchObject({
      status: 'claimed',
      progressPhase: 'retrying',
      message: expect.stringContaining('继续检索周期事项、地图探索')
    })
    expect(partial.remainingTargets).toEqual(['cycles', 'exploration'])
    expect(database.listChecklistItems('wuthering-waves').map((item) => item.title))
      .toContain('首次同步活动')

    const completed = database.applyAiScheduleJob(
      queued.id,
      'agent-initial-all',
      [
        {
          remoteKey: 'wuthering-waves:tower:2026-07',
          category: 'endgame',
          title: '逆境深塔',
          modeKey: 'tower-of-adversity',
          periodKey: '2026-07',
          startsAt: '2026-07-20T04:00:00+08:00',
          endsAt: '2026-08-03T03:59:59+08:00'
        },
        {
          remoteKey: 'wuthering-waves:wastes:2026-07',
          category: 'endgame',
          title: '冥歌海墟',
          modeKey: 'whimpering-wastes',
          periodKey: '2026-07',
          startsAt: '2026-07-20T04:00:00+08:00',
          endsAt: '2026-08-03T03:59:59+08:00'
        },
        {
          remoteKey: 'wuthering-waves:matrix:2026-07',
          category: 'endgame',
          title: '终焉矩阵',
          modeKey: 'endstate-matrix',
          periodKey: '2026-07',
          startsAt: '2026-07-20T04:00:00+08:00',
          endsAt: '2026-08-03T03:59:59+08:00'
        },
        {
          remoteKey: 'wuthering-waves:map:rinascita',
          category: 'exploration',
          title: '黎那汐塔',
          modeKey: 'rinascita',
          mapNodeKind: 'region'
        }
      ],
      [],
      new Date('2026-07-25T12:02:00.000Z')
    )

    expect(completed.job).toMatchObject({ status: 'completed' })
    expect(completed.remainingTargets).toEqual([])
    expect(database.getSyncTargetStates('wuthering-waves')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'all', status: 'success' }),
        expect.objectContaining({ target: 'tasks', status: 'success' }),
        expect.objectContaining({ target: 'events', status: 'success' }),
        expect.objectContaining({ target: 'cycles', status: 'success' }),
        expect.objectContaining({ target: 'exploration', status: 'success' })
      ])
    )
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

  it('AI 活动回写必须提供带时区的完整起止时间', () => {
    database = new AppDatabase(':memory:')
    database.registerAiScheduleAgent('agent-event-time', '活动时间测试 Agent')
    const queued = database.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      new Date('2026-07-23T12:00:00.000Z'),
      false,
      'events'
    )
    database.claimAiScheduleJob('agent-event-time', new Date('2026-07-23T12:01:00.000Z'))

    expect(() => database!.applyAiScheduleJob(
      queued.id,
      'agent-event-time',
      [{
        remoteKey: 'event:missing-timezone',
        category: 'limited_event',
        title: '时间不完整活动',
        startsAt: '2026-07-24T10:00:00',
        endsAt: '2026-08-03T03:59:00+08:00'
      }],
      []
    )).toThrow('缺少带时区的完整起止时间')
  })

  it('活动版块允许 Codex 用证据明确确认当前没有限时活动', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-23T12:00:00.000Z')
    database.registerAiScheduleAgent('agent-empty-events', '空活动核验 Agent', reference)
    const queued = database.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      reference,
      false,
      'events'
    )
    database.claimAiScheduleJob('agent-empty-events', reference)

    const result = database.applyAiScheduleJob(
      queued.id,
      'agent-empty-events',
      [],
      [{ url: 'https://sr.mihoyo.com/', note: '官方活动目录当前无有效限时活动' }],
      reference,
      [],
      ['events']
    )

    expect(result.job).toMatchObject({ status: 'completed' })
    expect(result.remainingTargets).toEqual([])
    expect(database.getSyncTargetStates('star-rail')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target: 'events', status: 'success' })
      ])
    )
  })

  it('公开资料严格执行 Codex 指定的匹配 ID，不再自行按标题或时间合并', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'star-rail:event:existing',
      category: 'limited_event',
      title: '旧日活动名称',
      activityTags: ['战斗', '剧情', '任务'],
      startsAt: '2026-07-20T00:00:00.000Z',
      endsAt: '2026-08-20T00:00:00.000Z'
    }])
    const existing = database.listChecklistItems('star-rail')
      .find((item) => item.remoteKey === 'star-rail:event:existing')!
    database.registerAiScheduleAgent('agent-strict-match', 'Codex 严格匹配 Agent')
    const queued = database.createAiScheduleJob('star-rail', 'public_schedule', new Date(), false, 'events')
    database.claimAiScheduleJob('agent-strict-match')

    const result = database.applyAiScheduleJob(
      queued.id,
      'agent-strict-match',
      [
        {
          matchItemId: existing.id,
          remoteKey: 'ignored:new-source-key',
          category: 'limited_event',
          title: 'Codex 核验后的正式名称',
          activityTags: ['剧情', '战斗', '任务'],
          startsAt: '2026-07-21T00:00:00.000Z',
          endsAt: '2026-08-21T00:00:00.000Z'
        },
        {
          remoteKey: 'star-rail:event:genuinely-new',
          category: 'limited_event',
          title: 'Codex 核验的新活动',
          activityTags: ['解谜', '挑战', '收集'],
          startsAt: '2026-07-21T00:00:00.000Z',
          endsAt: '2026-08-21T00:00:00.000Z'
        }
      ],
      []
    )

    expect(result.merge).toMatchObject({ added: 1, updated: 1 })
    expect(database.listChecklistItems('star-rail')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: existing.id,
        remoteKey: 'star-rail:event:existing',
        title: 'Codex 核验后的正式名称'
      }),
      expect.objectContaining({
        remoteKey: 'star-rail:event:genuinely-new',
        title: 'Codex 核验的新活动'
      })
    ]))
  })

  it('四款游戏均允许 Codex 硬删除错误同步项且回收站只保留手动项', () => {
    database = new AppDatabase(':memory:')
    database.registerAiScheduleAgent('agent-codex-cleanup', 'Codex 清单纠错 Agent')

    for (const gameId of ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const) {
      database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `${gameId}:event:duplicate`,
        category: 'limited_event',
        title: `${gameId} 重复活动`,
        activityTags: ['战斗', '挑战', '剧情'],
        startsAt: '2026-07-20T00:00:00.000Z',
        endsAt: '2026-08-20T00:00:00.000Z'
      }])
      const duplicate = database.listChecklistItems(gameId)
        .find((item) => item.remoteKey === `${gameId}:event:duplicate`)!
      const manual = database.createChecklistItem({
        gameId,
        category: 'limited_event',
        title: `${gameId} 手动活动`,
        activityTags: ['剧情']
      })
      const queued = database.createAiScheduleJob(gameId, 'public_schedule', new Date(), false, 'events')
      database.claimAiScheduleJob('agent-codex-cleanup')

      expect(() => database!.applyAiScheduleJob(
        queued.id,
        'agent-codex-cleanup',
        [],
        [],
        new Date(),
        [],
        [],
        [{ itemId: manual.id, reason: '不应允许同步流程删除手动项' }]
      )).toThrow('Codex 只能删除当前同步版块内提供的同步事项')

      const result = database.applyAiScheduleJob(
        queued.id,
        'agent-codex-cleanup',
        [],
        [],
        new Date(),
        [],
        [],
        [{ itemId: duplicate.id, reason: '与已核验的同一活动重复' }]
      )
      expect(result.archived).toBe(1)
      expect(database.listChecklistItems(gameId).some((item) => item.id === duplicate.id)).toBe(false)
      expect(database.listArchivedChecklistItems(gameId).some((item) => item.id === duplicate.id)).toBe(false)
      expect(database.listChecklistItems(gameId).some((item) => item.id === manual.id)).toBe(true)
    }
  })

  it('归档地图父级时必须在同一提交中重新挂接仍启用的子地图', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('zenless', 'public_schedule', [
      {
        remoteKey: 'map:new-eridu',
        category: 'exploration',
        title: '新艾利都',
        mapNodeKind: 'region'
      },
      {
        remoteKey: 'map:new-eridu:waifei-peninsula',
        category: 'exploration',
        title: '卫非地',
        mapNodeKind: 'subregion',
        parentRemoteKey: 'map:new-eridu'
      }
    ])
    const parent = database.listChecklistItems('zenless')
      .find((item) => item.remoteKey === 'map:new-eridu')!
    const child = database.listChecklistItems('zenless')
      .find((item) => item.remoteKey === 'map:new-eridu:waifei-peninsula')!
    database.registerAiScheduleAgent('agent-map-reference', '地图引用测试 Agent')
    const queued = database.createAiScheduleJob(
      'zenless',
      'public_schedule',
      new Date(),
      false,
      'exploration'
    )
    database.claimAiScheduleJob('agent-map-reference')

    expect(() => database!.applyAiScheduleJob(
      queued.id,
      'agent-map-reference',
      [],
      [],
      new Date(),
      [],
      [],
      [{ itemId: parent.id, reason: '移除过时包装层' }]
    )).toThrow('父级已归档或不存在')
    expect(database.listChecklistItems('zenless').some((item) => item.id === parent.id)).toBe(true)

    const result = database.applyAiScheduleJob(
      queued.id,
      'agent-map-reference',
      [],
      [],
      new Date(),
      [],
      [],
      [
        { itemId: child.id, reason: '与父地区一起移除过时二级地区' },
        { itemId: parent.id, reason: '移除过时一级地区' }
      ]
    )

    expect(result.archived).toBe(2)
    expect(database.listChecklistItems('zenless').some((item) => item.id === child.id)).toBe(false)
  })

  it('原神周期同步接受 Codex 判定的清单并自动补齐周常', () => {
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

    database.applyAiScheduleJob(
      queued.id,
      'agent-genshin-cycles',
      [{
        remoteKey: 'genshin:stygian-onslaught:2026-07',
        category: 'endgame',
        title: '幽境危战',
        modeKey: 'stygian-onslaught',
        periodKey: '2026-07',
        startsAt: '2026-07-20T04:00:00+08:00',
        endsAt: '2026-08-03T03:59:59+08:00'
      }],
      []
    )

    const cycles = database.listChecklistItems('genshin')
      .filter((item) => item.category === 'weekly' || item.category === 'endgame')
    expect(cycles.map((item) => item.modeKey).filter(Boolean).sort()).toEqual([
      'stygian-onslaught'
    ])
    expect(cycles.find((item) => item.id === 'genshin:weekly')).toMatchObject({
      title: '周常',
      category: 'weekly'
    })
  })

  it('四款游戏的周期同步都不使用硬编码玩法目录否决 Codex', () => {
    database = new AppDatabase(':memory:')
    database.registerAiScheduleAgent('agent-cycle-completeness', '周期完整性测试 Agent')
    const gameIds = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const

    for (const gameId of gameIds) {
      const queued = database.createAiScheduleJob(gameId, 'public_schedule', new Date(), false, 'cycles')
      database.claimAiScheduleJob('agent-cycle-completeness')
      database.applyAiScheduleJob(
        queued.id,
        'agent-cycle-completeness',
        [{
          remoteKey: `${gameId}:codex-cycle:test`,
          category: 'endgame',
          title: `${gameId} Codex 核验挑战`,
          modeKey: 'codex-verified-mode',
          periodKey: 'test-period',
          startsAt: '2026-07-20T04:00:00+08:00',
          endsAt: '2026-08-03T03:59:59+08:00'
        }],
        []
      )
      expect(database.listChecklistItems(gameId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          title: `${gameId} Codex 核验挑战`,
          modeKey: 'codex-verified-mode'
        }),
        expect.objectContaining({ id: `${gameId}:weekly`, category: 'weekly' })
      ]))
    }
  })

  it.skip('旧融合流程：个人地图只补充公开目录探索度', () => {
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

  it.skip('旧融合流程：个人战绩按模式键补全公开排期', () => {
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
      progressPercent: null,
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

  it('四款游戏会机械淘汰已到期的个人活动和周期并阻止同一身份复活', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-08-01T12:00:00.000Z')
    const accountScope = `official:${'a'.repeat(64)}`
    for (const gameId of ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const) {
      for (const target of ['events', 'cycles'] as const) {
        const category = target === 'events' ? 'limited_event' as const : 'endgame' as const
        const identity = {
          provider: gameId === 'wuthering-waves' ? 'kuro-community' : 'miyoushe',
          endpoint: `test-${target}`,
          externalId: `${gameId}-${target}-expired`
        }
        const expired = {
          remoteKey: `personal:${gameId}:${target}:expired`,
          category,
          title: `${gameId} 已到期${target}`,
          startsAt: '2026-07-01T00:00:00.000Z',
          endsAt: '2026-07-31T23:59:59.000Z',
          sourceIdentity: identity
        }
        const first = database.replacePersonalSnapshot(
          gameId,
          target,
          accountScope,
          [expired],
          'test-v1',
          reference
        )
        expect(first.expiredRemoved).toBe(0)
        expect(database.listChecklistItems(gameId).some((item) => item.title === expired.title))
          .toBe(false)

        database.replacePersonalSnapshot(
          gameId,
          target,
          accountScope,
          [{ ...expired, startsAt: null, endsAt: null }],
          'test-v1',
          reference
        )
        expect(database.listChecklistItems(gameId).some((item) => item.title === expired.title))
          .toBe(false)

        database.replacePersonalSnapshot(
          gameId,
          target,
          accountScope,
          [{
            ...expired,
            title: `${gameId} 官方延期${target}`,
            endsAt: '2026-08-20T00:00:00.000Z'
          }],
          'test-v1',
          reference
        )
        expect(database.listChecklistItems(gameId)).toEqual(expect.arrayContaining([
          expect.objectContaining({ title: `${gameId} 官方延期${target}`, source: 'personal_sync' })
        ]))
      }
    }
  })

  it('个人活动先建表再由 Codex 补全标签和时间，并在下次快照复用缓存', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-08-01T12:00:00.000Z')
    const accountScope = `miyoushe:${'b'.repeat(64)}`
    const event = {
      remoteKey: 'personal-event:miyoushe:event-api:metadata-1',
      category: 'limited_event' as const,
      title: '待补全活动',
      sourceIdentity: {
        provider: 'miyoushe',
        endpoint: 'event-api',
        externalId: 'metadata-1'
      }
    }
    database.replacePersonalSnapshot('genshin', 'events', accountScope, [event], 'test-v1', reference)
    database.registerAiScheduleAgent('metadata-agent', '元数据 Agent', reference)
    const queued = database.createPersonalMetadataJob(
      'genshin',
      'events',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      reference
    )!
    expect(queued).toMatchObject({ jobKind: 'personal_metadata', target: 'events' })
    expect(queued.metadataTargets).toEqual([
      expect.objectContaining({
        title: '待补全活动',
        missingFields: ['activityTags', 'startsAt', 'endsAt']
      })
    ])
    const claimed = database.claimAiScheduleJob('metadata-agent', reference)!
    const target = claimed.metadataTargets[0]
    database.applyPersonalMetadataJob(
      claimed.id,
      'metadata-agent',
      [{
        itemId: target.itemId,
        title: target.title,
        activityTags: ['战斗', '解谜', '挑战'],
        activityTagEvidence: [
          { tagId: 'combat', sourceUrl: 'https://example.com/cn/event-metadata', note: '规则包含战斗关卡。' },
          { tagId: 'puzzle', sourceUrl: 'https://example.com/cn/event-metadata', note: '规则包含机关解谜。' },
          { tagId: 'challenge', sourceUrl: 'https://example.com/cn/event-metadata', note: '规则包含限时挑战目标。' }
        ],
        startsAt: '2026-08-01T10:00:00+08:00',
        endsAt: '2026-08-20T03:59:00+08:00',
        sourceUrl: 'https://example.com/cn/event-metadata',
        confidence: 0.98
      }],
      { evidence: ['test'] },
      'zh-CN',
      reference
    )
    expect(database.listChecklistItems('genshin').find((item) => item.title === '待补全活动'))
      .toMatchObject({
        activityTags: ['战斗', '解谜', '挑战'],
        startsAt: '2026-08-01T10:00:00+08:00',
        endsAt: '2026-08-20T03:59:00+08:00',
        completed: false,
        source: 'personal_sync'
      })

    database.replacePersonalSnapshot(
      'genshin',
      'events',
      accountScope,
      [event],
      'test-v1',
      new Date('2026-08-02T12:00:00.000Z')
    )
    expect(database.listChecklistItems('genshin').find((item) => item.title === '待补全活动'))
      .toMatchObject({
        activityTags: ['战斗', '解谜', '挑战'],
        startsAt: '2026-08-01T10:00:00+08:00',
        endsAt: '2026-08-20T03:59:00+08:00'
      })
  })

  it('个人活动的泛化占位标签不能绕过元数据补全', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-08-01T12:00:00.000Z')
    const accountScope = `miyoushe:${'f'.repeat(64)}`
    database.replacePersonalSnapshot('star-rail', 'events', accountScope, [{
      remoteKey: 'personal-event:miyoushe:event-api:generic-tag',
      category: 'limited_event',
      title: '泛化标签活动',
      activityTags: ['活动玩法'],
      startsAt: '2026-08-01T00:00:00.000Z',
      endsAt: '2026-08-20T00:00:00.000Z',
      sourceIdentity: {
        provider: 'miyoushe',
        endpoint: 'event-api',
        externalId: 'generic-tag'
      }
    }], 'test-v1', reference)
    database.registerAiScheduleAgent('generic-tag-agent', '泛化标签补全 Agent', reference)

    const job = database.createPersonalMetadataJob(
      'star-rail',
      'events',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      reference
    )!

    expect(job.metadataTargets).toEqual([
      expect.objectContaining({
        title: '泛化标签活动',
        currentTags: [],
        missingFields: ['activityTags']
      })
    ])
  })

  it('个人活动标签缺乏可靠依据时可保持空白且不阻塞元数据任务', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-08-01T12:00:00.000Z')
    database.replacePersonalSnapshot('genshin', 'events', `miyoushe:${'e'.repeat(64)}`, [{
      remoteKey: 'personal-event:miyoushe:event-api:uncertain-tags',
      category: 'limited_event',
      title: '玩法尚未公开的活动',
      startsAt: '2026-08-01T00:00:00.000Z',
      endsAt: '2026-08-20T00:00:00.000Z',
      sourceIdentity: {
        provider: 'miyoushe',
        endpoint: 'event-api',
        externalId: 'uncertain-tags'
      }
    }], 'test-v1', reference)
    database.registerAiScheduleAgent('uncertain-tag-agent', '标签核验 Agent', reference)
    const queued = database.createPersonalMetadataJob(
      'genshin',
      'events',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      reference
    )!
    const claimed = database.claimAiScheduleJob('uncertain-tag-agent', reference)!
    const target = claimed.metadataTargets[0]!

    const result = database.applyPersonalMetadataJob(
      queued.id,
      'uncertain-tag-agent',
      [{
        itemId: target.itemId,
        title: target.title,
        unresolvedFields: ['activityTags'],
        unresolvedReason: '官方仅公布活动名称与时间，尚未公开实际玩法',
        sourceUrl: 'https://example.com/cn/event-preview',
        confidence: 0.8
      }],
      { evidence: ['官方预告'] },
      'zh-CN',
      reference
    )

    expect(result.job.status).toBe('completed')
    expect(database.listChecklistItems('genshin').find(
      (item) => item.title === '玩法尚未公开的活动'
    )?.activityTags).toEqual([])
  })

  it('到期个人事项直接硬删除且不能进入手动回收站', () => {
    database = new AppDatabase(':memory:')
    const accountScope = `miyoushe:${'d'.repeat(64)}`
    const identity = { provider: 'miyoushe', endpoint: 'event-api', externalId: 'archive-expired' }
    database.replacePersonalSnapshot('genshin', 'events', accountScope, [{
      remoteKey: 'personal-event:archive-expired',
      category: 'limited_event',
      title: '即将到期活动',
      endsAt: '2026-08-10T00:00:00.000Z',
      sourceIdentity: identity
    }], 'test-v1', new Date('2026-08-01T00:00:00.000Z'))
    const item = database.listChecklistItems('genshin').find(
      (candidate) => candidate.title === '即将到期活动'
    )!
    expect(() => database!.archiveChecklistItem(item.id)).toThrow('系统清单由同步维护，不能删除')
    expect(database.listArchivedChecklistItems('genshin')).toHaveLength(0)

    const result = database.replacePersonalSnapshot('genshin', 'events', accountScope, [{
      remoteKey: 'personal-event:archive-expired',
      category: 'limited_event',
      title: '即将到期活动',
      endsAt: '2026-08-10T00:00:00.000Z',
      sourceIdentity: identity
    }], 'test-v1', new Date('2026-08-11T00:00:00.000Z'))
    expect(result.expiredRemoved).toBe(1)
    expect(database.listArchivedChecklistItems('genshin')).toEqual([])
    expect(() => database!.restoreChecklistItem(item.id)).toThrow('不存在')
  })

  it('软件运行期间硬删除到期系统事项、保留手动事项并阻止旧个人快照再生', () => {
    database = new AppDatabase(':memory:')
    const accountScope = `miyoushe:${'9'.repeat(64)}`
    const sourceIdentity = {
      provider: 'miyoushe',
      endpoint: 'event-api',
      externalId: 'runtime-expiry-event'
    }
    database.replacePersonalSnapshot('genshin', 'events', accountScope, [{
      remoteKey: 'personal-event:runtime-expiry',
      category: 'limited_event',
      title: '个人到期活动',
      startsAt: '2030-08-01T00:00:00.000Z',
      endsAt: '2030-08-10T00:00:00.000Z',
      sourceIdentity
    }], 'test-v1', new Date('2030-08-05T00:00:00.000Z'))
    database.replacePublicCatalog('star-rail', 'events', [{
      remoteKey: 'public-event:runtime-expiry',
      category: 'limited_event',
      title: '公开到期活动',
      activityTags: ['签到'],
      startsAt: '2030-08-01T00:00:00.000Z',
      endsAt: '2030-08-10T00:00:00.000Z'
    }], '2030-08-05T00:00:00.000Z')
    const manual = database.createChecklistItem({
      gameId: 'genshin',
      category: 'limited_event',
      title: '手动保留活动',
      startsAt: '2030-08-01T00:00:00.000Z',
      endsAt: '2030-08-10T00:00:00.000Z'
    })

    expect(database.pruneExpiredSystemItems(new Date('2030-08-10T00:00:01.000Z'))).toBe(2)
    expect(database.listChecklistItems('genshin').map((item) => item.title)).not.toContain('个人到期活动')
    expect(database.listChecklistItems('star-rail').map((item) => item.title)).not.toContain('公开到期活动')
    expect(database.listChecklistItems('genshin').find((item) => item.id === manual.id)).toBeDefined()
    expect(database.listArchivedChecklistItems('genshin')).toEqual([])

    const stale = database.replacePersonalSnapshot('genshin', 'events', accountScope, [{
      remoteKey: 'personal-event:runtime-expiry',
      category: 'limited_event',
      title: '个人到期活动',
      startsAt: '2030-08-01T00:00:00.000Z',
      endsAt: '2030-08-10T00:00:00.000Z',
      sourceIdentity
    }], 'test-v1', new Date('2030-08-10T00:00:02.000Z'))
    expect(stale.added).toBe(0)
    expect(database.listChecklistItems('genshin').map((item) => item.title)).not.toContain('个人到期活动')

    database.replacePersonalSnapshot('genshin', 'events', accountScope, [{
      remoteKey: 'personal-event:runtime-expiry',
      category: 'limited_event',
      title: '个人延期活动',
      startsAt: '2030-08-01T00:00:00.000Z',
      endsAt: '2030-09-10T00:00:00.000Z',
      sourceIdentity
    }], 'test-v1', new Date('2030-08-10T00:00:03.000Z'))
    expect(database.listChecklistItems('genshin')).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '个人延期活动', source: 'personal_sync' })
    ]))
  })

  it('个人周期缺失时间也进入相同元数据补全任务', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-08-01T12:00:00.000Z')
    database.replacePersonalSnapshot(
      'star-rail',
      'cycles',
      `miyoushe:${'c'.repeat(64)}`,
      [{
        remoteKey: 'personal-cycle:star-rail:memory:42',
        category: 'endgame',
        title: '混沌回忆·第42期',
        completed: true,
        periodKey: '42',
        modeKey: 'memory-of-chaos',
        sourceIdentity: {
          provider: 'miyoushe',
          endpoint: 'personal-challenge-record',
          externalId: 'memory-of-chaos|period:42'
        }
      }],
      'test-v1',
      reference
    )
    database.registerAiScheduleAgent('cycle-metadata-agent', '周期元数据 Agent', reference)
    const job = database.createPersonalMetadataJob(
      'star-rail',
      'cycles',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      reference
    )!
    expect(job.metadataTargets).toEqual([
      expect.objectContaining({
        title: '混沌回忆·第42期',
        missingFields: ['startsAt', 'endsAt'],
        timeWindowPolicy: 'full_cycle'
      })
    ])
    const claimed = database.claimAiScheduleJob('cycle-metadata-agent', reference)!
    const target = claimed.metadataTargets[0]
    expect(() => database!.applyPersonalMetadataJob(
      claimed.id,
      'cycle-metadata-agent',
      [{
        itemId: target.itemId,
        title: target.title,
        unresolvedFields: ['startsAt', 'endsAt'],
        unresolvedReason: '尚未找到时间',
        sourceUrl: 'https://example.com/cycle',
        confidence: 0.5
      }],
      { evidence: ['test'] },
      'zh-CN',
      reference
    )).toThrow('必须补齐当前期完整时间')
  })

  it('本地周期占位不是官方身份墓碑，下一期允许用相同等待身份重新建立', () => {
    database = new AppDatabase(':memory:')
    const accountScope = `official:${'f'.repeat(64)}`
    const placeholder = {
      remoteKey: 'endgame:endstate-matrix',
      category: 'endgame' as const,
      title: '终焉矩阵',
      completed: false,
      modeKey: 'endstate-matrix',
      periodKey: 'predicted:wuthering-waves:endstate-matrix:awaiting-official-window',
      startsAt: '2026-07-10T04:00:00+08:00',
      endsAt: '2026-08-01T04:00:00+08:00',
      sourceIdentity: {
        provider: 'gtask-cycle-catalog',
        endpoint: 'predicted-cycle-window',
        externalId: 'endstate-matrix|awaiting-official-window'
      }
    }
    const afterExpiry = new Date('2026-08-02T00:00:00.000Z')

    database.replacePersonalSnapshot(
      'wuthering-waves', 'cycles', accountScope, [placeholder], 'test-v1', afterExpiry
    )
    expect(database.listChecklistItems('wuthering-waves').some(
      (item) => item.title === '终焉矩阵'
    )).toBe(false)

    database.replacePersonalSnapshot(
      'wuthering-waves',
      'cycles',
      accountScope,
      [{ ...placeholder, startsAt: null, endsAt: null }],
      'test-v1',
      afterExpiry
    )
    expect(database.listChecklistItems('wuthering-waves')).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '终焉矩阵', source: 'personal_sync' })
    ]))
    database.registerAiScheduleAgent('catalog-metadata-agent', '周期校时 Agent', afterExpiry)
    const job = database.createPersonalMetadataJob(
      'wuthering-waves',
      'cycles',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      afterExpiry
    )!
    expect(job.metadataTargets).toEqual([expect.objectContaining({
      title: '终焉矩阵',
      missingFields: ['startsAt', 'endsAt'],
      timeWindowPolicy: 'current_playable_phase',
      sourceIdentity: expect.objectContaining({ provider: 'gtask-cycle-catalog' })
    })])
  })

  it('固定周期模式不复用上一期时间缓存，已过期官方身份也能重建当前期', () => {
    database = new AppDatabase(':memory:')
    const accountScope = `kuro-community:${'9'.repeat(64)}`
    const identity = {
      provider: 'kuro-community',
      endpoint: 'personal-challenge-record',
      externalId: 'endgame:endstate-matrix|period:wuthering-waves:endstate-matrix:current'
    }
    const currentPeriod = {
      remoteKey: 'endgame:endstate-matrix',
      category: 'endgame' as const,
      title: '终焉矩阵',
      completed: true,
      modeKey: 'endstate-matrix',
      periodKey: 'wuthering-waves:endstate-matrix:current',
      startsAt: '2026-07-17T04:00:00+08:00',
      endsAt: '2026-08-01T04:00:00+08:00',
      sourceIdentity: identity
    }
    database.replacePersonalSnapshot(
      'wuthering-waves',
      'cycles',
      accountScope,
      [currentPeriod],
      'test-v1',
      new Date('2026-07-20T00:00:00.000Z')
    )

    const afterExpiry = new Date('2026-08-02T01:00:00.000Z')
    database.replacePersonalSnapshot(
      'wuthering-waves',
      'cycles',
      accountScope,
      [],
      'test-v1',
      afterExpiry
    )
    expect(database.listChecklistItems('wuthering-waves').some(
      (item) => item.title === '终焉矩阵'
    )).toBe(false)

    database.replacePersonalSnapshot(
      'wuthering-waves',
      'cycles',
      accountScope,
      [{ ...currentPeriod, completed: true, startsAt: null, endsAt: null }],
      'test-v1',
      new Date('2026-08-02T01:01:00.000Z')
    )
    expect(database.listChecklistItems('wuthering-waves').find(
      (item) => item.title === '终焉矩阵'
    )).toMatchObject({
      source: 'personal_sync',
      completed: false,
      startsAt: null,
      endsAt: null
    })

    database.registerAiScheduleAgent(
      'renewed-cycle-metadata-agent',
      '新周期校时 Agent',
      afterExpiry
    )
    const job = database.createPersonalMetadataJob(
      'wuthering-waves',
      'cycles',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      afterExpiry
    )!
    expect(job.metadataTargets).toEqual([expect.objectContaining({
      title: '终焉矩阵',
      missingFields: ['startsAt', 'endsAt'],
      timeWindowPolicy: 'current_playable_phase'
    })])

    const claimed = database.claimAiScheduleJob(
      'renewed-cycle-metadata-agent',
      new Date('2026-08-02T01:02:00.000Z')
    )!
    const target = claimed.metadataTargets[0]
    database.recordSyncTargetAttempt(
      'wuthering-waves',
      'cycles',
      'idle',
      new Date('2026-08-02T01:02:30.000Z')
    )
    database.applyPersonalMetadataJob(
      claimed.id,
      'renewed-cycle-metadata-agent',
      [{
        itemId: target.itemId,
        title: target.title,
        startsAt: '2026-08-01T04:00:00+08:00',
        endsAt: '2026-08-16T04:00:00+08:00',
        sourceUrl: 'https://example.com/current-cycle',
        confidence: 1
      }],
      { evidence: ['current-cycle'] },
      'zh-CN',
      new Date('2026-08-02T01:03:00.000Z')
    )
    expect(database.listChecklistItems('wuthering-waves').find(
      (item) => item.title === '终焉矩阵'
    )).toMatchObject({
      completed: false,
      startsAt: '2026-08-01T04:00:00+08:00',
      endsAt: '2026-08-16T04:00:00+08:00'
    })
    expect(database.getSyncTargetStates('wuthering-waves').find(
      (state) => state.target === 'cycles'
    )).toMatchObject({
      status: 'success',
      lastSuccessAt: '2026-08-02T01:03:00.000Z'
    })

    database.replacePersonalSnapshot(
      'wuthering-waves',
      'cycles',
      accountScope,
      [{ ...currentPeriod, completed: true, startsAt: null, endsAt: null }],
      'test-v1',
      new Date('2026-08-02T01:04:00.000Z')
    )
    expect(database.listChecklistItems('wuthering-waves').find(
      (item) => item.title === '终焉矩阵'
    )).toMatchObject({ completed: true })
  })

  it('个人活动新官方 ID 只在首次进入 Codex 异常旁路并缓存可复用规则', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-08-01T12:00:00.000Z')
    const accountScope = `miyoushe:${'e'.repeat(64)}`
    const item = {
      remoteKey: 'personal-event:miyoushe:event-api:new-event',
      category: 'limited_event' as const,
      title: '全新限时活动',
      startsAt: '2026-08-01T00:00:00.000Z',
      endsAt: '2026-08-20T00:00:00.000Z',
      sourceIdentity: {
        provider: 'miyoushe',
        endpoint: 'event-api',
        externalId: 'new-event'
      }
    }
    const draft = {
      target: 'events' as const,
      kind: 'personal-item-semantics',
      payload: {
        provider: 'miyoushe',
        sourceContext: 'event-api',
        officialEventId: 'new-event',
        title: item.title,
        observedStatus: { isFinished: false },
        reviewIssues: ['classification', 'completion_semantics'],
        proposedItem: item
      }
    }
    const staged = database.preparePersonalReviewJob(
      'genshin',
      'events',
      accountScope,
      [item],
      [draft],
      'test-v1',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      reference
    )
    expect(staged.job).toMatchObject({
      jobKind: 'personal_review',
      target: 'events',
      reviewTargets: [expect.objectContaining({ issues: expect.arrayContaining(['classification']) })]
    })
    expect(staged.items).toEqual([
      expect.objectContaining({ title: item.title })
    ])
    database.replacePersonalSnapshot(
      'genshin',
      'events',
      accountScope,
      staged.items,
      'test-v1',
      reference
    )
    expect(database.listChecklistItems('genshin').some((entry) => entry.title === item.title))
      .toBe(true)

    database.registerAiScheduleAgent('personal-review-agent', '个人异常 Agent', reference)
    const claimed = database.claimAiScheduleJob('personal-review-agent', reference)!
    const candidateId = claimed.reviewTargets[0]!.candidateId
    database.applyPersonalReviewJob(
      claimed.id,
      'personal-review-agent',
      [{
        candidateId,
        decision: 'include',
        eventScope: 'limited',
        reason: '已确认是独立限时活动，并建立官方状态字段规则',
        completed: false,
        completionRule: {
          fieldPath: 'observedStatus.isFinished',
          completedValues: [true],
          incompleteValues: [false]
        },
        confidence: 0.95
      }],
      [{ url: 'https://example.com/event', note: '核验记录' }],
      'zh-CN',
      reference
    )
    expect(database.listChecklistItems('genshin')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: item.title,
        source: 'personal_sync',
        completed: false,
        activityTags: []
      })
    ]))

    const cachedDraft = {
      ...draft,
      payload: {
        ...draft.payload,
        observedStatus: { isFinished: true },
        proposedItem: item
      }
    }
    const cached = database.preparePersonalReviewJob(
      'genshin',
      'events',
      accountScope,
      [item],
      [cachedDraft],
      'test-v1',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      new Date('2026-08-02T12:00:00.000Z')
    )
    expect(cached.job).toBeNull()
    expect(cached.items).toEqual([
      expect.objectContaining({ title: item.title, completed: true, activityTags: [] })
    ])
  })

  it('个人接口中的常驻内容由生命周期决定排除，不进入限时活动快照', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-08-02T08:00:00.000Z')
    const accountScope = `miyoushe:${'a'.repeat(64)}`
    const proposed = {
      remoteKey: 'personal-event:miyoushe:event-api:permanent-mode',
      category: 'limited_event' as const,
      title: '常驻经营玩法',
      sourceIdentity: {
        provider: 'miyoushe', endpoint: 'event-api', externalId: 'permanent-mode'
      }
    }
    const staged = database.preparePersonalReviewJob(
      'star-rail',
      'events',
      accountScope,
      [proposed],
      [{
        target: 'events',
        kind: 'personal-item-semantics',
        payload: {
          provider: 'miyoushe',
          sourceContext: 'event-api',
          officialEventId: 'permanent-mode',
          title: proposed.title,
          reviewIssues: ['classification'],
          proposedItem: proposed
        }
      }],
      'test-v1',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      reference
    )
    database.replacePersonalSnapshot(
      'star-rail',
      'events',
      accountScope,
      staged.items,
      'test-v1',
      reference
    )
    expect(database.listChecklistItems('star-rail').some(
      (item) => item.title === proposed.title
    )).toBe(true)
    database.registerAiScheduleAgent('permanent-event-agent', '常驻识别 Agent', reference)
    const claimed = database.claimAiScheduleJob('permanent-event-agent', reference)!
    database.applyPersonalReviewJob(
      staged.job!.id,
      'permanent-event-agent',
      [{
        candidateId: claimed.reviewTargets[0]!.candidateId,
        decision: 'exclude',
        eventScope: 'permanent',
        reason: '官方资料确认该玩法长期开放且没有限时活动窗口',
        confidence: 1
      }],
      [{ url: 'https://example.com/permanent', note: '官方常驻说明' }],
      'zh-CN',
      reference
    )
    expect(database.listChecklistItems('star-rail').some(
      (item) => item.title === proposed.title
    )).toBe(false)
  })

  it('个人地图层级异常暂存期间保留旧快照，取消后不能迟到写入', () => {
    database = new AppDatabase(':memory:')
    const accountScope = `miyoushe:${'f'.repeat(64)}`
    const reference = new Date('2026-08-01T12:00:00.000Z')
    database.replacePersonalSnapshot('genshin', 'exploration', accountScope, [{
      remoteKey: 'personal-map:miyoushe:old-root',
      category: 'exploration',
      title: '旧一级地区',
      progressPercent: 50,
      mapNodeKind: 'region',
      parentRemoteKey: null,
      sourceIdentity: {
        provider: 'miyoushe', endpoint: 'personal-map-progress', externalId: 'old-root'
      }
    }], 'test-v1', reference)
    const proposed = {
      remoteKey: 'personal-map:miyoushe:new-child',
      category: 'exploration' as const,
      title: '新二级地区',
      progressPercent: 20,
      sourceIdentity: {
        provider: 'miyoushe', endpoint: 'personal-map-progress', externalId: 'new-child'
      }
    }
    const staged = database.preparePersonalReviewJob(
      'genshin',
      'exploration',
      accountScope,
      [],
      [{
        target: 'exploration',
        kind: 'personal-map-progress',
        payload: {
          provider: 'miyoushe', sourceContext: 'personal-map-progress',
          officialId: 'new-child', officialTitle: '新二级地区', observedProgress: 20,
          observedNodeKind: 'subregion', observedParentId: 'new-root',
          reviewIssues: ['hierarchy'], proposedItem: proposed
        }
      }],
      'test-v2',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      reference
    )
    expect(staged.job?.jobKind).toBe('personal_review')
    expect(database.listChecklistItems('genshin').some((item) => item.title === '旧一级地区'))
      .toBe(true)
    database.registerAiScheduleAgent('cancel-personal-review', '取消测试 Agent', reference)
    const claimed = database.claimAiScheduleJob('cancel-personal-review', reference)!
    database.cancelActiveAiScheduleJob('genshin', 'exploration', reference, 'personal_review')
    expect(() => database!.applyPersonalReviewJob(
      claimed.id,
      'cancel-personal-review',
      [{
        candidateId: claimed.reviewTargets[0]!.candidateId,
        decision: 'exclude',
        reason: '无法确认父级',
        confidence: 0.5
      }],
      [],
      'zh-CN',
      reference
    )).toThrow('未由当前 Agent 领取')
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
