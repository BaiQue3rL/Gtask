import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../src/main/database'
import {
  RemoteCatalogUpdateService,
  createDefaultRemoteCatalogProviders,
  parseRemoteCatalogFeed,
  readRemoteCatalogUpdateState,
  writeRemoteCatalogUpdateState,
  type RemoteCatalogFeed
} from '../src/main/remote-catalog-update'

const reference = new Date('2026-08-11T12:30:00.000Z')
const startsAt = '2026-08-11T12:00:00.000Z'
const endsAt = '2026-08-18T12:00:00.000Z'
const sourceUrl = 'https://github.com/BaiQue3rL/Gtask/blob/main/updates/catalog.json'

let database: AppDatabase | null = null
const temporaryDirectories: string[] = []

afterEach(() => {
  database?.close()
  database = null
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function event(remoteKey = 'hot-test:genshin:events') {
  return {
    remoteKey,
    category: 'limited_event' as const,
    title: '测试',
    startsAt,
    endsAt,
    activityTags: ['combat'],
    scheduleKind: 'fixed_window' as const,
    timeZone: 'Asia/Shanghai',
    sourceUrl
  }
}

function feed(
  revision: string,
  publishedAt: string,
  games: RemoteCatalogFeed['games'] = [{
    gameId: 'genshin',
    upserts: [event()],
    archives: []
  }]
): RemoteCatalogFeed {
  return parseRemoteCatalogFeed({
    schemaVersion: 1,
    revision,
    publishedAt,
    games
  })
}

describe('remote catalog update', () => {
  it('publishes only the verified cross-game deltas and retracts invalid period-scoped cycle cards', () => {
    const checkedIn = parseRemoteCatalogFeed(JSON.parse(
      readFileSync(join(process.cwd(), 'updates', 'catalog.json'), 'utf8')
    ))
    expect(checkedIn.games).toHaveLength(4)
    const archivedKeys = new Set<string>()
    for (const game of checkedIn.games) {
      expect(game.versionWindow).toBeUndefined()
      const expectedArchives = [
        `hot-update-test:${game.gameId}:events:v1`,
        `hot-update-test:${game.gameId}:cycles:v1`,
        `hot-update-test:${game.gameId}:exploration:v1`
      ]
      if (game.gameId === 'genshin') {
        expectedArchives.push(
          'endgame:spiral-abyss:2026-08-16',
          'endgame:imaginarium-theater:2026-09-01'
        )
      }
      expect(game.archives).toEqual(expectedArchives)
      for (const remoteKey of game.archives) archivedKeys.add(remoteKey)

      if (game.gameId === 'genshin') {
        expect(game.upserts).toEqual(expect.arrayContaining([
          expect.objectContaining({ title: '砺行修远', category: 'limited_event' }),
          expect.objectContaining({ title: '新芽相助·初探雪原', category: 'limited_event' }),
          expect.objectContaining({ title: '险境征者争锋大赛', category: 'limited_event' }),
          expect.objectContaining({ title: '至冬', mapNodeKind: 'region' }),
          expect.objectContaining({
            title: '古兽冰原',
            mapNodeKind: 'subregion',
            parentTitle: '至冬'
          })
        ]))
        expect(game.upserts.filter((item) => item.category === 'endgame')).toEqual([
          expect.objectContaining({
            remoteKey: 'endgame:stygian-onslaught',
            modeKey: 'stygian-onslaught'
          })
        ])
      } else if (game.gameId === 'zenless') {
        expect(game.upserts).toEqual([
          expect.objectContaining({
            remoteKey: 'event:3.1:return-to-ridu',
            title: '回归丽都：羽落重逢'
          })
        ])
      } else if (game.gameId === 'wuthering-waves') {
        expect(game.upserts).toHaveLength(6)
        expect(game.upserts.map((item) => item.title)).toEqual([
          '群声共振模拟域',
          '第二索拉・诡影迷踪',
          '清弦纪流年',
          '若梦仍有回声',
          '潮汐觅闻',
          '烟云赠礼'
        ])
      } else {
        expect(game.upserts).toEqual([])
      }
    }
    expect(archivedKeys.size).toBe(14)
  })

  it('rejects period-scoped keys and duplicate rows for a known recurring mode', () => {
    const cycle = {
      remoteKey: 'endgame:spiral-abyss:2026-08-16',
      category: 'endgame' as const,
      title: '深境螺旋',
      startsAt: '2026-08-16T04:00:00+08:00',
      endsAt: '2026-09-16T04:00:00+08:00',
      modeKey: 'spiral-abyss',
      periodKey: 'genshin:spiral-abyss:2026-08-16',
      scheduleKind: 'remote_schedule' as const,
      timeZone: 'Asia/Shanghai',
      sourceUrl
    }

    expect(() => parseRemoteCatalogFeed({
      schemaVersion: 1,
      revision: 'invalid-period-scoped-cycle-key',
      publishedAt: '2026-08-13T23:02:31+08:00',
      games: [{ gameId: 'genshin', upserts: [cycle], archives: [] }]
    })).toThrow(/必须使用稳定键/)

    expect(() => database = new AppDatabase(':memory:')).not.toThrow()
    expect(() => database!.mergeSyncedItems(
      'genshin',
      'public_schedule',
      [cycle],
      '2026-08-13T15:02:31.000Z'
    )).toThrow(/不能按期次新建卡片/)
  })

  it('removes only the explicitly retracted public cards', () => {
    const checkedIn = parseRemoteCatalogFeed(JSON.parse(
      readFileSync(join(process.cwd(), 'updates', 'catalog.json'), 'utf8')
    ))
    const retraction = parseRemoteCatalogFeed({
      schemaVersion: 1,
      revision: 'hot-update-test-retraction-only',
      publishedAt: checkedIn.publishedAt,
      games: checkedIn.games.map((game) => ({
        gameId: game.gameId,
        upserts: [],
        archives: game.archives
      }))
    })
    const initial = parseRemoteCatalogFeed({
      schemaVersion: 1,
      revision: '2026-08-11.hot-update-test.1',
      publishedAt: '2026-08-11T20:35:00+08:00',
      games: retraction.games.map((game) => ({
        gameId: game.gameId,
        upserts: game.archives.map((remoteKey) => {
          const common = {
            remoteKey,
            title: '测试',
            startsAt: '2026-08-11T00:00:00+08:00',
            endsAt: '2026-08-18T21:00:00+08:00',
            timeZone: 'Asia/Shanghai',
            sourceUrl
          }
          if (remoteKey.includes(':events:')) {
            return {
              ...common,
              category: 'limited_event',
              activityTags: ['combat'],
              scheduleKind: 'fixed_window'
            }
          }
          if (remoteKey.includes(':cycles:')) {
            return {
              ...common,
              category: 'endgame',
              modeKey: 'hot-update-test',
              periodKey: 'hot-update-test:2026-08-11',
              scheduleKind: 'fixed_window'
            }
          }
          return {
            ...common,
            category: 'exploration',
            mapNodeKind: 'region'
          }
        }),
        archives: []
      }))
    })

    database = new AppDatabase(':memory:')
    const custom = database.createChecklistItem({
      gameId: 'genshin',
      category: 'custom',
      title: '保留的自定义项目'
    })
    database.applyRemoteCatalogFeed(initial, reference)
    expect(retraction.games.flatMap((game) => database!.listChecklistItems(game.gameId)
      .filter((item) => item.remoteKey?.startsWith('hot-update-test:')))).toHaveLength(12)

    expect(database.applyRemoteCatalogFeed(retraction, new Date('2026-08-11T13:00:00.000Z')))
      .toMatchObject({ added: 0, updated: 0, archived: 14 })
    expect(retraction.games.flatMap((game) => database!.listChecklistItems(game.gameId)
      .filter((item) => item.remoteKey?.startsWith('hot-update-test:')))).toEqual([])
    expect(database.getChecklistItem(custom.id)).toMatchObject({
      title: '保留的自定义项目',
      source: 'manual'
    })
  })

  it('rejects personal state and custom items at the transport boundary', () => {
    expect(() => parseRemoteCatalogFeed({
      schemaVersion: 1,
      revision: 'invalid-personal-state',
      publishedAt: reference.toISOString(),
      games: [{
        gameId: 'genshin',
        upserts: [{ ...event(), completed: true }],
        archives: []
      }]
    })).toThrow()

    expect(() => parseRemoteCatalogFeed({
      schemaVersion: 1,
      revision: 'invalid-custom-item',
      publishedAt: reference.toISOString(),
      games: [{
        gameId: 'genshin',
        upserts: [{
          remoteKey: 'hot-test:genshin:custom',
          category: 'custom',
          title: '测试',
          sourceUrl
        }],
        archives: []
      }]
    })).toThrow()
  })

  it('uses authoritative GitHub on mirror divergence and refuses to regress local state', async () => {
    const giteeFeed = feed('gitee-divergent', '2026-08-11T12:10:00.000Z')
    const githubFeed = feed('github-current', '2026-08-11T12:00:00.000Z')
    const fetcher = vi.fn(async (input: string | Request) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(
        input.toString().includes('gitee.com') ? giteeFeed : githubFeed
      )
    }))
    const service = new RemoteCatalogUpdateService(
      createDefaultRemoteCatalogProviders({ fetcher })
    )

    await expect(service.check(undefined, reference)).resolves.toMatchObject({
      providerId: 'github',
      feed: { revision: 'github-current' }
    })
    await expect(service.check({
      revision: 'future-local',
      publishedAt: '2026-08-11T12:15:00.000Z',
      providerId: 'github',
      lastAutomaticCheckAt: null,
      lastSuccessfulManualCheckAt: null
    }, reference)).resolves.toBeNull()
  })

  it('does not reapply an already installed revision', async () => {
    const current = feed('current', '2026-08-11T12:00:00.000Z')
    const service = new RemoteCatalogUpdateService([{
      id: 'current',
      configured: true,
      load: async () => current
    }])

    await expect(service.check({
      revision: 'current',
      publishedAt: '2026-08-11T12:00:00.000Z',
      providerId: 'current',
      lastAutomaticCheckAt: null,
      lastSuccessfulManualCheckAt: null
    }, reference)).resolves.toBeNull()
  })

  it('reports a failed check when every configured source is unavailable', async () => {
    const service = new RemoteCatalogUpdateService([{
      id: 'offline',
      configured: true,
      load: async () => { throw new Error('offline') }
    }])

    await expect(service.check(undefined, reference)).rejects.toThrow(
      '暂时无法连接公共清单源'
    )
  })

  it('persists only normalized non-secret update metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtask-remote-catalog-state-'))
    temporaryDirectories.push(directory)
    const filePath = join(directory, 'nested', 'state.json')
    const written = writeRemoteCatalogUpdateState(filePath, {
      revision: ' test-1 ',
      publishedAt: '2026-08-11T20:00:00+08:00',
      providerId: ' github ',
      lastAutomaticCheckAt: '2026-08-11T19:30:00+08:00',
      lastSuccessfulManualCheckAt: '2026-08-11T19:00:00+08:00'
    })

    expect(written).toEqual({
      revision: 'test-1',
      publishedAt: '2026-08-11T12:00:00.000Z',
      providerId: 'github',
      lastAutomaticCheckAt: '2026-08-11T11:30:00.000Z',
      lastSuccessfulManualCheckAt: '2026-08-11T11:00:00.000Z'
    })
    expect(readRemoteCatalogUpdateState(filePath)).toEqual(written)
  })

  it('reuses the user-selected repository policy without adding hidden fallbacks', () => {
    expect(createDefaultRemoteCatalogProviders({ source: 'gitee' }).map(({ id }) => id))
      .toEqual(['override', 'gitee'])
    expect(createDefaultRemoteCatalogProviders({ source: 'github' }).map(({ id }) => id))
      .toEqual(['override', 'github'])
    expect(createDefaultRemoteCatalogProviders({ source: 'auto' }).map(({ id }) => id))
      .toEqual(['override', 'gitee', 'github'])
  })

  it('preserves user completion when a remote system card is updated', () => {
    database = new AppDatabase(':memory:')
    database.applyRemoteCatalogFeed(feed('test-1', reference.toISOString()), reference)
    const created = database.listChecklistItems('genshin').find(
      (item) => item.remoteKey === 'hot-test:genshin:events'
    )
    expect(created).toBeDefined()
    database.setChecklistCompletion(created!.id, true)

    const renamed = feed('test-2', '2026-08-11T12:20:00.000Z', [{
      gameId: 'genshin',
      upserts: [{ ...event(), title: '测试（更新）' }],
      archives: []
    }])
    database.applyRemoteCatalogFeed(renamed, reference)

    expect(database.getChecklistItem(created!.id)).toMatchObject({
      title: '测试（更新）',
      completed: true,
      manualCompletionLocked: true,
      source: 'public_schedule'
    })
  })

  it('rolls back every game when one remote map hierarchy is invalid', () => {
    database = new AppDatabase(':memory:')
    const invalid = feed('invalid-map-parent', reference.toISOString(), [
      {
        gameId: 'genshin',
        upserts: [event('hot-test:rollback:event')],
        archives: []
      },
      {
        gameId: 'star-rail',
        upserts: [{
          remoteKey: 'hot-test:rollback:subregion',
          category: 'exploration',
          title: '测试',
          mapNodeKind: 'subregion',
          parentRemoteKey: 'hot-test:missing-parent',
          startsAt,
          endsAt,
          timeZone: 'Asia/Shanghai',
          sourceUrl
        }],
        archives: []
      }
    ])

    expect(() => database!.applyRemoteCatalogFeed(invalid, reference)).toThrow()
    expect(database.listChecklistItems('genshin').some(
      (item) => item.remoteKey === 'hot-test:rollback:event'
    )).toBe(false)
    expect(database.listChecklistItems('star-rail').some(
      (item) => item.remoteKey === 'hot-test:rollback:subregion'
    )).toBe(false)
  })
})
