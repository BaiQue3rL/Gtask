import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { AppDatabase, PERSONAL_SNAPSHOT_HISTORY_LIMIT } from '../src/main/database'
import { SyncOrchestrator } from '../src/main/sync/orchestrator'

describe('reliability under repeated work', () => {
  it('bounds machine snapshot history and keeps all referenced progress through restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtask-retention-'))
    const path = join(directory, 'test.sqlite')
    let db = new AppDatabase(path)
    try {
      const region = db.listChecklistItems('genshin').find((item) => item.mapNodeKind === 'region')!
      const leaf = db.listChecklistItems('genshin').find((item) => item.mapNodeKind === 'subregion')!
      const make = (item: typeof region, value: number) => ({ remoteKey: item.remoteKey!, title: item.title,
        category: 'exploration' as const, progressPercent: value,
        sourceIdentity: { provider: 'miyoushe', endpoint: 'retention', externalId: item.remoteKey! } })
      const apply = (items: ReturnType<typeof make>[], tick: number) => db.replacePersonalSnapshot(
        'genshin', 'exploration', `miyoushe:${'a'.repeat(64)}`, items, 'retention', new Date(1_789_400_000_000 + tick * 1000))
      apply([make(leaf, 67)], 0)
      for (let index = 1; index <= PERSONAL_SNAPSHOT_HISTORY_LIMIT * 2; index++) apply([make(region, 13)], index)
      const probe = new DatabaseSync(path, { readOnly: true })
      try {
        const { count } = probe.prepare('SELECT COUNT(*) AS count FROM personal_sync_snapshots').get() as { count: number }
        expect(count).toBeLessThanOrEqual(PERSONAL_SNAPSHOT_HISTORY_LIMIT + 1)
        expect(count).toBeGreaterThanOrEqual(PERSONAL_SNAPSHOT_HISTORY_LIMIT)
        expect(probe.prepare(`SELECT COUNT(*) AS missing FROM checklist_items c WHERE source_snapshot_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM personal_sync_snapshots s WHERE s.id = c.source_snapshot_id)`)
          .get()).toMatchObject({ missing: 0 })
      } finally { probe.close() }
      db.close()
      db = new AppDatabase(path)
      expect(db.getChecklistItem(leaf.id).progressPercent).toBe(67)
      expect(db.getChecklistItem(region.id).progressPercent).toBe(13)
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('detects visible changes with identical timestamps but ignores metadata-only updates', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtask-revision-'))
    const path = join(directory, 'test.sqlite')
    const db = new AppDatabase(path)
    const writer = new DatabaseSync(path)
    try {
      const item = db.createChecklistItem({ gameId: 'genshin', category: 'custom', title: '初始标题' })
      const before = db.getChecklistRevision()
      writer.prepare('UPDATE checklist_items SET last_synced_at = ? WHERE id = ?').run(new Date().toISOString(), item.id)
      expect(db.getChecklistRevision()).toBe(before)
      writer.prepare('UPDATE checklist_items SET title = ? WHERE id = ?').run('时间戳不变的新标题', item.id)
      const after = db.getChecklistRevision()
      expect(after).not.toBe(before)
      writer.exec('BEGIN IMMEDIATE')
      writer.prepare('UPDATE checklist_items SET completed = 1 WHERE id = ?').run(item.id)
      writer.exec('ROLLBACK')
      expect(db.getChecklistRevision()).toBe(after)
    } finally { writer.close(); db.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('progress observers cannot turn a successful commit into a reported failure', async () => {
    const db = new AppDatabase(':memory:')
    try {
      const baseline = db.listChecklistItems('genshin').find((item) => item.modeKey === 'spiral-abyss')!
      const orchestrator = new SyncOrchestrator(db, { publicSchedule: {}, personalData: { genshin: {
        sync: async () => ({ items: [{ remoteKey: baseline.remoteKey!, title: baseline.title,
          category: 'endgame', modeKey: baseline.modeKey, completed: true,
          sourceIdentity: { provider: 'miyoushe', endpoint: 'observer', externalId: '1' } }],
        accountScope: `miyoushe:${'a'.repeat(64)}`, message: 'ok' })
      } } }, (progress) => { if (progress.phase === 'completed') throw new Error('window already closed') })
      expect((await orchestrator.syncPersonalOnly('genshin', 'cycles')).status).toBe('success')
      expect(db.getChecklistItem(baseline.id).completed).toBe(true)
      orchestrator.shutdown()
      const attempt = vi.spyOn(db, 'recordPersonalSyncAttempt')
      expect((await orchestrator.syncPersonalOnly('genshin', 'cycles')).status).toBe('cancelled')
      expect(attempt).not.toHaveBeenCalled()
    } finally { db.close() }
  })
})
