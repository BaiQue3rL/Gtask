import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { activityTagsMeetQualityContract } from '../src/main/activity-tags'
import { SUPPORTED_GAME_IDS } from '../src/shared/contracts'
import {
  BUNDLED_BASELINE_VERIFIED_AT,
  getBundledActivityCatalog,
  getBundledVersionWindow
} from '../src/main/sync/baseline-catalog'
import {
  CYCLE_MODE_CATALOG,
  completeCycleCatalog,
  predictCycleWindow
} from '../src/main/sync/cycle-catalog'

let database: AppDatabase | null = null
let temporaryDirectory: string | null = null

afterEach(() => {
  vi.useRealTimers()
  database?.close()
  database = null
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe('bundled baseline catalog', () => {
  it('seeds every built-in section for every supported game', () => {
    database = new AppDatabase(':memory:')
    for (const gameId of SUPPORTED_GAME_IDS) {
      const items = database.listChecklistItems(gameId)
      expect(items.some((item) => item.category === 'limited_event')).toBe(true)
      expect(items.some((item) => item.category === 'endgame')).toBe(true)
      expect(items.some((item) => item.category === 'exploration')).toBe(true)
      expect(items.filter((item) => item.category !== 'custom')
        .every((item) => item.source === 'public_schedule')).toBe(true)
    }
  })

  it('ships valid current version windows and activity identities', () => {
    expect(Number.isNaN(Date.parse(BUNDLED_BASELINE_VERIFIED_AT))).toBe(false)
    for (const gameId of SUPPORTED_GAME_IDS) {
      const window = getBundledVersionWindow(gameId)
      expect(Date.parse(window.startsAt)).toBeLessThan(Date.parse(window.endsAt))
      const activities = getBundledActivityCatalog(gameId)
      expect(new Set(activities.map((item) => item.remoteKey)).size).toBe(activities.length)
      expect(activities.every((item) =>
        Boolean(item.startsAt) &&
        Boolean(item.endsAt) &&
        Date.parse(item.startsAt!) < Date.parse(item.endsAt!)
      )).toBe(true)
      expect(activities.every((item) =>
        activityTagsMeetQualityContract(item.activityTags ?? [])
      )).toBe(true)
    }
  })

  it('seeds a concrete current time window for every recurring challenge', () => {
    database = new AppDatabase(':memory:')
    for (const gameId of SUPPORTED_GAME_IDS) {
      const cycles = database.listChecklistItems(gameId).filter(
        (item) => item.category === 'endgame'
      )
      expect(cycles.length).toBeGreaterThan(0)
      expect(cycles.every((item) =>
        Boolean(item.startsAt) &&
        Boolean(item.endsAt) &&
        Date.parse(item.startsAt!) < Date.parse(item.endsAt!)
      )).toBe(true)
    }
  })

  it('enables startup progress sync by default and persists per-game changes', () => {
    database = new AppDatabase(':memory:')
    expect(database.getSyncSettings('genshin').autoSyncEnabled).toBe(true)
    expect(database.updateSyncSettings('genshin', { autoSyncEnabled: false }).autoSyncEnabled)
      .toBe(false)
  })

  it('migrates legacy personal structure into the complete baseline without losing progress', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-baseline-migration-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    database.mergeSyncedItems('star-rail', 'personal_sync', [{
      remoteKey: 'legacy-personal:chaos',
      category: 'endgame',
      title: '混沌回忆',
      completed: true,
      modeKey: 'memory-of-chaos'
    }])
    database.createChecklistItem({
      gameId: 'star-rail',
      category: 'exploration',
      title: '玩家手填旧地图'
    })
    database.close()
    database = null

    const raw = new DatabaseSync(databasePath)
    raw.exec(`
      ALTER TABLE sync_states ADD COLUMN mode TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE sync_states ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE sync_states ADD COLUMN auto_scope TEXT NOT NULL DEFAULT 'public_schedule';
      ALTER TABLE sync_states ADD COLUMN last_scope TEXT;
      ALTER TABLE sync_states ADD COLUMN initial_guide_dismissed INTEGER NOT NULL DEFAULT 0;
      DELETE FROM schema_migrations;
      INSERT INTO schema_migrations(version) VALUES (2);
    `)
    raw.close()

    database = new AppDatabase(databasePath)
    const items = database.listChecklistItems('star-rail')
    const cycles = items.filter((item) => item.category === 'endgame')
    expect(cycles.map((item) => item.title)).toEqual(expect.arrayContaining([
      '混沌回忆', '虚构叙事', '末日幻影', '异相仲裁'
    ]))
    expect(cycles.find((item) => item.modeKey === 'memory-of-chaos')).toMatchObject({
      completed: true,
      source: 'public_schedule'
    })
    expect(items.some((item) => item.source === 'personal_sync')).toBe(false)
    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '玩家手填旧地图', category: 'custom', source: 'manual' })
    ]))

    database.close()
    database = null
    const migrated = new DatabaseSync(databasePath, { readOnly: true })
    const syncStateColumns = migrated.prepare('PRAGMA table_info(sync_states)').all() as Array<{
      name: string
    }>
    migrated.close()
    expect(syncStateColumns.map((column) => column.name)).not.toEqual(expect.arrayContaining([
      'mode', 'run_mode', 'auto_scope', 'last_scope', 'initial_guide_dismissed'
    ]))
  })

  it('binds a uniquely named official map region to the baseline hierarchy and persists after restart', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-map-progress-persistence-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    database.replacePersonalSnapshot(
      'genshin',
      'exploration',
      `miyoushe:${'a'.repeat(64)}`,
      [{
        remoteKey: 'personal-map:miyoushe:region:chasm',
        category: 'exploration',
        title: '层岩巨渊',
        completed: true,
        progressPercent: 100,
        mapNodeKind: 'region',
        parentTitle: null,
        parentRemoteKey: null,
        sourceIdentity: {
          provider: 'miyoushe',
          endpoint: 'exploration',
          externalId: 'region:chasm'
        }
      }],
      'test-adapter',
      new Date('2026-08-09T10:00:00.000Z')
    )

    expect(database.listChecklistItems('genshin').find((item) => item.title === '层岩巨渊'))
      .toMatchObject({
        completed: true,
        progressPercent: 100,
        source: 'public_schedule',
        mapNodeKind: 'subregion',
        parentTitle: '璃月'
      })
    database.close()
    database = new AppDatabase(databasePath)

    expect(database.listChecklistItems('genshin').find((item) => item.title === '层岩巨渊'))
      .toMatchObject({
        completed: true,
        progressPercent: 100,
        source: 'public_schedule',
        parentTitle: '璃月'
      })
  })

  it('upgrades an awaiting cycle window in place without colliding with its stable remote key', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-10T15:00:00.000Z'))
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-cycle-window-upgrade-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath, { seedBundledBaselines: false })
    database.mergeSyncedItems('genshin', 'public_schedule', [{
      remoteKey: 'endgame:stygian-onslaught',
      category: 'endgame',
      title: '幽境危战',
      completed: false,
      startsAt: null,
      endsAt: null,
      modeKey: 'stygian-onslaught',
      periodKey: 'predicted:genshin:stygian-onslaught:awaiting-official-window'
    }])
    const oldItem = database.listChecklistItems('genshin').find(
      (item) => item.modeKey === 'stygian-onslaught'
    )!
    database.setChecklistCompletion(oldItem.id, true)
    database.close()
    database = null

    expect(() => {
      database = new AppDatabase(databasePath)
    }).not.toThrow()
    expect(database!.listChecklistItems('genshin').find(
      (item) => item.modeKey === 'stygian-onslaught'
    )).toMatchObject({
      id: oldItem.id,
      remoteKey: 'endgame:stygian-onslaught',
      completed: true,
      startsAt: expect.any(String),
      endsAt: expect.any(String)
    })
  })

  it('keeps every built-in recurring challenge syncable when the provider still returns the expired period', () => {
    vi.useFakeTimers()
    const reference = new Date('2026-08-11T12:00:00.000Z')
    vi.setSystemTime(reference)
    database = new AppDatabase(':memory:')

    for (const gameId of SUPPORTED_GAME_IDS) {
      const definitions = CYCLE_MODE_CATALOG.filter((definition) => definition.gameId === gameId)
      const expiredObservations = definitions.map((definition) => {
        const currentWindow = predictCycleWindow(definition, reference)
        expect(currentWindow).not.toBeNull()
        const expiredEndsAt = new Date(reference.getTime() - 1).toISOString()
        return {
          remoteKey: definition.remoteKey,
          category: 'endgame' as const,
          title: definition.title,
          completed: true,
          startsAt: new Date(Date.parse(expiredEndsAt) - 14 * 24 * 60 * 60 * 1000).toISOString(),
          endsAt: expiredEndsAt,
          modeKey: definition.modeKey,
          periodKey: `${gameId}:${definition.modeKey}:expired`,
          sourceIdentity: {
            provider: 'test-provider',
            endpoint: 'recurring-challenges',
            externalId: `${definition.modeKey}:expired`
          }
        }
      })
      const snapshot = completeCycleCatalog(
        gameId,
        expiredObservations,
        database.listChecklistItems(gameId),
        'personal_sync',
        reference
      )

      expect(snapshot).toHaveLength(definitions.length * 2)
      expect(new Set(snapshot.map((item) => item.remoteKey)).size).toBe(definitions.length)
      expect(() => database!.replacePersonalSnapshot(
        gameId,
        'cycles',
        `test:${'a'.repeat(64)}`,
        snapshot,
        'cycle-rollover-test',
        reference
      )).not.toThrow()

      const currentCycles = database.listChecklistItems(gameId).filter(
        (item) => item.category === 'endgame'
      )
      expect(currentCycles).toHaveLength(definitions.length)
      expect(currentCycles.every((item) => item.completed === false)).toBe(true)
      expect(currentCycles.every((item) => item.lastSyncedAt === reference.toISOString())).toBe(true)
      expect(database.getSyncTargetStates(gameId).find((state) => state.target === 'cycles'))
        .toMatchObject({ status: 'success', lastSuccessAt: reference.toISOString() })
    }
  })
})
