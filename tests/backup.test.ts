import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDailyBackup,
  createManualBackup,
  createPreMigrationBackup,
  listBackups,
  pruneDailyBackups,
  restoreBackup
} from '../src/main/backup'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from '../src/main/database'
import { DatabaseSync } from 'node:sqlite'

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
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-backup-test-'))
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
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-pre-migration-backup-test-'))
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
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-manual-backup-test-'))
    const databasePath = join(temporaryDirectory, 'source.sqlite')
    const backupDirectory = join(temporaryDirectory, 'backups')
    database = new AppDatabase(databasePath)
    await createDailyBackup(database, backupDirectory, new Date('2026-07-20T08:00:00+08:00'))
    await createManualBackup(database, backupDirectory, new Date('2026-07-20T09:30:00+08:00'))

    expect(listBackups(backupDirectory).map((backup) => backup.kind)).toEqual(['manual', 'daily'])
    expect(listBackups(backupDirectory)[0].sizeBytes).toBeGreaterThan(0)
  })

  it('只清理超出保留数量的每日备份，不删除手动或安全备份', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-backup-retention-test-'))
    const backupDirectory = join(temporaryDirectory, 'backups')
    mkdirSync(backupDirectory)

    for (const day of ['17', '18', '19', '20']) {
      writeFileSync(join(backupDirectory, `gtask-2026-07-${day}.sqlite`), day)
    }
    const protectedNames = [
      'gtask-manual-20260720-090000-000.sqlite',
      'gtask-before-restore-20260720-091000-000.sqlite',
      'gtask-before-v7-20260720-092000.sqlite'
    ]
    for (const fileName of protectedNames) writeFileSync(join(backupDirectory, fileName), fileName)

    expect(pruneDailyBackups(backupDirectory, 2)).toEqual([
      'gtask-2026-07-18.sqlite',
      'gtask-2026-07-17.sqlite'
    ])
    expect(listBackups(backupDirectory).map((backup) => backup.fileName)).toEqual(
      expect.arrayContaining([
        'gtask-2026-07-20.sqlite',
        'gtask-2026-07-19.sqlite',
        ...protectedNames
      ])
    )
    expect(() => pruneDailyBackups(backupDirectory, 0)).toThrow('大于零的整数')
  })

  it('恢复已知备份前保留当前数据库的安全副本', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-restore-backup-test-'))
    const databasePath = join(temporaryDirectory, 'source.sqlite')
    const backupDirectory = join(temporaryDirectory, 'backups')
    database = new AppDatabase(databasePath)
    database.createChecklistItem({ gameId: 'genshin', category: 'custom', title: '备份时存在' })
    const backupPath = await createManualBackup(
      database,
      backupDirectory,
      new Date('2026-07-20T10:20:00+08:00')
    )
    database.createChecklistItem({ gameId: 'genshin', category: 'custom', title: '备份后新增' })

    await restoreBackup(
      database,
      databasePath,
      backupDirectory,
      basename(backupPath),
      new Date('2026-07-20T10:30:00+08:00')
    )
    database = new AppDatabase(databasePath)

    const titles = database.listChecklistItems('genshin').map((item) => item.title)
    expect(titles).toContain('备份时存在')
    expect(titles).not.toContain('备份后新增')
    expect(listBackups(backupDirectory).map((backup) => backup.kind)).toContain('pre_restore')
    expect(existsSync(`${backupPath}-wal`)).toBe(false)
    expect(existsSync(`${backupPath}-shm`)).toBe(false)
    expect(existsSync(`${databasePath}.restore.tmp-wal`)).toBe(false)
    expect(existsSync(`${databasePath}.restore.tmp-shm`)).toBe(false)
  })

  it('拒绝恢复备份目录之外的路径', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-restore-path-test-'))
    const databasePath = join(temporaryDirectory, 'source.sqlite')
    const backupDirectory = join(temporaryDirectory, 'backups')
    database = new AppDatabase(databasePath)

    await expect(
      restoreBackup(database, databasePath, backupDirectory, '..\\source.sqlite')
    ).rejects.toThrow('备份文件名不合法')
    expect(database.listGames()).toHaveLength(4)
  })

  it('替换当前数据库前拒绝来自未来版本的备份', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-restore-version-test-'))
    const databasePath = join(temporaryDirectory, 'source.sqlite')
    const backupDirectory = join(temporaryDirectory, 'backups')
    database = new AppDatabase(databasePath)
    const backupPath = await createManualBackup(database, backupDirectory)
    const future = new DatabaseSync(backupPath)
    future.prepare('INSERT INTO schema_migrations(version) VALUES (?)').run(CURRENT_SCHEMA_VERSION + 1)
    future.close()

    await expect(
      restoreBackup(database, databasePath, backupDirectory, basename(backupPath))
    ).rejects.toThrow('来自更高版本')
    expect(database.listGames()).toHaveLength(4)
    expect(listBackups(backupDirectory).map((backup) => backup.kind)).not.toContain('pre_restore')
  })
})
