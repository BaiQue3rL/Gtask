import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyAppDataPaths, resolveAppDataPaths } from '../src/main/data-paths'

let temporaryDirectory: string | null = null

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe('app data paths', () => {
  it('uses the Windows Documents location without assuming a drive letter', () => {
    const paths = resolveAppDataPaths('X:\\Redirected\\Documents')
    expect(paths.root).toBe('X:\\Redirected\\Documents\\Gtask')
    expect(paths.database).toBe(
      'X:\\Redirected\\Documents\\Gtask\\data\\gtask.sqlite'
    )
    expect(paths.backups).toBe('X:\\Redirected\\Documents\\Gtask\\backups')
    expect(paths.logs).toBe('X:\\Redirected\\Documents\\Gtask\\logs')
  })

  it('atomically migrates the released data directory and backup names', () => {
    const root = mkdtempSync(join(tmpdir(), 'gtask-data-path-migration-'))
    temporaryDirectory = root
    const legacyRoot = join(root, 'GachaTaskManager')
    const dataDirectory = join(legacyRoot, 'data')
    const backupDirectory = join(legacyRoot, 'backups')
    mkdirSync(dataDirectory, { recursive: true })
    mkdirSync(backupDirectory, { recursive: true })
    const legacyDatabase = join(dataDirectory, 'gacha-task-manager.sqlite')
    const database = new DatabaseSync(legacyDatabase)
    database.exec('CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES (\'ok\');')
    database.close()
    writeFileSync(join(backupDirectory, 'gacha-task-manager-2026-08-22.sqlite'), 'backup')

    const migrated = migrateLegacyAppDataPaths(root)

    expect(existsSync(legacyRoot)).toBe(false)
    expect(migrated.root).toBe(join(root, 'Gtask'))
    expect(existsSync(migrated.database)).toBe(true)
    expect(existsSync(join(migrated.backups, 'gtask-2026-08-22.sqlite'))).toBe(true)
    const verified = new DatabaseSync(migrated.database, { readOnly: true })
    expect(verified.prepare('SELECT value FROM migration_probe').get()).toEqual({ value: 'ok' })
    verified.close()
  })

  it('migrates a released WAL database left by an interrupted process', () => {
    const root = mkdtempSync(join(tmpdir(), 'gtask-data-path-wal-migration-'))
    temporaryDirectory = root
    const dataDirectory = join(root, 'GachaTaskManager', 'data')
    mkdirSync(dataDirectory, { recursive: true })
    const legacyDatabase = join(dataDirectory, 'gacha-task-manager.sqlite')
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        [
          "const { DatabaseSync } = require('node:sqlite')",
          'const database = new DatabaseSync(process.argv[1])',
          "database.exec(\"PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES ('wal-ok');\")",
          'process.exit(0)'
        ].join(';'),
        legacyDatabase
      ],
      { encoding: 'utf8' }
    )
    expect(child.status, child.stderr).toBe(0)
    expect(existsSync(`${legacyDatabase}-wal`)).toBe(true)

    const migrated = migrateLegacyAppDataPaths(root)

    expect(existsSync(`${migrated.database}-wal`)).toBe(true)
    const verified = new DatabaseSync(migrated.database)
    expect(verified.prepare('SELECT value FROM migration_probe').get()).toEqual({ value: 'wal-ok' })
    verified.close()
  })

  it('falls back to moving entries when Windows holds the released root open', () => {
    const root = mkdtempSync(join(tmpdir(), 'gtask-data-path-locked-root-'))
    temporaryDirectory = root
    const legacyRoot = join(root, 'GachaTaskManager')
    const dataDirectory = join(legacyRoot, 'data')
    mkdirSync(dataDirectory, { recursive: true })
    const database = new DatabaseSync(join(dataDirectory, 'gacha-task-manager.sqlite'))
    database.exec("CREATE TABLE migration_probe(value TEXT); INSERT INTO migration_probe VALUES ('locked-ok');")
    database.close()
    const heldDirectory = opendirSync(legacyRoot)

    const migrated = migrateLegacyAppDataPaths(root)

    expect(existsSync(migrated.database)).toBe(true)
    if (existsSync(legacyRoot)) expect(readdirSync(legacyRoot)).toEqual([])
    heldDirectory.closeSync()
    if (existsSync(legacyRoot)) rmdirSync(legacyRoot)
  })

  it('refuses to guess when both the new and released data roots exist', () => {
    const root = mkdtempSync(join(tmpdir(), 'gtask-data-path-conflict-'))
    temporaryDirectory = root
    mkdirSync(join(root, 'Gtask'))
    mkdirSync(join(root, 'GachaTaskManager'))
    writeFileSync(join(root, 'GachaTaskManager', 'unmigrated.txt'), 'keep')

    expect(() => migrateLegacyAppDataPaths(root)).toThrow('同时检测到新旧数据目录')
  })
})
