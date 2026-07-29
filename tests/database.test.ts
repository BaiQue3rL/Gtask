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

  it('公开资料刷新会为旧个人活动补齐玩法标签，并拒绝待识别', () => {
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
      .toEqual([expect.objectContaining({ activityTags: ['战斗'] })])
  })

  it('四款游戏的活动同步都会把有效未知活动列为强制标签补全目标', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-26T00:00:00.000Z')
    database.registerAiScheduleAgent('tag-target-agent', '标签补全 Agent', reference)

    for (const gameId of ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const) {
      database.mergeSyncedItems(gameId, 'personal_sync', [
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
        `${gameId} 有效未知活动`
      ])
      database.failAiScheduleJob(queued.id, 'tag-target-agent', '测试结束', reference)
    }
  })

  it('活动同步遗漏任一旧活动标签时拒绝整次提交且不产生部分写入', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-26T00:00:00.000Z')
    database.mergeSyncedItems('star-rail', 'personal_sync', [{
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

    expect(() => database!.applyAiScheduleJob(
      queued.id,
      'tag-coverage-agent',
      [{
        remoteKey: 'public:event:new',
        category: 'limited_event',
        title: '本轮新增活动',
        activityTags: ['签到'],
        startsAt: '2026-07-26T10:00:00+08:00',
        endsAt: '2026-08-10T03:59:00+08:00'
      }],
      [],
      reference
    )).toThrow('活动标签补全遗漏 1 项：必须补全的旧活动')
    expect(database.listChecklistItems('star-rail').some((item) => item.title === '本轮新增活动'))
      .toBe(false)
  })

  it('标签专用回写只修改玩法标签并保留个人活动的时间、来源和完成状态', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-26T00:00:00.000Z')
    database.mergeSyncedItems('star-rail', 'personal_sync', [{
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
        activityTags: ['签到'],
        sourceUrl: 'https://example.com/cn/tag-proof',
        confidence: 0.98
      }]
    )

    const after = database.listChecklistItems('star-rail')
      .find((item) => item.id === before.id)!
    expect(after).toMatchObject({
      activityTags: ['签到'],
      source: 'personal_sync',
      remoteKey: before.remoteKey,
      startsAt: before.startsAt,
      endsAt: before.endsAt,
      completed: true
    })
    expect(result.job).toMatchObject({ status: 'completed' })
    expect(database.getSyncSettings('star-rail')).toMatchObject({ status: 'success' })
  })

  it('确实无法确认的活动允许写未知但同步明确标为部分完成并在下次重试', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-26T00:00:00.000Z')
    database.mergeSyncedItems('zenless', 'personal_sync', [{
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

    const result = database.applyAiScheduleJob(
      queued.id,
      'unresolved-tag-agent',
      [],
      [],
      reference,
      [{
        itemId: target.itemId,
        title: target.title,
        activityTags: ['未知'],
        sourceUrl: 'https://example.com/cn/unresolved',
        confidence: 0.95,
        unresolvedReason: '已交叉检索官方公告和中文社区，但均未公布具体玩法'
      }]
    )

    expect(result.job.message).toContain('仍有 1 项活动经本轮核验后暂为未知')
    expect(database.getSyncSettings('zenless')).toMatchObject({ status: 'stale' })
    const next = database.createAiScheduleJob(
      'zenless',
      'public_schedule',
      new Date('2026-07-27T00:00:00.000Z'),
      true,
      'events'
    )
    expect(next.activityTagTargets.map((entry) => entry.title)).toEqual(['资料不足的活动'])
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
    database.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    raw.prepare('UPDATE checklist_items SET activity_tags_json = ? WHERE id = ?')
      .run('["待识别"]', legacy.id)
    raw.prepare('UPDATE checklist_items SET activity_tags_json = ? WHERE id = ?')
      .run('["shooting","puzzle"]', english.id)
    raw.close()

    database = new AppDatabase(databasePath)
    expect(database.listChecklistItems('genshin').find((item) => item.id === empty.id))
      .toMatchObject({ activityTags: ['未知'] })
    expect(database.listChecklistItems('genshin').find((item) => item.id === legacy.id))
      .toMatchObject({ activityTags: ['未知'] })
    expect(database.listChecklistItems('genshin').find((item) => item.id === english.id))
      .toMatchObject({ activityTags: ['射击', '解谜'] })
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

    expect(
      database.archiveCompletedSection('genshin', ['limited_event'])
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

  it('语义核验候选脱敏去重，并且只有高置信 Codex 结论才能安全写入', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('star-rail', 'events', 'public_schedule', 'complete')
    const draft = {
      target: 'events' as const,
      kind: 'personal-item-semantics',
      payload: {
        officialEventId: '6011',
        title: '反贪「砖」家',
        observedStatus: { allFinished: true }
      }
    }
    expect(database.queueSemanticReviewCandidates('star-rail', 'personal_sync', [draft]))
      .toEqual({ queued: 1, pending: 1 })
    expect(database.getSemanticReviewSummary('star-rail')).toMatchObject({
      pendingCount: 1,
      claimedCount: 0,
      latestDecision: null
    })
    expect(database.queueSemanticReviewCandidates('star-rail', 'personal_sync', [draft]))
      .toEqual({ queued: 0, pending: 1 })
    expect(() => database!.queueSemanticReviewCandidates('star-rail', 'personal_sync', [{
      ...draft,
      payload: { ...draft.payload, token: '禁止入队' }
    }])).toThrow('敏感字段')

    database.registerAiScheduleAgent('semantic-agent', '语义核验 Agent')
    const candidate = database.claimSemanticReviewCandidate('semantic-agent')!
    expect(database.getSemanticReviewSummary('star-rail')).toMatchObject({
      pendingCount: 0,
      claimedCount: 1
    })
    const reviewedItem = {
      remoteKey: 'event:miyoushe:6011',
      category: 'limited_event' as const,
      title: '反贪「砖」家',
      activityTags: ['经营'],
      completed: true,
      startsAt: '2026-08-01T02:00:00.000Z',
      endsAt: '2026-08-10T01:59:00.000Z',
      sourceUrl: 'https://example.com/star-rail-event'
    }
    const approved = database.approveSemanticReviewCandidate(
      candidate.id,
      'semantic-agent',
      reviewedItem,
      0.4,
      [{ url: 'https://example.com/schema', note: '状态字段语义证据' }],
      new Date('2026-07-23T00:00:00.000Z'),
      undefined,
      undefined,
      [],
      {
        fieldPath: 'observedStatus.allFinished',
        completedValues: [true],
        incompleteValues: [false]
      }
    )
    expect(approved.candidate.status).toBe('approved')
    expect(database.getSemanticReviewSummary('star-rail')).toMatchObject({
      pendingCount: 0,
      claimedCount: 0,
      latestDecision: {
        id: candidate.id,
        target: 'events',
        status: 'approved',
        completedAt: '2026-07-23T00:00:00.000Z',
        message: 'Codex 核验通过并已安全写入'
      }
    })
    expect(database.listChecklistItems('star-rail').find((item) => item.remoteKey === reviewedItem.remoteKey))
      .toMatchObject({ completed: false, progressPercent: null })
  })

  it('活动完成语义不明确时可提交 unknown 并保留用户当前状态', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('star-rail', 'events', 'public_schedule', 'complete')
    database.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'public-event:unknown-status',
      category: 'limited_event',
      title: '状态语义待确认活动',
      startsAt: '2026-07-20T00:00:00.000Z',
      endsAt: '2026-08-20T00:00:00.000Z'
    }])
    const existing = database.listChecklistItems('star-rail').find(
      (item) => item.remoteKey === 'public-event:unknown-status'
    )!
    database.updateChecklistItem({ id: existing.id, completed: true })
    const accountScope = `miyoushe:${'d'.repeat(64)}`
    database.queueSemanticReviewCandidates(
      'star-rail',
      'personal_sync',
      [{
        target: 'events',
        kind: 'personal-item-semantics',
        payload: {
          sourceContext: 'miyoushe-star-rail-event-calendar',
          officialEventId: '9001',
          title: '状态语义待确认活动',
          observedStatus: { allFinished: true }
        }
      }],
      new Date('2026-07-28T05:00:00.000Z'),
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      accountScope
    )
    database.registerAiScheduleAgent('unknown-event-agent', '活动三态 Agent')
    const candidate = database.claimSemanticReviewCandidate('unknown-event-agent')!
    database.approveSemanticReviewCandidate(
      candidate.id,
      'unknown-event-agent',
      {
        remoteKey: 'personal-event:9001',
        category: 'limited_event',
        title: '状态语义待确认活动'
      },
      0.95,
      [{ note: '仅确认身份，完成字段语义不足' }],
      new Date('2026-07-28T05:01:00.000Z'),
      existing.id
    )

    expect(database.listChecklistItems('star-rail').find((item) => item.id === existing.id))
      .toMatchObject({ completed: true, manualCompletionLocked: true })
    expect(database.getPersonalItemState(accountScope, existing.id))
      .toMatchObject({ completionState: 'unknown', progressPercent: null })
  })

  it('Codex 确认一次活动字段规则后，同一官方 ID 的后续状态机械写入', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('genshin', 'events', 'public_schedule', 'complete')
    const accountScope = `miyoushe:${'e'.repeat(64)}`
    const draft = {
      target: 'events' as const,
      kind: 'personal-item-semantics',
      payload: {
        sourceContext: 'miyoushe-genshin-event-calendar',
        officialEventId: 'rule-event-1',
        title: '规则复用活动',
        observedStatus: { rewardClaimed: true }
      }
    }
    database.queueSemanticReviewCandidates(
      'genshin',
      'personal_sync',
      [draft],
      new Date('2026-07-28T06:00:00.000Z'),
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      accountScope
    )
    database.registerAiScheduleAgent('event-rule-agent', '活动规则 Agent')
    const candidate = database.claimSemanticReviewCandidate('event-rule-agent')!
    database.approveSemanticReviewCandidate(
      candidate.id,
      'event-rule-agent',
      {
        remoteKey: 'event:rule-event-1',
        category: 'limited_event',
        title: '规则复用活动',
        completed: true
      },
      0.99,
      [{ note: 'rewardClaimed 是该接口当前账号完成整个活动的明确字段' }],
      new Date('2026-07-28T06:01:00.000Z'),
      undefined,
      undefined,
      [],
      {
        fieldPath: 'observedStatus.rewardClaimed',
        completedValues: [true],
        incompleteValues: [false]
      }
    )

    const resolved = database.resolveKnownPersonalDrafts(
      'genshin',
      accountScope,
      [{
        ...draft,
        payload: {
          ...draft.payload,
          observedStatus: { rewardClaimed: false }
        }
      }],
      new Date('2026-07-28T07:00:00.000Z')
    )

    expect(resolved).toMatchObject({ applied: 1, reviewCandidates: [] })
    expect(database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'event:rule-event-1'
    )).toMatchObject({ completed: false })
    expect(database.getSourceBinding(
      'genshin',
      'miyoushe',
      'miyoushe-genshin-event-calendar',
      'rule-event-1'
    )).toMatchObject({
      stateRule: {
        fieldPath: 'observedStatus.rewardClaimed',
        completedValues: [true],
        incompleteValues: [false]
      }
    })
  })

  it('个人候选在规范清单完成前只暂存，完成后才允许 Codex 领取', () => {
    database = new AppDatabase(':memory:')
    database.queueSemanticReviewCandidates('genshin', 'personal_sync', [{
      target: 'exploration',
      kind: 'personal-map-progress',
      payload: {
        provider: 'miyoushe',
        officialId: 'area-6',
        officialTitle: '璃月',
        observedProgress: 100,
        observedNodeKind: 'region'
      }
    }])
    database.registerAiScheduleAgent('catalog-gate-agent', '规范清单门槛 Agent')

    expect(database.getSemanticReviewSummary('genshin', 'exploration')).toMatchObject({
      pendingCount: 1,
      claimedCount: 0,
      waitingForCatalogCount: 1
    })
    expect(database.getActiveSemanticReviewCount()).toBe(0)
    expect(database.claimSemanticReviewCandidate('catalog-gate-agent')).toBeNull()

    database.recordCatalogCoverage('genshin', 'exploration', 'public_schedule', 'complete')

    expect(database.getActiveSemanticReviewCount()).toBe(1)
    expect(database.getSemanticReviewSummary('genshin', 'exploration'))
      .toMatchObject({ waitingForCatalogCount: 0 })
    expect(database.claimSemanticReviewCandidate('catalog-gate-agent'))
      .toMatchObject({ target: 'exploration', status: 'claimed' })
  })

  it('同一批语义核验存在拒绝项时版块保持陈旧状态而不伪报成功', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('zenless', 'cycles', 'public_schedule', 'complete')
    const reference = new Date('2026-07-26T12:00:00.000Z')
    database.queueSemanticReviewCandidates('zenless', 'personal_sync', [
      {
        target: 'cycles',
        kind: 'cycle-progress',
        payload: { observedTitle: '无法确认的周期项' }
      },
      {
        target: 'cycles',
        kind: 'cycle-progress',
        payload: { observedTitle: '可确认的周期项' }
      }
    ], reference)
    database.registerAiScheduleAgent('semantic-status-agent', '语义状态 Agent')

    const rejected = database.claimSemanticReviewCandidate('semantic-status-agent', reference)!
    database.rejectSemanticReviewCandidate(
      rejected.id,
      'semantic-status-agent',
      '来源字段不足，无法确认',
      [],
      reference
    )
    const approved = database.claimSemanticReviewCandidate('semantic-status-agent', reference)!
    database.approveSemanticReviewCandidate(
      approved.id,
      'semantic-status-agent',
      {
        remoteKey: 'endgame:verified-cycle',
        category: 'endgame',
        title: '可确认的周期项',
        modeKey: 'verified-cycle',
        periodKey: '2026-07',
        completed: false
      },
      0.9,
      [],
      reference
    )

    expect(database.getSyncTargetStates('zenless')).toContainEqual(
      expect.objectContaining({
        target: 'cycles',
        status: 'stale',
        lastSuccessAt: null
      })
    )
  })

  it('上次 rejected 的同一地图候选会在下一次同步重新入队', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('genshin', 'exploration', 'public_schedule', 'complete')
    const draft = {
      target: 'exploration' as const,
      kind: 'map-progress',
      payload: {
        observedTitle: '枫丹廷区',
        observedProgressPercent: 73
      }
    }
    const firstAt = new Date('2026-07-26T12:00:00.000Z')
    const secondAt = new Date('2026-07-26T13:00:00.000Z')
    expect(database.queueSemanticReviewCandidates(
      'genshin',
      'personal_sync',
      [draft],
      firstAt
    )).toEqual({ queued: 1, pending: 1 })
    database.registerAiScheduleAgent('map-retry-agent', '地图重试 Agent')
    const first = database.claimSemanticReviewCandidate('map-retry-agent', firstAt)!
    database.rejectSemanticReviewCandidate(
      first.id,
      'map-retry-agent',
      '上次未能确认地图对应关系',
      [],
      firstAt
    )

    expect(database.queueSemanticReviewCandidates(
      'genshin',
      'personal_sync',
      [draft],
      secondAt
    )).toEqual({ queued: 1, pending: 1 })
    const retried = database.claimSemanticReviewCandidate('map-retry-agent', secondAt)!
    expect(retried).toMatchObject({
      id: first.id,
      status: 'claimed',
      requestedAt: secondAt.toISOString(),
      completedAt: null
    })
  })

  it('持久保存官方 ID 绑定、账号隔离状态和接口语义配置', () => {
    database = new AppDatabase(':memory:')
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'public-map:liyue',
      category: 'exploration',
      title: '璃月',
      mapNodeKind: 'region',
      progressPercent: 0
    }])
    const item = database.listChecklistItems('genshin').find(
      (candidate) => candidate.remoteKey === 'public-map:liyue'
    )!
    const accountScope = `miyoushe:${'a'.repeat(64)}`
    const reference = new Date('2026-07-28T01:00:00.000Z')

    expect(database.upsertSourceBinding({
      gameId: 'genshin',
      provider: 'miyoushe',
      endpoint: 'record/index',
      externalId: '6',
      itemId: item.id,
      bindingKind: 'codex',
      confidence: 0.99
    }, reference)).toMatchObject({
      externalId: '6',
      itemId: item.id,
      bindingKind: 'codex'
    })
    expect(database.getSourceBinding('genshin', 'miyoushe', 'record/index', '6'))
      .toMatchObject({ itemId: item.id, confidence: 0.99 })

    expect(database.upsertPersonalItemState({
      accountScope,
      gameId: 'genshin',
      itemId: item.id,
      provider: 'miyoushe',
      endpoint: 'record/index',
      externalId: '6',
      completionState: 'incomplete',
      progressPercent: 87.4,
      observedAt: reference.toISOString()
    }, reference)).toMatchObject({
      accountScope,
      progressPercent: 87.4,
      completionState: 'incomplete'
    })

    expect(database.upsertSemanticProfile({
      gameId: 'genshin',
      provider: 'miyoushe',
      endpoint: 'record/index',
      profileVersion: '2026-07',
      target: 'exploration',
      status: 'active',
      semantics: {
        externalIdField: 'id',
        progressField: 'exploration_percentage',
        progressScale: 10
      }
    }, reference)).toMatchObject({
      target: 'exploration',
      status: 'active',
      semantics: { progressScale: 10 }
    })
  })

  it('同一批个人候选可以成批领取且不会跨游戏或版块', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('genshin', 'exploration', 'public_schedule', 'complete')
    database.recordCatalogCoverage('star-rail', 'cycles', 'public_schedule', 'complete')
    database.registerAiScheduleAgent('batch-review-agent', '批量审核 Agent')
    const reference = new Date('2026-07-28T01:30:00.000Z')
    const accountScope = `miyoushe:${'e'.repeat(64)}`
    database.queueSemanticReviewCandidates(
      'genshin',
      'personal_sync',
      Array.from({ length: 3 }, (_, index) => ({
        target: 'exploration' as const,
        kind: 'personal-map-progress',
        payload: {
          provider: 'miyoushe',
          officialId: `map-${index + 1}`,
          officialTitle: `地图 ${index + 1}`,
          observedProgress: index * 10
        }
      })),
      reference,
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      accountScope
    )
    database.queueSemanticReviewCandidates(
      'star-rail',
      'personal_sync',
      [{
        target: 'cycles',
        kind: 'personal-challenge-record',
        payload: {
          provider: 'miyoushe',
          observedRemoteKey: 'memory-of-chaos',
          observedModeKey: 'memory-of-chaos',
          observedHasChallengeRecord: true
        }
      }],
      reference
    )

    const firstBatch = database.claimSemanticReviewBatch('batch-review-agent', 2, reference)
    expect(firstBatch).toHaveLength(2)
    expect(firstBatch.every((candidate) =>
      candidate.gameId === 'genshin' &&
      candidate.target === 'exploration' &&
      candidate.accountScope === accountScope
    )).toBe(true)

    const secondBatch = database.claimSemanticReviewBatch('batch-review-agent', 20, reference)
    expect(secondBatch).toHaveLength(1)
    expect(secondBatch[0]).toMatchObject({
      gameId: 'genshin',
      target: 'exploration',
      accountScope
    })
    const nextGroup = database.claimSemanticReviewBatch('batch-review-agent', 20, reference)
    expect(nextGroup).toHaveLength(1)
    expect(nextGroup[0]).toMatchObject({ gameId: 'star-rail', target: 'cycles' })
  })

  it('规范清单完成后个人进度建立绑定，后续公开资料补全不破坏 ID 或完成状态', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('genshin', 'events', 'public_schedule', 'complete')
    const accountScope = `miyoushe:${'f'.repeat(64)}`
    const personalAt = new Date('2026-07-28T02:30:00.000Z')
    database.registerAiScheduleAgent('dual-entry-agent', '双入口 Agent', personalAt)
    database.queueSemanticReviewCandidates(
      'genshin',
      'personal_sync',
      [{
        target: 'events',
        kind: 'personal-item-semantics',
        payload: {
          provider: 'miyoushe',
          officialEventId: 'event-701',
          title: '个人入口建立的活动',
          observedStatus: { finished: true }
        }
      }],
      personalAt,
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      accountScope
    )
    const candidate = database.claimSemanticReviewCandidate('dual-entry-agent', personalAt)!
    database.approveSemanticReviewCandidate(
      candidate.id,
      'dual-entry-agent',
      {
        remoteKey: 'canonical:event:701',
        category: 'limited_event',
        title: '个人入口建立的活动',
        activityTags: ['战斗'],
        completed: true
      },
      0.99,
      [],
      new Date('2026-07-28T02:31:00.000Z'),
      undefined,
      undefined,
      [],
      {
        fieldPath: 'observedStatus.finished',
        completedValues: [true],
        incompleteValues: [false]
      }
    )
    const personalItem = database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'canonical:event:701'
    )!
    expect(personalItem).toMatchObject({ completed: true, activityTags: ['战斗'] })
    expect(database.getSourceBinding(
      'genshin',
      'miyoushe',
      'personal-item-semantics',
      'event-701'
    )).toMatchObject({ itemId: personalItem.id })

    const publicAt = new Date('2026-07-28T03:00:00.000Z')
    database.registerAiScheduleAgent('dual-entry-agent', '双入口 Agent', publicAt)
    const job = database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      publicAt,
      false,
      'events',
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' }
    )
    database.claimAiScheduleJob('dual-entry-agent', publicAt)
    database.applyAiScheduleJob(
      job.id,
      'dual-entry-agent',
      [{
        remoteKey: 'canonical:event:701',
        category: 'limited_event',
        title: '个人入口建立的活动（官方名称）',
        activityTags: ['战斗', '剧情'],
        startsAt: '2026-07-20T02:00:00.000Z',
        endsAt: '2026-08-10T01:59:00.000Z'
      }],
      [{ url: 'https://example.com/event-701', note: '官方活动公告' }],
      publicAt
    )

    const enriched = database.listChecklistItems('genshin').filter(
      (item) => item.remoteKey === 'canonical:event:701'
    )
    expect(enriched).toHaveLength(1)
    expect(enriched[0]).toMatchObject({
      id: personalItem.id,
      title: '个人入口建立的活动（官方名称）',
      completed: true,
      activityTags: ['战斗', '剧情'],
      startsAt: '2026-07-20T02:00:00.000Z',
      endsAt: '2026-08-10T01:59:00.000Z'
    })
    expect(database.getSourceBinding(
      'genshin',
      'miyoushe',
      'personal-item-semantics',
      'event-701'
    )).toMatchObject({ itemId: personalItem.id })
    expect(database.getPersonalItemState(accountScope, personalItem.id))
      .toMatchObject({ completionState: 'completed' })
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

  it('机械路径不能静默覆盖 Codex 已确认的官方 ID 绑定', () => {
    database = new AppDatabase(':memory:')
    const first = database.createChecklistItem({
      gameId: 'genshin',
      category: 'exploration',
      title: '璃月'
    })
    const second = database.createChecklistItem({
      gameId: 'genshin',
      category: 'exploration',
      title: '蒙德'
    })
    database.upsertSourceBinding({
      gameId: 'genshin',
      provider: 'miyoushe',
      endpoint: 'record/index',
      externalId: '6',
      itemId: first.id,
      bindingKind: 'codex',
      confidence: 1
    })

    expect(() => database!.upsertSourceBinding({
      gameId: 'genshin',
      provider: 'miyoushe',
      endpoint: 'record/index',
      externalId: '6',
      itemId: second.id,
      bindingKind: 'mechanical',
      confidence: 1
    })).toThrow('必须交由 Codex 处理冲突')
    expect(database.getSourceBinding('genshin', 'miyoushe', 'record/index', '6'))
      .toMatchObject({ itemId: first.id })
  })

  it('地图首次由 Codex 建立官方 ID 映射，后续同一账号直接机械写入', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('genshin', 'exploration', 'public_schedule', 'complete')
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'public-map:liyue',
      category: 'exploration',
      title: '璃月',
      mapNodeKind: 'region'
    }])
    const map = database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'public-map:liyue'
    )!
    const accountScope = `miyoushe:${'b'.repeat(64)}`
    const draft = {
      target: 'exploration' as const,
      kind: 'personal-map-progress',
      payload: {
        provider: 'miyoushe',
        officialId: '6',
        officialTitle: '璃月',
        observedProgress: 73
      }
    }
    database.queueSemanticReviewCandidates(
      'genshin',
      'personal_sync',
      [draft],
      new Date('2026-07-28T02:00:00.000Z'),
      { outputLocale: 'zh-CN', userTimeZone: 'Asia/Shanghai' },
      accountScope
    )
    database.registerAiScheduleAgent('map-binding-agent', '地图绑定 Agent')
    const candidate = database.claimSemanticReviewCandidate('map-binding-agent')!
    expect(candidate.accountScope).toBe(accountScope)
    database.approveSemanticReviewCandidate(
      candidate.id,
      'map-binding-agent',
      {
        remoteKey: 'personal-map:6',
        category: 'exploration',
        title: '璃月',
        progressPercent: 73,
        mapNodeKind: 'region'
      },
      0.99,
      [{ note: '官方区域 id 与公开清单一致' }],
      new Date('2026-07-28T02:01:00.000Z'),
      map.id
    )

    expect(database.getSourceBinding(
      'genshin',
      'miyoushe',
      'personal-map-progress',
      '6'
    )).toMatchObject({
      itemId: map.id,
      bindingKind: 'codex'
    })
    const resolved = database.resolveKnownPersonalDrafts(
      'genshin',
      accountScope,
      [{
        ...draft,
        payload: {
          ...draft.payload,
          officialTitle: '璃月探索总览',
          observedNodeKind: 'independent',
          observedProgress: 88
        }
      }],
      new Date('2026-07-28T03:00:00.000Z')
    )
    expect(resolved).toEqual({ reviewCandidates: [], applied: 1, preserved: 0 })
    expect(database.listChecklistItems('genshin').find((item) => item.id === map.id))
      .toMatchObject({ progressPercent: 88, completed: false })
    expect(database.getPersonalItemState(accountScope, map.id))
      .toMatchObject({ progressPercent: 88, completionState: 'incomplete' })
  })

  it('地图名称和类型唯一时直接建绑，绑定名称冲突时停止机械写入', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('genshin', 'exploration', 'public_schedule', 'complete')
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'public-map:inazuma',
      category: 'exploration',
      title: '稻妻',
      mapNodeKind: 'region'
    }])
    const accountScope = `miyoushe:${'9'.repeat(64)}`
    const first = database.resolveKnownPersonalDrafts(
      'genshin',
      accountScope,
      [{
        target: 'exploration',
        kind: 'personal-map-progress',
        payload: {
          provider: 'miyoushe',
          officialId: '20',
          officialTitle: '稻妻',
          observedNodeKind: 'region',
          observedProgress: 80
        }
      }]
    )
    expect(first).toEqual({ reviewCandidates: [], applied: 1, preserved: 0 })
    const item = database.listChecklistItems('genshin').find(
      (candidate) => candidate.remoteKey === 'public-map:inazuma'
    )!
    expect(database.getSourceBinding(
      'genshin',
      'miyoushe',
      'personal-map-progress',
      '20'
    )).toMatchObject({ itemId: item.id, bindingKind: 'mechanical' })

    const conflictDraft = {
      target: 'exploration' as const,
      kind: 'personal-map-progress',
      payload: {
        provider: 'miyoushe',
        officialId: '20',
        officialTitle: '璃月',
        observedNodeKind: 'region',
        observedProgress: 100
      }
    }
    const conflict = database.resolveKnownPersonalDrafts(
      'genshin',
      accountScope,
      [conflictDraft]
    )
    expect(conflict.reviewCandidates).toEqual([conflictDraft])
    expect(database.listChecklistItems('genshin').find(
      (candidate) => candidate.id === item.id
    )).toMatchObject({ progressPercent: 80, completed: false })
  })

  it('周期玩法按稳定 modeKey 唯一匹配后直接写入并建立绑定', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('star-rail', 'cycles', 'public_schedule', 'complete')
    database.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'public-cycle:moc:2026-07',
      category: 'endgame',
      title: '混沌回忆·第 53 期',
      modeKey: 'memory-of-chaos',
      periodKey: '2026-07'
    }])
    const accountScope = `miyoushe:${'c'.repeat(64)}`
    const resolution = database.resolveKnownPersonalDrafts(
      'star-rail',
      accountScope,
      [{
        target: 'cycles',
        kind: 'personal-challenge-record',
        payload: {
          provider: 'miyoushe',
          observedRemoteKey: 'endgame:memory-of-chaos',
          observedModeKey: 'memory-of-chaos',
          observedHasChallengeRecord: true
        }
      }]
    )

    expect(resolution).toEqual({ reviewCandidates: [], applied: 1, preserved: 0 })
    const item = database.listChecklistItems('star-rail').find(
      (candidate) => candidate.modeKey === 'memory-of-chaos'
    )!
    expect(item.completed).toBe(true)
    expect(database.getSourceBinding(
      'star-rail',
      'miyoushe',
      'personal-challenge-record',
      'endgame:memory-of-chaos'
    )).toMatchObject({ itemId: item.id, bindingKind: 'mechanical' })
  })

  it('可分别取消公开任务与个人语义核验并保留精确的 Agent 范围', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('genshin', 'exploration', 'public_schedule', 'complete')
    const reference = new Date('2026-07-26T14:00:00.000Z')
    database.registerAiScheduleAgent('cancel-public-agent', '公开任务 Agent', reference)
    database.registerAiScheduleAgent('cancel-review-agent', '语义核验 Agent', reference)

    database.createAiScheduleJob(
      'genshin',
      'public_schedule',
      reference,
      false,
      'events'
    )
    database.claimAiScheduleJob('cancel-public-agent', reference)
    const publicCancellation = database.cancelActiveAiScheduleJob(
      'genshin',
      'events',
      reference
    )
    expect(publicCancellation).toMatchObject({
      agentId: 'cancel-public-agent',
      job: { status: 'failed', message: '用户已取消' }
    })
    expect(database.getActiveAiScheduleJob('genshin', 'events')).toBeNull()

    database.queueSemanticReviewCandidates('genshin', 'personal_sync', [{
      target: 'exploration',
      kind: 'map-progress',
      payload: { observedTitle: '枫丹', observedProgressPercent: 80 }
    }], reference)
    database.claimSemanticReviewCandidate('cancel-review-agent', reference)
    const semanticCancellation = database.cancelSemanticReviewCandidates(
      'genshin',
      'exploration',
      reference
    )
    expect(semanticCancellation).toEqual({
      cancelled: 1,
      agentIds: ['cancel-review-agent']
    })
    expect(database.getSemanticReviewSummary('genshin', 'exploration')).toMatchObject({
      pendingCount: 0,
      claimedCount: 0,
      latestDecision: { status: 'rejected', message: '用户已取消' }
    })
  })

  it('个人同步不把已结束的历史活动放入 Codex 审核队列', () => {
    database = new AppDatabase(':memory:')
    const reference = new Date('2026-07-26T12:00:00.000Z')
    const result = database.queueSemanticReviewCandidates(
      'genshin',
      'personal_sync',
      [
        {
          target: 'events',
          kind: 'personal-item-semantics',
          payload: {
            title: '已结束活动',
            normalizedEndAt: '2026-07-25T12:00:00.000Z'
          }
        },
        {
          target: 'events',
          kind: 'personal-item-semantics',
          payload: {
            title: '当前活动',
            normalizedEndAt: '2026-07-30T12:00:00.000Z'
          }
        }
      ],
      reference
    )

    expect(result).toEqual({ queued: 1, pending: 1 })
    expect(database.getSemanticReviewSummary('genshin'))
      .toMatchObject({ pendingCount: 1, claimedCount: 0 })
  })

  it('Codex 可按现有活动 ID 精确回填名称略有差异的个人进度且不产生重复项', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('genshin', 'events', 'public_schedule', 'complete')
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'genshin:event:heated-battle',
      category: 'limited_event',
      title: '「七圣召唤」热斗模式：自行巧局',
      activityTags: ['卡牌'],
      startsAt: '2026-07-18T02:00:00.000Z',
      endsAt: '2026-08-02T19:59:59.000Z'
    }])
    const existing = database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'genshin:event:heated-battle'
    )!
    database.queueSemanticReviewCandidates('genshin', 'personal_sync', [{
      target: 'events',
      kind: 'personal-item-semantics',
      payload: {
        officialEventId: '336',
        title: '热斗模式：自行巧局',
        observedStatus: { isFinished: true }
      }
    }])
    database.registerAiScheduleAgent('semantic-agent', '语义核验 Agent')
    const candidate = database.claimSemanticReviewCandidate('semantic-agent')!

    database.approveSemanticReviewCandidate(
      candidate.id,
      'semantic-agent',
      {
        remoteKey: 'event:miyoushe:336',
        category: 'limited_event',
        title: '热斗模式：自行巧局',
        activityTags: ['卡牌'],
        completed: true,
        startsAt: '2026-07-18T02:00:00.000Z',
        endsAt: '2026-08-02T19:59:59.000Z'
      },
      0.95,
      [{ url: 'https://example.com/schema', note: '字段代表玩家已完成' }],
      new Date('2026-07-26T00:00:00.000Z'),
      existing.id,
      undefined,
      [],
      {
        fieldPath: 'observedStatus.isFinished',
        completedValues: [true],
        incompleteValues: [false]
      }
    )

    const events = database.listChecklistItems('genshin').filter(
      (item) => item.category === 'limited_event'
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      id: existing.id,
      title: '热斗模式：自行巧局',
      source: 'public_schedule',
      remoteKey: 'genshin:event:heated-battle',
      completed: true
    })
    expect(database.getSyncTargetStates('genshin')).toContainEqual(
      expect.objectContaining({ target: 'events', status: 'success' })
    )
  })

  it('个人进度可匹配公开清单简称并按 Codex 决定归档历史重复项', () => {
    database = new AppDatabase(':memory:')
    database.recordCatalogCoverage('zenless', 'cycles', 'public_schedule', 'complete')
    const startsAt = '2026-07-23T20:00:00.000Z'
    const endsAt = '2026-08-06T19:59:59.000Z'
    database.mergeSyncedItems('zenless', 'public_schedule', [{
      remoteKey: 'endgame:zenless:shiyu-critical:2026-07-24',
      category: 'endgame',
      title: '式舆防卫战·剧变节点',
      modeKey: 'shiyu-defense-critical-node',
      periodKey: '2026-07-24',
      startsAt,
      endsAt
    }])
    database.mergeSyncedItems('zenless', 'personal_sync', [{
      remoteKey: 'endgame:shiyu-defense',
      category: 'endgame',
      title: '式舆防卫战',
      modeKey: 'shiyu-defense',
      periodKey: 'zenless:shiyu-defense:62053',
      startsAt,
      endsAt,
      completed: false
    }], startsAt, true, {
      codexReviewed: true,
      identityPolicy: 'remote-key-only'
    })
    const current = database.listSemanticReviewMatchCandidates('zenless', 'cycles')
    const publicItem = current.find((item) => item.source === 'public_schedule')!
    const duplicate = current.find((item) => item.source === 'personal_sync')!
    expect(database.listSemanticReviewMatchCandidates('zenless', 'events')).toEqual([])

    database.queueSemanticReviewCandidates('zenless', 'personal_sync', [{
      target: 'cycles',
      kind: 'cycle-progress',
      payload: {
        observedTitle: '式舆防卫战',
        observedModeKey: 'shiyu-defense',
        observedStartsAt: startsAt,
        observedEndsAt: endsAt,
        observedHasChallengeRecord: false
      }
    }])
    database.registerAiScheduleAgent('semantic-cleanup-agent', '语义去重 Agent')
    const candidate = database.claimSemanticReviewCandidate('semantic-cleanup-agent')!
    const result = database.approveSemanticReviewCandidate(
      candidate.id,
      'semantic-cleanup-agent',
      {
        remoteKey: 'endgame:shiyu-defense',
        category: 'endgame',
        title: '式舆防卫战',
        modeKey: 'shiyu-defense',
        periodKey: 'zenless:shiyu-defense:62053',
        startsAt,
        endsAt,
        completed: false
      },
      0.99,
      [{ url: 'https://example.com/zenless', note: '同一周期玩法的个人接口简称' }],
      new Date('2026-07-26T14:30:00.000Z'),
      publicItem.id,
      'zh-CN',
      [{ itemId: duplicate.id, reason: '个人接口简称与公开清单是同一期玩法' }]
    )

    expect(result).toMatchObject({ archived: 1, merge: { added: 0, updated: 1 } })
    expect(database.listChecklistItems('zenless').filter((item) => item.category === 'endgame'))
      .toEqual([
        expect.objectContaining({
          id: publicItem.id,
          remoteKey: publicItem.remoteKey,
          source: 'public_schedule'
        })
      ])
    expect(database.listArchivedChecklistItems('zenless')).toContainEqual(
      expect.objectContaining({ id: duplicate.id })
    )
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

  it('启动时不再按标题和时间自行归并 Codex 尚未处理的历史挑战项', () => {
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
      .filter((item) => item.modeKey === 'zenless:separate-period-mode')).toHaveLength(2)
  })

  it('个人活动按中文名和重叠时间回填公开排期且不产生重复项', () => {
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

  it('个人活动标题是公开标题子串时合并，并归档历史重复记录', () => {
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

  it('启动时保留 Codex 写入的星铁活动完成状态和用户手动完成', () => {
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

  it('无时间个人条目只能补充公开资料已有活动并保留公开时间', () => {
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

  it('公开地图先建 0% 清单，再按区域中文名回填个人探索度', () => {
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
        title: '自定义独立区域',
        mapNodeKind: 'independent',
        relatedRegionRemoteKey: 'map:world:a'
      }
    ])
    expect(database.listChecklistItems('star-rail').find(
      (item) => item.remoteKey === 'map:world:a:independent'
    )).toMatchObject({
      mapNodeKind: 'independent',
      relatedRegionRemoteKey: 'map:world:a',
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
    ])).toThrow('地图层级存在循环')
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
    expect(periods.find((item) => item.periodKey === 'public-period-b')).toMatchObject({
      title: '式舆防卫战·本期',
      completed: true,
      source: 'public_schedule'
    })
  })

  it('个人挑战与公开资料模式键不一致时按当前中文标题归并', () => {
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
      message: '正在启动本机 Codex'
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

  it('个人审核进度按游戏和版块分别统计', () => {
    database = new AppDatabase(':memory:')
    database.queueSemanticReviewCandidates('genshin', 'personal_sync', [
      {
        target: 'events',
        kind: 'event-progress',
        payload: { title: '活动进度' }
      },
      {
        target: 'cycles',
        kind: 'cycle-progress',
        payload: { title: '周期进度' }
      }
    ])

    expect(database.getSemanticReviewSummary('genshin')).toMatchObject({
      pendingCount: 2,
      claimedCount: 0
    })
    expect(database.getSemanticReviewSummary('genshin', 'events')).toMatchObject({
      pendingCount: 1,
      claimedCount: 0
    })
    expect(database.getSemanticReviewSummary('genshin', 'cycles')).toMatchObject({
      pendingCount: 1,
      claimedCount: 0
    })
    expect(database.getSemanticReviewSummary('genshin', 'exploration')).toMatchObject({
      pendingCount: 0,
      claimedCount: 0
    })
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
        schemaVersion: 3,
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
      message: 'Codex 超时，任务已重新排队'
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
        activityTags: ['战斗'],
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
          activityTags: ['战斗'],
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
          activityTags: ['战斗'],
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
      activityTags: ['剧情'],
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
          activityTags: ['剧情', '战斗'],
          startsAt: '2026-07-21T00:00:00.000Z',
          endsAt: '2026-08-21T00:00:00.000Z'
        },
        {
          remoteKey: 'star-rail:event:genuinely-new',
          category: 'limited_event',
          title: 'Codex 核验的新活动',
          activityTags: ['解谜'],
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

  it('四款游戏均允许 Codex 把错误同步项移入回收站且保护手动项', () => {
    database = new AppDatabase(':memory:')
    database.registerAiScheduleAgent('agent-codex-cleanup', 'Codex 清单纠错 Agent')

    for (const gameId of ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const) {
      database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `${gameId}:event:duplicate`,
        category: 'limited_event',
        title: `${gameId} 重复活动`,
        activityTags: ['战斗'],
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
      expect(database.listArchivedChecklistItems(gameId).some((item) => item.id === duplicate.id)).toBe(true)
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
        mapNodeKind: 'independent',
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
      [{
        matchItemId: child.id,
        remoteKey: 'ignored-by-match',
        category: 'exploration',
        title: '卫非地',
        mapNodeKind: 'independent',
        parentRemoteKey: null
      }],
      [],
      new Date(),
      [],
      [],
      [{ itemId: parent.id, reason: '移除过时包装层并重新挂接子地图' }]
    )

    expect(result.archived).toBe(1)
    expect(database.listChecklistItems('zenless')
      .find((item) => item.id === child.id)?.parentRemoteKey).toBeNull()
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
