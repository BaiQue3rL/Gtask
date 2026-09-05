import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database'
import { getBundledMapCatalog } from '../src/main/sync/map-catalog'
import { SUPPORTED_GAME_IDS, type GameId } from '../src/shared/contracts'

let database: AppDatabase | null = null
let temporaryDirectory: string | null = null

function applyVersionWindow(
  target: AppDatabase,
  gameId: GameId,
  reference: Date,
  periodKey: string,
  startsAt: string,
  endsAt: string
) {
  const agentId = `version-agent-${gameId}`
  target.registerAiScheduleAgent(agentId, 'Version test agent', reference)
  const job = target.createAiScheduleJob(gameId, 'public_schedule', reference, false, 'tasks')
  target.claimAiScheduleJob(agentId, reference)
  return target.applyAiScheduleJob(
    job.id,
    agentId,
    [],
    [],
    reference,
    [],
    [],
    [],
    'zh-CN',
    {
      periodKey,
      startsAt,
      endsAt,
      timeZone: 'Asia/Shanghai',
      sourceUrl: 'https://example.com/version',
      confidence: 0.9
    }
  )
}

afterEach(() => {
  database?.close()
  database = null
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe('AppDatabase', () => {
  it('公共基准重复内容会保留原时间戳而不是伪造更新', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const item = {
      remoteKey: 'event:unchanged',
      category: 'limited_event' as const,
      title: '未变化活动',
      activityTags: ['combat'],
      startsAt: '2026-08-20T10:00:00+08:00',
      endsAt: '2026-08-30T03:59:59+08:00',
      scheduleKind: 'fixed_window' as const,
      timeZone: 'Asia/Shanghai',
      sourceUrl: 'https://example.com/unchanged'
    }
    database.mergeSyncedItems(
      'zenless', 'public_schedule', [item], '2026-08-20T10:00:00.000Z'
    )
    const before = database.listChecklistItems('zenless')[0]

    const result = database.mergeSyncedItems(
      'zenless', 'public_schedule', [item], '2026-08-20T11:00:00.000Z'
    )
    const after = database.listChecklistItems('zenless')[0]
    expect(result).toEqual({ added: 0, updated: 0, preserved: 1 })
    expect(after.lastSyncedAt).toBe(before.lastSyncedAt)
    expect(after.updatedAt).toBe(before.updatedAt)
  })

  it('维护任务给出可比较的完整公共结构但不暴露个人完成状态', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const reference = new Date('2026-08-20T10:00:00.000Z')
    database.mergeSyncedItems('zenless', 'public_schedule', [{
      remoteKey: 'event:comparison-candidate',
      category: 'limited_event',
      title: '结构比较候选',
      activityTags: ['combat', 'challenge'],
      startsAt: '2026-08-20T10:00:00+08:00',
      endsAt: '2026-08-30T03:59:59+08:00',
      timeZone: 'Asia/Shanghai',
      sourceUrl: 'https://example.com/comparison-candidate'
    }], reference.toISOString())
    const stored = database.listChecklistItems('zenless')[0]
    database.updateChecklistItem({ id: stored.id, completed: true })
    database.registerAiScheduleAgent('comparison-agent', '差异比较 Agent', reference)
    database.createAiScheduleJob('zenless', 'public_schedule', reference, false, 'events')

    const candidate = database.claimAiScheduleJob('comparison-agent', reference)!
      .matchCandidates[0] as unknown as Record<string, unknown>

    expect(candidate).toMatchObject({
      activityTags: ['combat', 'challenge'],
      timeZone: 'Asia/Shanghai',
      sourceUrl: 'https://example.com/comparison-candidate'
    })
    expect(candidate).not.toHaveProperty('completed')
    expect(candidate).not.toHaveProperty('progressPercent')
  })

  it('个人接口档期观察只暴露结构差异且可以校正既有事项时间', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const reference = new Date('2026-08-27T12:00:00.000Z')
    database.mergeSyncedItems('zenless', 'public_schedule', [{
      remoteKey: 'event:official:calendar-test',
      category: 'limited_event',
      title: '档期观察测试',
      activityTags: ['combat', 'challenge'],
      startsAt: '2026-08-27T04:00:00.000Z',
      endsAt: '2026-09-10T04:00:00.000Z',
      sourceUrl: 'https://example.com/original'
    }], reference.toISOString())
    database.replaceScheduleObservations('zenless', 'events', [{
      target: 'events',
      provider: 'miyoushe',
      endpoint: 'miyoushe-zenless-event-calendar',
      remoteKey: 'personal:event:calendar-test',
      title: '档期观察测试',
      modeKey: 'official-event-calendar-test',
      periodKey: null,
      startsAt: '2026-08-27T04:00:00.000Z',
      endsAt: '2026-09-11T04:00:00.000Z'
    }], reference)
    database.registerAiScheduleAgent('observation-agent', '第一方观察 Agent', reference)
    const queued = database.createAiScheduleJob(
      'zenless', 'public_schedule', reference, false, 'events'
    )
    const claimed = database.claimAiScheduleJob('observation-agent', reference)!
    const observation = claimed.sourceObservations[0]
    const matched = claimed.matchCandidates[0]

    expect(observation).toMatchObject({
      target: 'events',
      provider: 'miyoushe',
      matchedItemId: matched.itemId,
      differences: ['endsAt'],
      endsAt: '2026-09-11T04:00:00.000Z'
    })
    expect(observation).not.toHaveProperty('completed')
    expect(observation).not.toHaveProperty('progressPercent')
    expect(observation).not.toHaveProperty('accountScope')

    database.applyAiScheduleJob(
      queued.id,
      'observation-agent',
      [{
        matchItemId: matched.itemId,
        sourceObservationId: observation.observationId,
        remoteKey: 'ignored-by-match',
        category: 'limited_event',
        title: '档期观察测试',
        activityTags: ['combat', 'challenge'],
        startsAt: '2026-08-27T04:00:00.000Z',
        endsAt: observation.endsAt
      }],
      [{ kind: 'first_party_observation', observationId: observation.observationId }],
      reference
    )

    expect(database.listChecklistItems('zenless')[0]).toMatchObject({
      endsAt: '2026-09-11T04:00:00.000Z',
      sourceUrl: 'https://example.com/original'
    })
    const recheck = database.createAiScheduleJob(
      'zenless', 'public_schedule', new Date(reference.getTime() + 1_000), false, 'events'
    )
    expect(recheck.sourceObservations).toEqual([])
  })

  it('全量任务进入最后地图阶段时返回新的地图契约', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const reference = new Date('2026-08-27T12:00:00.000Z')
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'map:stage-contract',
      category: 'exploration',
      title: '地图阶段测试',
      mapNodeKind: 'region'
    }], reference.toISOString())
    database.registerAiScheduleAgent('stage-agent', '阶段契约 Agent', reference)
    const queued = database.createAiScheduleJob(
      'genshin', 'public_schedule', reference, false, 'all'
    )
    database.claimAiScheduleJob('stage-agent', reference)

    const partial = database.applyAiScheduleJob(
      queued.id,
      'stage-agent',
      [],
      [{ url: 'https://example.com/audit' }],
      reference,
      [],
      [],
      [],
      'zh-CN',
      undefined,
      ['tasks', 'events', 'cycles']
    )

    expect(partial.remainingTargets).toEqual(['exploration'])
    expect(partial.job).toMatchObject({
      target: 'all',
      activeTarget: 'exploration',
      completedTargets: ['tasks', 'events', 'cycles'],
      remainingTargets: ['exploration'],
      contract: { target: 'exploration' }
    })
    expect(partial.job.contract.sections.map((section) => section.target))
      .toEqual(['exploration'])
    expect(partial.job.matchCandidates).toEqual([
      expect.objectContaining({ title: '地图阶段测试', category: 'exploration' })
    ])

    const completed = database.applyAiScheduleJob(
      queued.id,
      'stage-agent',
      [],
      [{ url: 'https://example.com/map-audit' }],
      new Date(reference.getTime() + 1_000),
      [],
      [],
      [],
      'zh-CN',
      undefined,
      ['exploration']
    )
    expect(completed.job).toMatchObject({ status: 'completed', remainingTargets: [] })
  })

  it('全版块无变化核查可以完成且不会为了留痕重写基准', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const reference = new Date('2026-08-20T10:00:00.000Z')
    database.registerAiScheduleAgent('unchanged-agent', '无变化核查 Agent', reference)
    const queued = database.createAiScheduleJob(
      'zenless', 'public_schedule', reference, false, 'all'
    )
    database.claimAiScheduleJob('unchanged-agent', reference)

    const result = database.applyAiScheduleJob(
      queued.id,
      'unchanged-agent',
      [],
      [{ url: 'https://example.com/full-audit', note: '四个版块逐项比较后均无差异' }],
      reference,
      [],
      [],
      [],
      'zh-CN',
      undefined,
      ['tasks', 'events', 'cycles', 'exploration']
    )

    expect(result.job).toMatchObject({
      status: 'completed',
      message: expect.stringContaining('未发现变化')
    })
    expect(result.merge).toEqual({ added: 0, updated: 0, preserved: 0 })
    expect(result.remainingTargets).toEqual([])
    expect(database.listChecklistItems('zenless')).toEqual([])
  })

  it('同一版块不能一边标记无变化一边提交校正', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const reference = new Date('2026-08-20T10:00:00.000Z')
    database.registerAiScheduleAgent('contradiction-agent', '矛盾核查 Agent', reference)
    const queued = database.createAiScheduleJob(
      'wuthering-waves', 'public_schedule', reference, false, 'tasks'
    )
    database.claimAiScheduleJob('contradiction-agent', reference)

    expect(() => database!.applyAiScheduleJob(
      queued.id,
      'contradiction-agent',
      [],
      [],
      reference,
      [],
      [],
      [],
      'zh-CN',
      {
        periodKey: 'wuthering-waves:version:3.6',
        startsAt: '2026-08-20T11:00:00+08:00',
        endsAt: '2026-10-01T04:00:00+08:00',
        timeZone: 'Asia/Shanghai',
        sourceUrl: 'https://example.com/version',
        confidence: 0.82
      },
      ['tasks']
    )).toThrow('不能同时标记为无变化并提交增删改')
  })

  it('周期挑战到期后生成当前预测期，并允许官方延期校时恢复手工状态', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

  it('生命周期只硬删除到期限时活动，不删除周期事项', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    database.mergeSyncedItems('zenless', 'public_schedule', [
      {
        remoteKey: 'event:expires-once',
        category: 'limited_event',
        title: '到期后删除的活动',
        startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-08-02T00:00:00.000Z'
      },
      {
        remoteKey: 'endgame:unknown-stable-mode',
        category: 'endgame',
        title: '等待 Agent 维护的周期',
        startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-08-02T00:00:00.000Z',
        modeKey: 'unknown-stable-mode'
      }
    ], '2026-08-01T12:00:00.000Z')

    expect(database.pruneExpiredSystemItems(new Date('2026-08-03T00:00:00.000Z'))).toBe(1)
    expect(database.listChecklistItems('zenless')).toEqual([
      expect.objectContaining({
        remoteKey: 'endgame:unknown-stable-mode',
        category: 'endgame'
      })
    ])
  })

  it('新用户初始化游戏但不创建任务版块事项', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })

    expect(database.listGames().map((game) => game.id)).toEqual([
      'genshin',
      'star-rail',
      'zenless',
      'wuthering-waves'
    ])

    for (const game of database.listGames()) {
      expect(database.listChecklistItems(game.id)).toEqual([])
    }
  })

  it('只向侧栏提供已有版本窗口的结束时间', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    applyVersionWindow(
      database,
      'genshin',
      new Date('2026-08-03T00:00:00.000Z'),
      'genshin:version:current',
      '2026-08-01T00:00:00.000Z',
      '2026-08-20T00:00:00.000Z'
    )
    expect(database.listGameVersionSummaries(new Date('2026-08-03T00:00:00.000Z')))
      .toEqual([
        { gameId: 'genshin', endsAt: '2026-08-20T00:00:00.000Z' },
        { gameId: 'star-rail', endsAt: null },
        { gameId: 'zenless', endsAt: null },
        { gameId: 'wuthering-waves', endsAt: null }
      ])
  })

  it.each(SUPPORTED_GAME_IDS)(
    '官方窗口过期后按 %s 的独立常规周期续出 42 天低置信度窗口',
    (gameId) => {
      database = new AppDatabase(':memory:', { seedBundledBaselines: false })
      applyVersionWindow(
        database,
        gameId,
        new Date('2026-07-24T00:00:00.000Z'),
        `${gameId}:version:verified`,
        '2026-07-01T00:00:00.000Z',
        '2026-08-01T00:00:00.000Z'
      )

      expect(database.getRelevantGameVersionWindow(
        gameId,
        new Date('2026-08-03T00:00:00.000Z')
      )).toEqual({
        periodKey: `predicted:${gameId}:version:2026-08-01T00:00:00.000Z`,
        startsAt: '2026-08-01T00:00:00.000Z',
        endsAt: '2026-09-12T00:00:00.000Z'
      })
    }
  )

  it('精确官方版本时间覆盖本地 42 天预测窗口', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    applyVersionWindow(
      database,
      'zenless',
      new Date('2026-07-24T00:00:00.000Z'),
      'zenless:version:verified-old',
      '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z'
    )
    expect(database.getRelevantGameVersionWindow(
      'zenless', new Date('2026-08-03T00:00:00.000Z')
    )?.periodKey).toMatch(/^predicted:/)

    applyVersionWindow(
      database,
      'zenless',
      new Date('2026-08-03T00:00:00.000Z'),
      'zenless:version:special',
      '2026-08-01T00:00:00.000Z',
      '2026-09-20T00:00:00.000Z'
    )
    expect(database.getRelevantGameVersionWindow(
      'zenless', new Date('2026-08-03T00:00:00.000Z')
    )).toEqual({
      periodKey: 'zenless:version:special',
      startsAt: '2026-08-01T00:00:00.000Z',
      endsAt: '2026-09-20T00:00:00.000Z'
    })
  })

  it('新增、编辑、手动完成和软删除事项', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

  it('目录合并器拒绝个人数据创建清单结构', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    expect(() => database!.mergeSyncedItems('star-rail', 'personal_sync', [{
      remoteKey: 'personal:event:forbidden',
      category: 'limited_event',
      title: '不能创建的个人活动'
    }])).toThrow('个人进度不能通过目录合并器写入')
    expect(database.listChecklistItems('star-rail')).toEqual([])
  })

  it('四款游戏的活动同步都会把有效未知活动列为强制标签补全目标', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

  it('公开活动缺少玩法标签时拒绝写入', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

    expect(() => database!.applyAiScheduleJob(
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
    )).toThrow('必须提交 1 到 5 个')
    expect(database.listChecklistItems('star-rail').some((item) => item.title === '本轮新增活动'))
      .toBe(false)
    expect(database.listChecklistItems('star-rail').find(
      (item) => item.title === '必须补全的旧活动'
    )?.activityTags).toEqual([])
  })

  it('公开活动重复同步全部命中稳定身份时仍视为目录成功', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const reference = new Date('2026-08-08T13:00:00.000Z')
    const events = [
      {
        remoteKey: 'event:existing:a',
        category: 'limited_event' as const,
        title: '既有活动 A',
        activityTags: ['combat'],
        startsAt: '2026-08-01T10:00:00+08:00',
        endsAt: '2026-08-20T03:59:00+08:00'
      },
      {
        remoteKey: 'event:existing:b',
        category: 'limited_event' as const,
        title: '既有活动 B',
        activityTags: ['combat'],
        startsAt: '2026-08-02T10:00:00+08:00',
        endsAt: '2026-08-21T03:59:00+08:00'
      }
    ]
    database.mergeSyncedItems('wuthering-waves', 'public_schedule', events)
    database.registerAiScheduleAgent('idempotent-events-agent', '活动幂等测试 Agent', reference)
    const queued = database.createAiScheduleJob(
      'wuthering-waves', 'public_schedule', reference, false, 'events'
    )
    database.claimAiScheduleJob('idempotent-events-agent', reference)

    const result = database.applyAiScheduleJob(
      queued.id,
      'idempotent-events-agent',
      events,
      [],
      reference
    )
    expect(result.merge).toEqual({ added: 0, updated: 0, preserved: 2 })
    expect(result.job).toMatchObject({ status: 'completed' })
    expect(database.getSyncTargetStates('wuthering-waves')).toContainEqual(
      expect.objectContaining({
        target: 'events',
        status: 'success',
        catalogCoverage: 'complete',
        lastSuccessAt: reference.toISOString()
      })
    )
  })

  it('标签专用回写只修改玩法标签并保留个人活动的时间、来源和完成状态', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-activity-tags-test-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
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

    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
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
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-test-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    const created = database.createChecklistItem({
      gameId: 'star-rail',
      category: 'custom',
      title: '持久化测试'
    })
    database.close()

    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    const items = database.listChecklistItems('star-rail')
    expect(items.find((item) => item.id === created.id)?.title).toBe('持久化测试')
    expect(items).toHaveLength(1)
  })

  it('批量删除只归档自定义清单内的已完成手动事项', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

  it('目录覆盖度只会由局部升级为完整，不会被后续个人增量降级', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

    expect(database.listChecklistItems('genshin').find((item) => item.id === abyss.id)).toMatchObject({
      completed: true,
      manualCompletionLocked: true,
      progressPercent: 100,
      startsAt: '2026-07-01T20:00:00.000Z',
      endsAt: '2026-07-15T20:00:00.000Z',
      recurrenceRule: null
    })
  })

  it('同步设置默认启用启动后自动同步', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    expect(database.getSyncSettings('genshin')).toMatchObject({
      autoSyncEnabled: true
    })
    expect(database.getSyncSettings('star-rail')).toMatchObject({
      autoSyncEnabled: true
    })
  })

  it('分别记录全局和版块同步时间', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

  it('启动维护已激活的公开地图目录时保留上次同步终态', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const initialCatalog = [{
      remoteKey: 'star-rail:map:test-region',
      category: 'exploration' as const,
      title: '测试一级地区',
      modeKey: 'test-region',
      mapNodeKind: 'region' as const
    }, {
      remoteKey: 'star-rail:map:test-subregion',
      category: 'exploration' as const,
      title: '测试二级地区',
      modeKey: 'test-subregion',
      mapNodeKind: 'subregion' as const,
      parentRemoteKey: 'star-rail:map:test-region'
    }]
    const successAt = new Date('2026-08-08T14:15:59.303Z')

    database.replacePublicCatalog(
      'star-rail',
      'exploration',
      initialCatalog,
      successAt.toISOString(),
      { identityPolicy: 'remote-key-only' }
    )
    database.recordCatalogCoverage('star-rail', 'exploration', 'public_schedule', 'complete')
    database.recordSyncTargetSuccess('star-rail', 'exploration', successAt)

    database.replacePublicCatalog(
      'star-rail',
      'exploration',
      initialCatalog,
      '2026-08-08T14:17:23.000Z',
      { identityPolicy: 'remote-key-only', preserveActiveSourceState: true }
    )
    database.recordCatalogCoverage('star-rail', 'exploration', 'public_schedule', 'complete')

    expect(database.getSyncTargetStates('star-rail')).toContainEqual(expect.objectContaining({
      target: 'exploration',
      lastSuccessAt: successAt.toISOString(),
      lastAttemptAt: successAt.toISOString(),
      status: 'success',
      catalogCoverage: 'complete',
      catalogSource: 'public_schedule'
    }))

    database.recordSyncTargetAttempt('star-rail', 'exploration', 'idle', successAt)
    expect(database.recoverInterruptedPublicCatalogMaintenance(
      'star-rail',
      'exploration'
    )).toBe(true)
    expect(database.getSyncTargetStates('star-rail')).toContainEqual(expect.objectContaining({
      target: 'exploration',
      lastSuccessAt: successAt.toISOString(),
      lastAttemptAt: successAt.toISOString(),
      status: 'success',
      catalogCoverage: 'complete',
      catalogSource: 'public_schedule'
    }))

    const activeAt = new Date('2026-08-08T14:20:00.000Z')
    database.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      activeAt,
      true,
      'exploration'
    )
    database.recordSyncTargetSuccess('star-rail', 'exploration', activeAt)
    database.recordSyncTargetAttempt('star-rail', 'exploration', 'idle', activeAt)
    expect(database.recoverInterruptedPublicCatalogMaintenance(
      'star-rail',
      'exploration'
    )).toBe(false)
    expect(database.getSyncTargetStates('star-rail')).toContainEqual(expect.objectContaining({
      target: 'exploration',
      lastSuccessAt: activeAt.toISOString(),
      lastAttemptAt: activeAt.toISOString(),
      status: 'idle'
    }))
  })

  it('清空回收站仅永久删除当前游戏的已归档事项', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

  it('版更校时独立更新游戏版本窗口且不创建清单事项', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    applyVersionWindow(
      database,
      'genshin',
      new Date('2026-07-24T12:00:00.000Z'),
      'genshin:version:6.0',
      '2026-07-01T02:00:00.000Z',
      '2026-08-01T02:00:00.000Z'
    )
    expect(database.getRelevantGameVersionWindow(
      'genshin', new Date('2026-07-24T12:00:00.000Z')
    )).toMatchObject({
      periodKey: 'genshin:version:6.0',
      endsAt: '2026-08-01T02:00:00.000Z'
    })

    applyVersionWindow(
      database,
      'genshin',
      new Date('2026-07-25T12:00:00.000Z'),
      'genshin:version:6.0',
      '2026-07-01T02:00:00.000Z',
      '2026-08-05T02:00:00.000Z'
    )
    expect(database.listGameVersionSummaries(new Date('2026-07-25T12:00:00.000Z'))[0])
      .toEqual({ gameId: 'genshin', endsAt: '2026-08-05T02:00:00.000Z' })
    expect(database.listChecklistItems('genshin')).toEqual([])
  })

  it('启动时迁移封闭测试期任务时间并移除旧任务事项', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-version-window-migration-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    database.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    raw.exec('PRAGMA ignore_check_constraints = ON')
    raw.prepare(`
      INSERT INTO checklist_items(
        id, game_id, category, title, starts_at, ends_at, period_key,
        timezone, source, source_url, last_synced_at, created_at, updated_at
      ) VALUES (?, 'genshin', ?, ?, ?, ?, ?, 'Asia/Shanghai',
        'public_schedule', 'https://example.com/legacy-version', ?, ?, ?)
    `).run(
      'genshin:main_quest',
      'main_quest',
      '主线任务',
      '2026-08-01T02:00:00.000Z',
      '2026-09-12T02:00:00.000Z',
      'genshin:version:legacy',
      '2026-08-05T00:00:00.000Z',
      '2026-08-01T02:00:00.000Z',
      '2026-08-05T00:00:00.000Z'
    )
    raw.close()

    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    expect(database.listChecklistItems('genshin')).toEqual([])
    expect(database.getRelevantGameVersionWindow(
      'genshin', new Date('2026-08-05T00:00:00.000Z')
    )).toEqual({
      periodKey: 'genshin:version:legacy',
      startsAt: '2026-08-01T02:00:00.000Z',
      endsAt: '2026-09-12T02:00:00.000Z'
    })
  })

  it('v1 升级到 v2 时删除系统周常并保留用户事项', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-weekly-removal-migration-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    database.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    raw.exec('PRAGMA ignore_check_constraints = ON')
    raw.exec('DELETE FROM schema_migrations; INSERT INTO schema_migrations(version) VALUES (1)')
    const insert = raw.prepare(`
      INSERT INTO checklist_items(
        id, game_id, category, title, completed, source, remote_key,
        schedule_kind, reset_weekday, timezone, created_at, updated_at
      ) VALUES (?, 'genshin', 'weekly', ?, ?, ?, ?, 'weekly', 1,
        'Asia/Shanghai', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
    `)
    insert.run('genshin:weekly', '周常', 0, 'public_schedule', 'weekly:genshin')
    insert.run('legacy-user-weekly', '用户自己的每周素材计划', 1, 'manual', null)
    insert.run('legacy-public-weekly', '旧同步周常', 0, 'public_schedule', 'weekly:legacy')
    raw.close()

    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    expect(database.listChecklistItems('genshin')).toEqual([
      expect.objectContaining({
        id: 'legacy-user-weekly',
        category: 'custom',
        title: '用户自己的每周素材计划',
        completed: true,
        source: 'manual',
        scheduleKind: null,
        remoteKey: null
      })
    ])
    database.close()
    database = null
    const verified = new DatabaseSync(databasePath)
    expect((verified.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number
    }).version).toBe(CURRENT_SCHEMA_VERSION)
    verified.close()
  })

  it('v3 升级到 v4 时保留任务历史并迁移后台 Agent 标识', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-agent-id-migration-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    database.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    raw.exec('DELETE FROM schema_migrations; INSERT INTO schema_migrations(version) VALUES (3)')
    raw.prepare(`
      INSERT INTO ai_schedule_agents(id, name, last_seen_at, created_at, updated_at)
      VALUES (?, '旧后台 Agent', ?, ?, ?)
    `).run(
      'gacha-app-background-worker-1',
      '2026-08-22T00:00:00.000Z',
      '2026-08-22T00:00:00.000Z',
      '2026-08-22T00:00:00.000Z'
    )
    raw.prepare(`
      INSERT INTO ai_schedule_jobs(
        id, game_id, scope, status, requested_at, completed_at, agent_id, updated_at
      ) VALUES (
        'legacy-agent-job', 'genshin', 'public_schedule', 'completed', ?, ?, ?, ?
      )
    `).run(
      '2026-08-22T00:00:00.000Z',
      '2026-08-22T00:05:00.000Z',
      'gacha-app-background-worker-1',
      '2026-08-22T00:05:00.000Z'
    )
    raw.prepare(`
      INSERT INTO ai_schedule_job_attempts(
        id, job_id, attempt_number, routing_tier, model, reasoning_effort,
        agent_id, started_at, completed_at, outcome
      ) VALUES (
        'legacy-agent-attempt', 'legacy-agent-job', 1, 0, 'inherit', 'inherit',
        ?, ?, ?, 'completed'
      )
    `).run(
      'gacha-app-background-worker-1',
      '2026-08-22T00:00:00.000Z',
      '2026-08-22T00:05:00.000Z'
    )
    raw.close()

    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    database.close()
    database = null
    const verified = new DatabaseSync(databasePath)
    expect(verified.prepare('SELECT id FROM ai_schedule_agents').all()).toEqual([
      { id: 'gtask-background-worker-1' }
    ])
    expect(verified.prepare(
      "SELECT agent_id AS agentId FROM ai_schedule_jobs WHERE id = 'legacy-agent-job'"
    ).get()).toEqual({ agentId: 'gtask-background-worker-1' })
    expect(verified.prepare(
      "SELECT agent_id AS agentId FROM ai_schedule_job_attempts WHERE id = 'legacy-agent-attempt'"
    ).get()).toEqual({ agentId: 'gtask-background-worker-1' })
    expect((verified.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
      version: number
    }).version).toBe(CURRENT_SCHEMA_VERSION)
    verified.close()
  })

  it('个人快照只更新基准完成状态并保护手动完成锁', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const manual = database.createChecklistItem({
      gameId: 'genshin',
      category: 'custom',
      title: '手动事项'
    })
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'endgame:spiral-abyss',
      category: 'endgame',
      title: '深境螺旋',
      completed: false,
      startsAt: '2026-07-15T20:00:00.000Z',
      endsAt: '2026-08-15T20:00:00.000Z',
      periodKey: '2026-07',
      modeKey: 'spiral-abyss'
    }])
    const remote = database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'endgame:spiral-abyss'
    )!
    database.updateChecklistItem({ id: remote.id, completed: true })

    expect(database.replacePersonalSnapshot(
      'genshin',
      'cycles',
      `miyoushe:${'a'.repeat(64)}`,
      [{
        remoteKey: 'personal:spiral-abyss',
        category: 'endgame',
        title: '深境螺旋（接口名称）',
        completed: false,
        modeKey: 'spiral-abyss',
        sourceIdentity: {
          provider: 'miyoushe',
          endpoint: 'challenge-record',
          externalId: 'spiral-abyss'
        }
      }],
      'test-personal-v1',
      new Date('2026-08-01T00:00:00.000Z')
    )).toEqual({ added: 0, updated: 0, preserved: 1 })

    const protectedRemote = database
      .listChecklistItems('genshin')
      .find((item) => item.id === remote.id)!
    expect(protectedRemote.completed).toBe(true)
    expect(protectedRemote.title).toBe('深境螺旋')
    expect(database.listChecklistItems('genshin').find((item) => item.id === manual.id)?.title).toBe(
      '手动事项'
    )
  })

  it('同步批次异常时事务回滚且不删除上次成功数据', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

  it('四款游戏的活动和地图不会因远端键变化产生重复项', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

      const items = database.listChecklistItems(gameId)
      expect(items.filter((item) => item.title === eventTitle)).toHaveLength(1)
      expect(items.filter((item) => item.title === regionTitle)).toHaveLength(1)
    }
  })

  it('启动时不会把未知周期当作到期活动删除', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'))
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-endgame-duplicate-cleanup-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
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

    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    for (const gameId of gameIds) {
      expect(database.listChecklistItems(gameId)
        .filter((item) => item.modeKey === `${gameId}:historical-mode`)).toHaveLength(2)
      expect(database.listArchivedChecklistItems(gameId)
        .filter((item) => item.modeKey === `${gameId}:historical-mode`)).toHaveLength(0)
    }
    expect(database.listChecklistItems('zenless')
      .filter((item) => item.modeKey === 'zenless:separate-period-mode')).toHaveLength(2)
  })

  it.skip('旧融合流程：个人活动按中文名和时间回填公开排期', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const gameIds = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const

    for (const gameId of gameIds) {
      const result = database.replacePersonalSnapshot(gameId, 'events', `test:${'a'.repeat(64)}`, [{
        remoteKey: `event:personal:untimed:${gameId}`,
        category: 'limited_event',
        title: `${gameId} 无时间功能条目`,
        completed: true,
        sourceIdentity: {
          provider: 'test-provider', endpoint: 'events', externalId: `untimed:${gameId}`
        }
      }], 'test-personal-v1')

      expect(result).toEqual({ added: 0, updated: 0, preserved: 1 })
      expect(database.listChecklistItems(gameId)
        .filter((item) => item.category === 'limited_event')).toHaveLength(0)
    }
  })

  it('个人快照不按历史挑战名称创建或改分类', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const cases = [
      ['genshin', '幽境危战·本期'],
      ['star-rail', '虚构叙事·本期'],
      ['zenless', '危局强袭战·本期'],
      ['wuthering-waves', '逆境深塔·本期']
    ] as const

    for (const [gameId, title] of cases) {
      const result = database.replacePersonalSnapshot(gameId, 'events', `test:${'b'.repeat(64)}`, [{
        remoteKey: `event:personal:misclassified:${gameId}`,
        category: 'limited_event',
        title,
        startsAt: '2026-07-20T02:00:00.000Z',
        endsAt: '2026-07-27T01:59:59.000Z',
        completed: true,
        sourceIdentity: {
          provider: 'test-provider', endpoint: 'events', externalId: `misclassified:${gameId}`
        }
      }], 'test-personal-v1')

      expect(result).toEqual({ added: 0, updated: 0, preserved: 1 })
      expect(database.listChecklistItems(gameId)
        .filter((item) => item.category === 'limited_event')).toHaveLength(0)
    }
  })

  it('四款游戏的未来活动都不能被个人数据提前标记完成', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const gameIds = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const

    for (const gameId of gameIds) {
      database.mergeSyncedItems(gameId, 'public_schedule', [{
        remoteKey: `event:future:${gameId}`,
        category: 'limited_event',
        title: `${gameId} 未来活动`,
        startsAt: '2026-08-01T10:00:00+08:00',
        endsAt: '2026-08-10T03:59:00+08:00'
      }], '2026-07-23T12:00:00.000Z')
      database.replacePersonalSnapshot(gameId, 'events', `test:${'c'.repeat(64)}`, [{
        remoteKey: `personal:event:future:${gameId}`,
        category: 'limited_event',
        title: `${gameId} 未来活动`,
        completed: true,
        sourceIdentity: {
          provider: 'test-provider', endpoint: 'events', externalId: `future:${gameId}`
        }
      }], 'test-personal-v1', new Date('2026-07-23T12:00:00.000Z'))

      expect(database.listChecklistItems(gameId)
        .find((item) => item.remoteKey === `event:future:${gameId}`)).toMatchObject({
          completed: false,
          progressPercent: null
        })
    }
  })

  it('把唯一匹配的个人活动明确完成状态写回公开基准行', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const reference = new Date('2026-08-09T00:00:00.000Z')
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'event:baseline:completed-overlay',
      category: 'limited_event',
      title: '个人完成状态覆盖测试',
      startsAt: '2026-07-20T00:00:00.000Z',
      endsAt: '2026-09-10T00:00:00.000Z',
      completed: false
    }], reference.toISOString())

    database.replacePersonalSnapshot(
      'genshin',
      'events',
      `miyoushe:${'a'.repeat(64)}`,
      [{
        remoteKey: 'personal-event:miyoushe:test:completed-overlay',
        category: 'limited_event',
        title: '个人完成状态覆盖测试',
        startsAt: '2026-07-20T00:00:00.000Z',
        endsAt: '2026-09-10T00:00:00.000Z',
        completed: true,
        sourceIdentity: {
          provider: 'miyoushe',
          endpoint: 'miyoushe-genshin-event-calendar',
          externalId: 'completed-overlay'
        }
      }],
      'genshin-personal-v1',
      reference
    )

    expect(database.listChecklistItems('genshin')).toContainEqual(
      expect.objectContaining({
        remoteKey: 'event:baseline:completed-overlay',
        source: 'public_schedule',
        completed: true
      })
    )
  })

  it.skip('旧融合流程：启动时保留 Codex 写入的个人活动状态', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-star-rail-completion-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
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

    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-untimed-cleanup-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
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

    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    for (const gameId of ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const) {
      expect(database.listChecklistItems(gameId)
        .some((item) => item.id === `untimed-${gameId}`)).toBe(true)
      expect(database.listArchivedChecklistItems(gameId)
        .some((item) => item.id === `untimed-${gameId}`)).toBe(false)
    }
  })

  it('启动时不再按标题关键词擅自归档疑似错位活动', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-section-cleanup-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
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

    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    expect(database.listChecklistItems('genshin')
      .some((item) => item.id === 'misclassified-stygian')).toBe(true)
    expect(database.listArchivedChecklistItems('genshin')
      .some((item) => item.id === 'misclassified-stygian')).toBe(false)
  })

  it.skip('旧融合流程：个人地图进度回填公开地图', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

  it('公开地图一级进度随二级地区修改、同步增删实时派生', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const baseMaps = [
      {
        remoteKey: 'map:fontaine',
        category: 'exploration' as const,
        title: '枫丹',
        mapNodeKind: 'region' as const
      },
      {
        remoteKey: 'map:fontaine:a',
        category: 'exploration' as const,
        title: '枫丹廷区',
        mapNodeKind: 'subregion' as const,
        parentRemoteKey: 'map:fontaine'
      },
      {
        remoteKey: 'map:fontaine:b',
        category: 'exploration' as const,
        title: '白露区',
        mapNodeKind: 'subregion' as const,
        parentRemoteKey: 'map:fontaine'
      }
    ]
    database.mergeSyncedItems('genshin', 'public_schedule', baseMaps)
    const maps = database.listChecklistItems('genshin')
    const first = maps.find((item) => item.remoteKey === 'map:fontaine:a')!
    const second = maps.find((item) => item.remoteKey === 'map:fontaine:b')!
    database.updateChecklistItem({ id: first.id, completed: true })
    expect(database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'map:fontaine'
    )).toMatchObject({ progressPercent: 50, completed: false })
    database.updateChecklistItem({ id: first.id, completed: false })
    database.updateChecklistItem({ id: first.id, progressPercent: 100 })
    database.updateChecklistItem({ id: second.id, progressPercent: 50 })
    expect(database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'map:fontaine'
    )).toMatchObject({ progressPercent: 75, completed: false })

    database.mergeSyncedItems('genshin', 'public_schedule', [
      ...baseMaps,
      {
        remoteKey: 'map:fontaine:c',
        category: 'exploration',
        title: '诺思托伊区',
        mapNodeKind: 'subregion',
        parentRemoteKey: 'map:fontaine'
      }
    ])
    expect(database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'map:fontaine'
    )).toMatchObject({ progressPercent: 50, completed: false })

    const third = database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'map:fontaine:c'
    )!
    const reference = new Date('2026-08-08T12:00:00.000Z')
    database.registerAiScheduleAgent('map-progress-agent', '地图进度测试 Agent', reference)
    const job = database.createAiScheduleJob(
      'genshin', 'public_schedule', reference, false, 'exploration'
    )
    database.claimAiScheduleJob('map-progress-agent', reference)
    database.applyAiScheduleJob(
      job.id,
      'map-progress-agent',
      [],
      [],
      reference,
      [],
      [],
      [{ itemId: third.id, reason: '测试删除已确认不存在的二级地区' }]
    )
    expect(database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'map:fontaine'
    )).toMatchObject({ progressPercent: 75, completed: false })

    const updated = database.setChecklistCompletion(second.id, true)
    expect(updated).toEqual(expect.arrayContaining([
      expect.objectContaining({ remoteKey: 'map:fontaine', progressPercent: 100, completed: true }),
      expect.objectContaining({ remoteKey: 'map:fontaine:b', progressPercent: 100, completed: true })
    ]))
  })

  it('个人地图同步优先保留一级接口值并在重启后继续保留', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-personal-map-rollup-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    const cases = [
      ['genshin', 'miyoushe', 'a'],
      ['zenless', 'miyoushe', 'b'],
      ['wuthering-waves', 'kuro-community', 'c']
    ] as const
    const reference = new Date('2026-08-23T12:00:00.000Z')

    for (const [gameId, provider, scopeCharacter] of cases) {
      const regionKey = `map:${gameId}:region`
      database.mergeSyncedItems(gameId, 'public_schedule', [
        {
          remoteKey: regionKey,
          category: 'exploration',
          title: `${gameId} 主地区`,
          mapNodeKind: 'region'
        },
        {
          remoteKey: `map:${gameId}:a`,
          category: 'exploration',
          title: `${gameId} 子地区 A`,
          mapNodeKind: 'subregion',
          parentRemoteKey: regionKey
        },
        {
          remoteKey: `map:${gameId}:b`,
          category: 'exploration',
          title: `${gameId} 子地区 B`,
          mapNodeKind: 'subregion',
          parentRemoteKey: regionKey
        }
      ], reference.toISOString())

      database.replacePersonalSnapshot(
        gameId,
        'exploration',
        `test:${scopeCharacter.repeat(64)}`,
        [
          {
            remoteKey: `personal:${gameId}:region`,
            category: 'exploration',
            title: `${gameId} 主地区`,
            mapNodeKind: 'region',
            progressPercent: 14,
            sourceIdentity: {
              provider,
              endpoint: 'personal-map-progress',
              externalId: `${gameId}-region`
            }
          },
          {
            remoteKey: `personal:${gameId}:a`,
            category: 'exploration',
            title: `${gameId} 子地区 A`,
            mapNodeKind: 'subregion',
            progressPercent: 20,
            sourceIdentity: {
              provider,
              endpoint: 'personal-map-progress',
              externalId: `${gameId}-a`
            }
          },
          {
            remoteKey: `personal:${gameId}:b`,
            category: 'exploration',
            title: `${gameId} 子地区 B`,
            mapNodeKind: 'subregion',
            progressPercent: 48,
            sourceIdentity: {
              provider,
              endpoint: 'personal-map-progress',
              externalId: `${gameId}-b`
            }
          }
        ],
        `${gameId}-personal-v1`,
        reference
      )

      expect(database.listChecklistItems(gameId).find(
        (item) => item.remoteKey === regionKey
      )).toMatchObject({ progressPercent: 14, completed: false })
    }

    database.close()
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    for (const [gameId] of cases) {
      expect(database.listChecklistItems(gameId).find(
        (item) => item.remoteKey === `map:${gameId}:region`
      )).toMatchObject({ progressPercent: 14, completed: false })
    }
  })

  it('个人地图未提供一级进度时才按二级目录平均，并在重启后保持派生值', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-personal-map-derived-region-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    const cases = [
      ['genshin', 'miyoushe', 'a'],
      ['zenless', 'miyoushe', 'b'],
      ['wuthering-waves', 'kuro-community', 'c']
    ] as const
    const reference = new Date('2026-08-23T12:00:00.000Z')

    for (const [gameId, provider, scopeCharacter] of cases) {
      const regionKey = `map:${gameId}:region`
      database.mergeSyncedItems(gameId, 'public_schedule', [
        {
          remoteKey: regionKey,
          category: 'exploration',
          title: `${gameId} 主地区`,
          mapNodeKind: 'region'
        },
        {
          remoteKey: `map:${gameId}:a`,
          category: 'exploration',
          title: `${gameId} 子地区 A`,
          mapNodeKind: 'subregion',
          parentRemoteKey: regionKey
        },
        {
          remoteKey: `map:${gameId}:b`,
          category: 'exploration',
          title: `${gameId} 子地区 B`,
          mapNodeKind: 'subregion',
          parentRemoteKey: regionKey
        }
      ], reference.toISOString())

      database.replacePersonalSnapshot(
        gameId,
        'exploration',
        `test:${scopeCharacter.repeat(64)}`,
        [
          {
            remoteKey: `personal:${gameId}:a`,
            category: 'exploration',
            title: `${gameId} 子地区 A`,
            mapNodeKind: 'subregion',
            progressPercent: 20,
            sourceIdentity: {
              provider,
              endpoint: 'personal-map-progress',
              externalId: `${gameId}-a`
            }
          },
          {
            remoteKey: `personal:${gameId}:b`,
            category: 'exploration',
            title: `${gameId} 子地区 B`,
            mapNodeKind: 'subregion',
            progressPercent: 48,
            sourceIdentity: {
              provider,
              endpoint: 'personal-map-progress',
              externalId: `${gameId}-b`
            }
          }
        ],
        `${gameId}-personal-v1`,
        reference
      )

      expect(database.listChecklistItems(gameId).find(
        (item) => item.remoteKey === regionKey
      )).toMatchObject({ progressPercent: 34, completed: false })
    }

    database.close()
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    for (const [gameId] of cases) {
      expect(database.listChecklistItems(gameId).find(
        (item) => item.remoteKey === `map:${gameId}:region`
      )).toMatchObject({ progressPercent: 34, completed: false })
    }
  })

  it('个人接口仅提供一级地图进度时重启后保留接口值', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-personal-map-region-only-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    const reference = new Date('2026-08-23T12:00:00.000Z')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    database.mergeSyncedItems('genshin', 'public_schedule', [
      {
        remoteKey: 'map:genshin:region-only',
        category: 'exploration',
        title: '只提供一级进度的地区',
        mapNodeKind: 'region'
      },
      {
        remoteKey: 'map:genshin:region-only:child',
        category: 'exploration',
        title: '未由接口提供的子地区',
        mapNodeKind: 'subregion',
        parentRemoteKey: 'map:genshin:region-only'
      }
    ], reference.toISOString())
    database.replacePersonalSnapshot(
      'genshin',
      'exploration',
      `test:${'d'.repeat(64)}`,
      [{
        remoteKey: 'personal:genshin:region-only',
        category: 'exploration',
        title: '只提供一级进度的地区',
        mapNodeKind: 'region',
        progressPercent: 86,
        sourceIdentity: {
          provider: 'miyoushe',
          endpoint: 'personal-map-progress',
          externalId: 'genshin-region-only'
        }
      }],
      'genshin-personal-v1',
      reference
    )
    expect(database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'map:genshin:region-only'
    )).toMatchObject({ progressPercent: 86, completed: false })

    database.close()
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    expect(database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'map:genshin:region-only'
    )).toMatchObject({ progressPercent: 86, completed: false })
  })

  it('启动时修复旧版公开子地图已完成但进度为零的状态', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-public-map-progress-repair-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    database.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'map:jarilo',
      category: 'exploration',
      title: '雅利洛-VI',
      mapNodeKind: 'region'
    }, {
      remoteKey: 'map:jarilo:a',
      category: 'exploration',
      title: '行政区',
      mapNodeKind: 'subregion',
      parentRemoteKey: 'map:jarilo'
    }, {
      remoteKey: 'map:jarilo:b',
      category: 'exploration',
      title: '城郊雪原',
      mapNodeKind: 'subregion',
      parentRemoteKey: 'map:jarilo'
    }])
    for (const child of database.listChecklistItems('star-rail').filter(
      (item) => item.mapNodeKind === 'subregion'
    )) {
      database.updateChecklistItem({ id: child.id, completed: true })
    }
    expect(database.listChecklistItems('star-rail').filter(
      (item) => item.mapNodeKind === 'subregion'
    ).every((item) => item.completed && item.progressPercent === 0)).toBe(true)

    database.close()
    database = null
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })

    expect(database.listChecklistItems('star-rail').find(
      (item) => item.remoteKey === 'map:jarilo'
    )).toMatchObject({ completed: true, progressPercent: 100 })
    expect(database.listChecklistItems('star-rail').filter(
      (item) => item.mapNodeKind === 'subregion'
    ).every((item) => item.completed && item.progressPercent === 100)).toBe(true)
  })

  it('挑战玩法进入新周期时复用稳定清单并重置完成状态', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    database.mergeSyncedItems('zenless', 'public_schedule', [
      {
        remoteKey: 'endgame:shiyu-defense',
        category: 'endgame',
        title: '式舆防卫战',
        startsAt: '2026-07-05T20:00:00.000Z',
        endsAt: '2026-07-19T20:00:00.000Z',
        periodKey: '2026-07-a',
        modeKey: 'shiyu-defense',
        scheduleKind: 'remote_schedule'
      }
    ])
    const item = database
      .listChecklistItems('zenless')
      .find((candidate) => candidate.remoteKey === 'endgame:shiyu-defense')!
    database.updateChecklistItem({ id: item.id, completed: true })

    expect(database.rolloverDueCycleItems(new Date('2026-07-20T00:00:00.000Z'))).toBe(1)

    const periods = database.listChecklistItems('zenless')
      .filter((candidate) => candidate.modeKey === 'shiyu-defense')
    expect(periods).toHaveLength(1)
    expect(periods[0]).toMatchObject({
      id: item.id,
      remoteKey: 'endgame:shiyu-defense',
      completed: false,
      completedAt: null,
      manualCompletionLocked: false
    })
  })

  it('启动时修复旧版用上期战绩误勾选的当期挑战', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-stale-cycle-progress-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    const currentStart = '2026-08-31T20:00:00.000Z'
    const currentEnd = '2026-09-30T20:00:00.000Z'
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'endgame:imaginarium-theater',
      category: 'endgame',
      title: '幻想真境剧诗',
      startsAt: currentStart,
      endsAt: currentEnd,
      periodKey: 'predicted:genshin:imaginarium-theater:2026-08-31T20:00:00.000Z',
      modeKey: 'imaginarium-theater',
      scheduleKind: 'remote_schedule'
    }], '2026-09-01T12:00:00.000Z')
    const theater = database.listChecklistItems('genshin').find(
      (item) => item.modeKey === 'imaginarium-theater'
    )!
    database.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    raw.prepare(`
      INSERT INTO personal_sync_snapshots(
        id, game_id, target, account_scope, adapter_version,
        item_count, activated_at, created_at
      ) VALUES ('stale-snapshot', 'genshin', 'cycles', ?, 'genshin-personal-v1', 1, ?, ?)
    `).run(`miyoushe:${'a'.repeat(64)}`, '2026-09-01T12:09:34.038Z', '2026-09-01T12:09:34.038Z')
    raw.prepare(`
      UPDATE checklist_items
      SET completed = 1, completed_at = ?, last_synced_at = ?, source_snapshot_id = ?
      WHERE id = ?
    `).run(
      '2026-09-01T12:09:34.038Z',
      '2026-09-01T12:09:34.038Z',
      'stale-snapshot',
      theater.id
    )
    raw.prepare(`
      INSERT INTO schedule_observations(
        id, game_id, target, provider, endpoint, remote_key, title,
        mode_key, period_key, starts_at, ends_at, observed_at
      ) VALUES (
        'stale-observation', 'genshin', 'cycles', 'miyoushe',
        'miyoushe-genshin-imaginarium-theater', 'endgame:imaginarium-theater',
        '幻想真境剧诗', 'imaginarium-theater', 'genshin:imaginarium-theater:28',
        '2026-07-31T20:00:00.000Z', '2026-08-31T19:59:59.000Z',
        '2026-09-01T12:09:34.045Z'
      )
    `).run()
    raw.close()

    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    expect(database.listChecklistItems('genshin').find(
      (item) => item.modeKey === 'imaginarium-theater'
    )).toMatchObject({
      completed: false,
      completedAt: null,
      startsAt: currentStart,
      endsAt: currentEnd
    })
  })

  it.skip('旧融合流程：个人战绩匹配公开挑战周期', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-version-test-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    const before = database.getDataVersion()
    const externalConnection = new AppDatabase(databasePath, { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })

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

  })

  it('按任务精确领取并只使用当前配置重试基础设施故障', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
        schemaVersion: 15,
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const startedAt = new Date('2026-07-24T10:00:00.000Z')
    database.registerAiScheduleAgent('gtask-background-worker', '后台 Codex', startedAt)
    database.createAiScheduleJob('zenless', 'public_schedule', startedAt, false, 'events')
    database.claimAiScheduleJob('gtask-background-worker', startedAt)

    expect(database.requeueClaimedAiScheduleJobsByAgent(
      'another-agent',
      new Date('2026-07-24T10:01:00.000Z')
    )).toBe(0)
    expect(database.requeueClaimedAiScheduleJobsByAgent(
      'gtask-background-worker',
      new Date('2026-07-24T10:01:00.000Z')
    )).toBe(1)
    expect(database.getActiveAiScheduleJob('zenless')).toMatchObject({
      status: 'pending',
      message: '应用已关闭，任务将在下次启动后继续'
    })
  })

  it('四个唯一 Agent 可以并行领取四个游戏的独立任务', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const startedAt = new Date('2026-07-24T10:00:00.000Z')
    const gameIds = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const
    for (const [index, gameId] of gameIds.entries()) {
      const agentId = `gtask-background-worker-${index + 1}`
      database.registerAiScheduleAgent(agentId, `后台 Codex ${index + 1}`, startedAt)
      database.createAiScheduleJob(gameId, 'public_schedule', startedAt, false, 'all')
    }

    const claimed = gameIds.map((_gameId, index) =>
      database!.claimAiScheduleJob(
        `gtask-background-worker-${index + 1}`,
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

  it('后续全局同步也会保存已核验版块并继续追查缺失版块', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
          remoteKey: 'wuthering-waves:event:test',
          category: 'limited_event',
          title: '已核验限时活动',
          activityTags: ['战斗', '挑战', '剧情'],
          startsAt: '2026-07-20T10:00:00+08:00',
          endsAt: '2026-08-01T03:59:59+08:00'
        }
      ],
      [],
      reference,
      [],
      [],
      [],
      'zh-CN',
      {
        periodKey: 'wuthering-waves:version:3.5',
        startsAt: '2026-07-02T10:00:00+08:00',
        endsAt: '2026-08-13T05:59:59+08:00',
        timeZone: 'Asia/Shanghai',
        sourceUrl: 'https://example.com/wuthering-waves-version',
        confidence: 0.9
      }
    )

    expect(result.job).toMatchObject({
      status: 'claimed',
      progressPhase: 'retrying',
      message: expect.stringContaining('继续检索周期、地图')
    })
    expect(result.remainingTargets).toEqual(['cycles', 'exploration'])
    expect(database.getSyncSettings('wuthering-waves')).toMatchObject({
      status: 'stale',
      lastSuccessAt: null,
      message: expect.stringContaining('继续检索周期、地图')
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
          remoteKey: 'wuthering-waves:event:test',
          category: 'limited_event',
          title: '首次同步活动',
          activityTags: ['战斗', '挑战', '剧情'],
          startsAt: '2026-07-20T10:00:00+08:00',
          endsAt: '2026-08-01T03:59:59+08:00'
        }
      ],
      [],
      reference,
      [],
      [],
      [],
      'zh-CN',
      {
        periodKey: 'wuthering-waves:version:3.5',
        startsAt: '2026-07-02T10:00:00+08:00',
        endsAt: '2026-08-13T05:59:59+08:00',
        timeZone: 'Asia/Shanghai',
        sourceUrl: 'https://example.com/wuthering-waves-version',
        confidence: 0.9
      }
    )

    expect(partial.job).toMatchObject({
      status: 'claimed',
      progressPhase: 'retrying',
      message: expect.stringContaining('继续检索周期、地图')
    })
    expect(partial.remainingTargets).toEqual(['cycles', 'exploration'])
    expect(database.listChecklistItems('wuthering-waves').map((item) => item.title))
      .toContain('首次同步活动')

    const completed = database.applyAiScheduleJob(
      queued.id,
      'agent-initial-all',
      [
        {
          remoteKey: 'endgame:tower-of-adversity',
          category: 'endgame',
          title: '逆境深塔',
          modeKey: 'tower-of-adversity',
          periodKey: '2026-07',
          startsAt: '2026-07-20T04:00:00+08:00',
          endsAt: '2026-08-03T03:59:59+08:00'
        },
        {
          remoteKey: 'endgame:whimpering-wastes',
          category: 'endgame',
          title: '冥歌海墟',
          modeKey: 'whimpering-wastes',
          periodKey: '2026-07',
          startsAt: '2026-07-20T04:00:00+08:00',
          endsAt: '2026-08-03T03:59:59+08:00'
        },
        {
          remoteKey: 'endgame:endstate-matrix',
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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

  it('原神周期同步接受 Codex 判定的清单', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
        remoteKey: 'endgame:stygian-onslaught',
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
      .filter((item) => item.category === 'endgame')
    expect(cycles.map((item) => item.modeKey).filter(Boolean).sort()).toEqual([
      'stygian-onslaught'
    ])
  })

  it('四款游戏的周期同步都不使用硬编码玩法目录否决 Codex', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
        })
      ]))
    }
  })

  it.skip('旧融合流程：个人地图只补充公开目录探索度', () => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-newer-schema-test-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    database.close()
    database = null

    const newerDatabase = new DatabaseSync(databasePath)
    newerDatabase.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(CURRENT_SCHEMA_VERSION + 1)
    newerDatabase.close()

    expect(() => new AppDatabase(databasePath, { seedBundledBaselines: false })).toThrow(
      `期望 ${CURRENT_SCHEMA_VERSION}，实际 ${CURRENT_SCHEMA_VERSION + 1}`
    )
  })
})
