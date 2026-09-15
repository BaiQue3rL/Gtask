import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database'
import { createManualBackup, createPreMigrationBackup, restoreBackup } from '../src/main/backup'
import { parseRemoteCatalogFeed } from '../src/main/remote-catalog-update'
import { validateCatalogPublication } from '../src/main/catalog-validation'
import { getBundledMapCatalog, getBundledMapCatalogVerifiedAt } from '../src/main/sync/map-catalog'

describe('catalog provenance and recovery', () => {
  it('migrates v5 without overwriting unversioned local facts or manual progress', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtask-audit-migrate-'))
    const path = join(directory, 'test.sqlite')
    let db: AppDatabase | null = new AppDatabase(path)
    try {
      const map = db.listChecklistItems('genshin').find((item) => item.mapNodeKind === 'subregion')!
      db.updateChecklistItem({ id: map.id, completed: true })
      db.close()
      db = null
      const old = new DatabaseSync(path)
      try {
        old.exec(`DROP TABLE public_catalog_item_state; DROP TABLE remote_catalog_receipt; DROP TABLE public_time_records;
          DROP TRIGGER checklist_revision_insert; DROP TRIGGER checklist_revision_update;
          DROP TRIGGER checklist_revision_delete; DROP TABLE checklist_revision;
          DROP INDEX checklist_game_visible; DROP INDEX checklist_snapshot_reference;
          UPDATE schema_migrations SET version = 5 WHERE version = ${CURRENT_SCHEMA_VERSION}`)
        old.prepare('UPDATE checklist_items SET title = ? WHERE id = ?').run('旧库已核实名称', map.id)
      } finally { old.close() }
      const backup = await createPreMigrationBackup(path, join(directory, 'backups'), CURRENT_SCHEMA_VERSION)
      expect(backup).not.toBeNull()
      db = new AppDatabase(path)
      db.replacePublicCatalog('genshin', 'exploration', getBundledMapCatalog('genshin'),
        getBundledMapCatalogVerifiedAt('genshin'), { bundled: true, identityPolicy: 'remote-key-only' })
      expect(db.getChecklistItem(map.id)).toMatchObject({ title: '旧库已核实名称', completed: true, manualCompletionLocked: true })
      expect(db.getRemoteCatalogReceipt()).toBeNull()
    } finally { db?.close(); rmSync(directory, { recursive: true, force: true }) }
  })

  it('rolls back an entire bad batch, and restores the catalog receipt with a backup', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gtask-audit-receipt-'))
    const path = join(directory, 'test.sqlite')
    const backups = join(directory, 'backups')
    let db = new AppDatabase(path)
    try {
      const map = db.listChecklistItems('genshin').find((item) => item.mapNodeKind === 'subregion')!
      const makeFeed = (revision: string, publishedAt: string, title: string) => parseRemoteCatalogFeed({
        schemaVersion: 1, revision, publishedAt, games: [{ gameId: 'genshin', archives: [], upserts: [{
          remoteKey: map.remoteKey, title, category: 'exploration', mapNodeKind: 'subregion',
          parentRemoteKey: map.parentRemoteKey, parentTitle: map.parentTitle, sourceUrl: 'https://example.com/official'
        }] }]
      })
      const first = makeFeed('audit.first', '2026-09-14T10:00:00Z', '修订一')
      db.applyRemoteCatalogFeed(first)
      const firstReceipt = db.getRemoteCatalogReceipt()
      const backup = await createManualBackup(db, backups)
      const invalid = makeFeed('audit.bad', '2026-09-14T10:01:00Z', '不应写入')
      invalid.games.push({ gameId: 'star-rail', archives: [], upserts: [{
        remoteKey: 'audit:orphan', title: '孤立子区', category: 'exploration', mapNodeKind: 'subregion',
        parentRemoteKey: 'audit:missing-parent', sourceUrl: 'https://example.com/official'
      }] })
      expect(() => db.applyRemoteCatalogFeed(invalid)).toThrow()
      expect(db.getRemoteCatalogReceipt()).toEqual(firstReceipt)
      expect(db.getChecklistItem(map.id).title).toBe('修订一')
      const second = makeFeed('audit.second', '2026-09-14T10:02:00Z', '修订二')
      db.applyRemoteCatalogFeed(second)
      db.applyRemoteCatalogFeed(first)
      expect(db.getChecklistItem(map.id).title).toBe('修订二')
      await restoreBackup(db, path, backups, basename(backup))
      db = new AppDatabase(path)
      expect(db.getRemoteCatalogReceipt()).toEqual(firstReceipt)
      expect(db.getChecklistItem(map.id).title).toBe('修订一')
      db.applyRemoteCatalogFeed(second)
      expect(db.getChecklistItem(map.id).title).toBe('修订二')
      expect(() => validateCatalogPublication(invalid)).toThrow()
      expect(validateCatalogPublication(second).receipt?.revision).toBe('audit.second')
    } finally { db.close(); rmSync(directory, { recursive: true, force: true }) }
  })
})
