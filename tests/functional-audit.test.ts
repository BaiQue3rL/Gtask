import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { extractGenshinExplorationProgressCandidates, parseGenshinPersonalData } from '../src/main/sync/genshin-personal-parser'
import { parseStarRailPersonalData } from '../src/main/sync/star-rail-personal-parser'
import { parseZenlessPersonalData } from '../src/main/sync/zenless-personal-parser'
import { parseWutheringWavesPersonalData } from '../src/main/sync/wuthering-waves-personal-parser'
import { listCycleModes, predictCycleWindow } from '../src/main/sync/cycle-catalog'
import { RemoteCatalogUpdateService, parseRemoteCatalogFeed } from '../src/main/remote-catalog-update'
import { CredentialBackedAdapter } from '../src/main/sync/credential-backed-adapter'
import { SyncOrchestrator } from '../src/main/sync/orchestrator'
import { SoftwareUpdateService } from '../src/main/software-update'

afterEach(() => vi.useRealTimers())

describe('functional audit regressions', () => {
  it('calibration preserves this period, future replacement is rejected, and old windows cannot rewind it', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'))
    const db = new AppDatabase(':memory:')
    try {
      const original = db.listChecklistItems('genshin').find((item) => item.modeKey === 'spiral-abyss')!
      db.updateChecklistItem({ id: original.id, completed: true })
      const extendedEnd = new Date(Date.parse(original.endsAt!) + 2 * 3_600_000).toISOString()
      const item = { remoteKey: original.remoteKey!, title: original.title, category: 'endgame' as const,
        modeKey: original.modeKey, periodKey: original.periodKey, startsAt: original.startsAt, endsAt: extendedEnd }
      db.mergeSyncedItems('genshin', 'public_schedule', [item])
      expect(db.getChecklistItem(original.id).completed).toBe(true)
      expect(() => db.mergeSyncedItems('genshin', 'public_schedule', [{ ...item,
        periodKey: 'audit.future', startsAt: extendedEnd,
        endsAt: new Date(Date.parse(extendedEnd) + 28 * 86_400_000).toISOString()
      }])).toThrow('未来期次不能覆盖')
      vi.setSystemTime(new Date(extendedEnd))
      db.rolloverDueCycleItems()
      db.updateChecklistItem({ id: original.id, completed: true })
      const advanced = db.getChecklistItem(original.id)
      db.mergeSyncedItems('genshin', 'public_schedule', [{ ...item, endsAt: original.endsAt }])
      expect(db.getChecklistItem(original.id)).toMatchObject({
        startsAt: advanced.startsAt, endsAt: advanced.endsAt, periodKey: advanced.periodKey, completed: true
      })
    } finally { db.close() }
  })

  it('reordered side towers cannot turn inherited lower floors into manual participation', () => {
    const tower = { difficultyList: [{ difficultyName: '深境区', towerAreaList: [
      { areaName: '深境之塔', floorList: [] },
      { areaName: '残响之塔', floorList: [{ floor: 1, star: 3, hasRecord: true }] },
      { areaName: '回音之塔', floorList: [] }
    ] }] }
    expect(parseWutheringWavesPersonalData({ tower })[0].completed).toBe(false)
    expect(parseWutheringWavesPersonalData({ tower: { difficultyList: [{ difficultyName: '深境区' }] } })[0].completed)
      .toBeUndefined()
  })

  it('undated cached progress cannot complete the next period during a gap', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'))
    const db = new AppDatabase(':memory:')
    try {
      const baseline = db.listChecklistItems('genshin').find((item) => item.modeKey === 'spiral-abyss')!
      db.mergeSyncedItems('genshin', 'public_schedule', [{ remoteKey: baseline.remoteKey!, title: baseline.title,
        category: 'endgame', modeKey: baseline.modeKey, periodKey: baseline.periodKey,
        startsAt: '2026-09-15T12:00:00Z', endsAt: '2026-10-15T12:00:00Z' }])
      db.replacePersonalSnapshot('genshin', 'cycles', `miyoushe:${'a'.repeat(64)}`, [{
        remoteKey: baseline.remoteKey!, title: baseline.title, category: 'endgame', modeKey: baseline.modeKey,
        completed: true, sourceIdentity: { provider: 'miyoushe', endpoint: 'audit', externalId: '1' }
      }], 'audit')
      expect(db.getChecklistItem(baseline.id).completed).toBe(false)
    } finally { db.close() }
  })

  it('unknown observations preserve completion, while explicit empty results can correct it', () => {
    const db = new AppDatabase(':memory:')
    try {
      const baseline = db.listChecklistItems('genshin').find((item) => item.modeKey === 'spiral-abyss')!
      const apply = (completed: boolean | undefined) => db.replacePersonalSnapshot('genshin', 'cycles',
        `miyoushe:${'a'.repeat(64)}`, [{ remoteKey: baseline.remoteKey!, title: baseline.title,
          category: 'endgame', modeKey: baseline.modeKey, completed,
          sourceIdentity: { provider: 'miyoushe', endpoint: 'audit', externalId: '1' } }], 'audit')
      apply(true)
      apply(undefined)
      expect(db.getChecklistItem(baseline.id).completed).toBe(true)
      apply(false)
      expect(db.getChecklistItem(baseline.id).completed).toBe(false)
    } finally { db.close() }
  })

  it('publishing an actual new period clears prior completion and its manual lock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'))
    const db = new AppDatabase(':memory:')
    try {
      const baseline = db.listChecklistItems('genshin').find((item) => item.modeKey === 'spiral-abyss')!
      db.updateChecklistItem({ id: baseline.id, completed: true })
      const nextStart = baseline.endsAt!
      vi.setSystemTime(new Date(nextStart))
      db.mergeSyncedItems('genshin', 'public_schedule', [{
        remoteKey: baseline.remoteKey!, title: baseline.title, category: 'endgame', modeKey: baseline.modeKey,
        periodKey: 'audit.next', startsAt: nextStart,
        endsAt: new Date(Date.parse(nextStart) + 28 * 86_400_000).toISOString()
      }])
      expect(db.getChecklistItem(baseline.id)).toMatchObject({ completed: false, manualCompletionLocked: false })
    } finally { db.close() }
  })

  it('logging out during a request discards its account result', async () => {
    let credential: { kind: 'cookie'; value: string } | null = {
      kind: 'cookie', value: 'account_id_v2=123; cookie_token_v2=test'
    }
    const adapter = new CredentialBackedAdapter('miyoushe', { read: () => credential }, () => ({
      sync: async () => { credential = null; return { items: [], message: 'old result' } }
    }))
    await expect(adapter.sync('genshin', 'cycles')).rejects.toThrow()
  })

  it('a stale reachable mirror cannot conceal a newer official software release', async () => {
    const service = new SoftwareUpdateService('1.1.1', [
      { id: 'gitee', configured: true, check: async () => ({ version: '1.1.1', releaseUrl: null }) },
      { id: 'github', configured: true, check: async () => ({ version: '1.1.2', releaseUrl: 'https://example.com/release' }) }
    ])
    expect(await service.check()).toMatchObject({ outcome: 'update_available', latestVersion: '1.1.2' })
  })

  it('invalid schedule observations cannot leave a failed sync partially applied', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'))
    const db = new AppDatabase(':memory:')
    try {
      const baseline = db.listChecklistItems('genshin').find((item) => item.modeKey === 'spiral-abyss')!
      const orchestrator = new SyncOrchestrator(db, { publicSchedule: {}, personalData: { genshin: {
        sync: async () => ({
          items: [{ remoteKey: baseline.remoteKey!, title: baseline.title, category: 'endgame',
            modeKey: baseline.modeKey, completed: true,
            sourceIdentity: { provider: 'miyoushe', endpoint: 'audit', externalId: '1' } }],
          accountScope: `miyoushe:${'a'.repeat(64)}`, adapterVersion: 'audit', message: 'test',
          snapshotCompleteness: 'complete',
          scheduleObservations: [{ provider: 'miyoushe', endpoint: 'audit', target: 'events',
            remoteKey: 'audit', title: 'wrong target', modeKey: null, periodKey: null,
            startsAt: baseline.startsAt, endsAt: baseline.endsAt }]
        })
      } } })
      const result = await orchestrator.syncPersonalOnly('genshin', 'cycles')
      expect(result.status).toBe('error')
      expect(result.sources[0].message).toContain('不一致')
      expect(db.getChecklistItem(baseline.id).completed).toBe(false)
    } finally { db.close() }
  })

  it('reopening preserves published corrections and retired bundled maps', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-14T12:00:00Z'))
    const directory = mkdtempSync(join(tmpdir(), 'gtask-audit-reopen-'))
    const path = join(directory, 'test.sqlite')
    let db = new AppDatabase(path)
    try {
      const maps = db.listChecklistItems('genshin').filter((item) => item.mapNodeKind === 'subregion')
      const changed = maps[0]
      const retired = maps[1]
      const cycle = db.listChecklistItems('star-rail').find((item) => item.modeKey === 'pure-fiction')!
      const correctedEnd = new Date(Date.parse(cycle.endsAt!) + 7 * 86_400_000).toISOString()
      db.applyRemoteCatalogFeed(parseRemoteCatalogFeed({
        schemaVersion: 1, revision: 'audit.restart', publishedAt: '2026-09-14T11:00:00Z',
        games: [
          { gameId: 'genshin', upserts: [{
            remoteKey: changed.remoteKey, title: '已核实的新名称', category: 'exploration',
            mapNodeKind: 'subregion', parentRemoteKey: changed.parentRemoteKey,
            parentTitle: changed.parentTitle, sourceUrl: 'https://example.com/correction'
          }], archives: [retired.remoteKey] },
          { gameId: 'star-rail', upserts: [{
            remoteKey: cycle.remoteKey, modeKey: cycle.modeKey, periodKey: cycle.periodKey,
            category: 'endgame', title: cycle.title, startsAt: cycle.startsAt, endsAt: correctedEnd,
            sourceUrl: 'https://example.com/exception'
          }], archives: [] }
        ]
      }))
      db.close()
      db = new AppDatabase(path)
      expect(db.getChecklistItem(changed.id).title).toBe('已核实的新名称')
      expect(db.listChecklistItems('genshin').some((item) => item.remoteKey === retired.remoteKey)).toBe(false)
      expect(db.getChecklistItem(cycle.id).endsAt).toBe(correctedEnd)
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('a delayed cumulative feed can include a formerly valid version exception', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-15T12:00:00Z'))
    const db = new AppDatabase(':memory:')
    try {
      expect(() => db.applyRemoteCatalogFeed(parseRemoteCatalogFeed({
        schemaVersion: 1, revision: 'audit.delayed-feed', publishedAt: '2026-09-14T11:00:00Z',
        games: [{ gameId: 'genshin', upserts: [], archives: [], versionWindow: {
          periodKey: 'audit.version', startsAt: '2026-09-01T04:00:00+08:00',
          endsAt: '2026-10-01T04:00:00+08:00', timeZone: 'Asia/Shanghai',
          sourceUrl: 'https://example.com/exception', confidence: 1
        } }]
      }))).not.toThrow()
    } finally { db.close() }
  })

  it('missing completion evidence is unknown across all personal parsers', () => {
    const start = '2026-09-01T04:00:00+08:00'
    const end = '2026-10-01T04:00:00+08:00'
    const items = [
      ...parseGenshinPersonalData({ spiralAbyss: { schedule_id: 1, start_time: start, end_time: end } }),
      ...parseStarRailPersonalData({ memoryOfChaos: { schedule_id: 1, begin_time: start, end_time: end } }),
      ...parseZenlessPersonalData({ shiyuDefense: { schedule_id: 1 }, deadlyAssault: { id: 1 } }),
      ...parseWutheringWavesPersonalData({ tower: {}, slash: {}, matrix: {} })
    ]
    expect(items.map((item) => [item.modeKey, item.completed])).toEqual(
      items.map((item) => [item.modeKey, undefined])
    )
  })

  it('malformed lists and empty time objects do not fabricate a zero-record observation', () => {
    const window = { schedule_id: 1, begin_time: '2026-09-01T04:00:00+08:00', end_time: '2026-10-01T04:00:00+08:00' }
    for (const all_floor_detail of [[null], [{ node_1: { challenge_time: {} } }]]) {
      expect(parseStarRailPersonalData({ memoryOfChaos: { ...window, all_floor_detail } })[0].completed).toBeUndefined()
    }
    expect(parseZenlessPersonalData({ deadlyAssault: { id: 1, challenges: [null] } })[0].completed).toBeUndefined()
  })

  it('an explicit zero region value survives parsing even when every child is complete', () => {
    const profile = { world_explorations: [
      { id: 1, name: '璃月', exploration_percentage: 0 },
      { id: 2, name: '沉玉谷', parent_id: 1, exploration_percentage: 1000 }
    ] }
    expect(parseGenshinPersonalData({ profile })[0]).toMatchObject({ progressPercent: 0, completed: false })
    expect(extractGenshinExplorationProgressCandidates(profile)[0].payload.observedProgress).toBe(0)
  })

  it('same revision with different mirror content uses GitHub facts', async () => {
    const makeFeed = (title: string) => parseRemoteCatalogFeed({
      schemaVersion: 1, revision: 'audit.same-revision', publishedAt: '2026-09-14T10:00:00Z',
      games: [{ gameId: 'genshin', upserts: [{
        remoteKey: 'audit:event', title, category: 'limited_event', activityTags: ['战斗'],
        startsAt: '2026-09-01T04:00:00+08:00', endsAt: '2026-10-01T04:00:00+08:00',
        sourceUrl: 'https://example.com/official-event'
      }], archives: [] }]
    })
    const service = new RemoteCatalogUpdateService([
      { id: 'gitee', configured: true, load: async () => makeFeed('镜像错误标题') },
      { id: 'github', configured: true, load: async () => makeFeed('正确标题') }
    ])
    expect(await service.check(undefined, new Date('2026-09-14T12:00:00Z'))).toMatchObject({
      providerId: 'github', feed: { games: [{ upserts: [{ title: '正确标题' }] }] }
    })
  })

  it('interval modes keep their phase and gap across two years of boundaries', () => {
    for (const gameId of ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const) {
      for (const mode of listCycleModes(gameId)) {
        if (mode.prediction.kind !== 'interval') continue
        const { anchorStartsAt, cadenceDays, durationDays } = mode.prediction
        const cadence = cadenceDays * 86_400_000
        const duration = durationDays * 86_400_000
        const anchor = Date.parse(anchorStartsAt)
        for (let period = 0; period < Math.ceil(732 / cadenceDays); period++) {
          const start = anchor + period * cadence
          const active = predictCycleWindow(mode, new Date(start))!
          expect(Date.parse(active.startsAt)).toBe(start)
          expect(Date.parse(active.endsAt)).toBe(start + duration)
          const after = predictCycleWindow(mode, new Date(start + duration))!
          expect(Date.parse(after.startsAt)).toBe(start + cadence)
          expect(Date.parse(after.startsAt) - (start + duration)).toBe(cadence - duration)
        }
      }
    }
  })
})
