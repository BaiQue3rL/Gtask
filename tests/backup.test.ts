import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDailyBackup,
  createManualBackup,
  createPreMigrationBackup,
  listBackups
} from '../src/main/backup'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database'

let database: AppDatabase | null = null
let temporaryDirectory: string | null = null

afterEach(() => {
  database?.close()
  database = null
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe('createDailyBackup', () => {
  it('每天只创建一份可重新打开的 SQLite 一致性备份', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-task-manager-backup-test-'))
    const databasePath = join(temporaryDirectory, 'source.sqlite')
    const backupDirectory = join(temporaryDirectory, 'backups')
    database = new AppDatabase(databasePath)
    database.createChecklistItem({
      gameId: 'genshin',
      category: 'custom',
      title: '备份中的事项'
    })

    const reference = new Date('2026-07-20T08:00:00+08:00')
    const backupPath = await createDailyBackup(database, backupDirectory, reference)
    expect(backupPath).not.toBeNull()
    expect(existsSync(backupPath!)).toBe(true)
    expect(await createDailyBackup(database, backupDirectory, reference)).toBeNull()

    const restored = new AppDatabase(backupPath!)
    try {
      expect(restored.listChecklistItems('genshin').some((item) => item.title === '备份中的事项')).toBe(true)
    } finally {
      restored.close()
    }
  })

  it('仅在数据库版本落后时创建迁移前备份', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-pre-migration-backup-test-'))
    const databasePath = join(temporaryDirectory, 'source.sqlite')
    const backupDirectory = join(temporaryDirectory, 'backups')
    database = new AppDatabase(databasePath)

    expect(
      await createPreMigrationBackup(databasePath, backupDirectory, CURRENT_SCHEMA_VERSION)
    ).toBeNull()
    const backupPath = await createPreMigrationBackup(
      databasePath,
      backupDirectory,
      CURRENT_SCHEMA_VERSION + 1,
      new Date('2026-07-20T09:00:00+08:00')
    )
    expect(backupPath).not.toBeNull()
    expect(existsSync(backupPath!)).toBe(true)
  })

  it('可以立即创建手动备份并按时间列出备份类型', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-manual-backup-test-'))
    const databasePath = join(temporaryDirectory, 'source.sqlite')
    const backupDirectory = join(temporaryDirectory, 'backups')
    database = new AppDatabase(databasePath)
    await createDailyBackup(database, backupDirectory, new Date('2026-07-20T08:00:00+08:00'))
    await createManualBackup(database, backupDirectory, new Date('2026-07-20T09:30:00+08:00'))

    expect(listBackups(backupDirectory).map((backup) => backup.kind)).toEqual(['manual', 'daily'])
    expect(listBackups(backupDirectory)[0].sizeBytes).toBeGreaterThan(0)
  })
})
