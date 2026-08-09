import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { SUPPORTED_GAME_IDS } from '../src/shared/contracts'
import {
  BUNDLED_BASELINE_VERIFIED_AT,
  getBundledActivityCatalog,
  getBundledVersionWindow
} from '../src/main/sync/baseline-catalog'

let database: AppDatabase | null = null
let temporaryDirectory: string | null = null

afterEach(() => {
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
      expect(new Set(getBundledActivityCatalog(gameId).map((item) => item.remoteKey)).size)
        .toBe(getBundledActivityCatalog(gameId).length)
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
})
