import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateLegacyAppData, resolveAppDataPaths } from '../src/main/data-paths'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('app data paths', () => {
  it('uses the Windows Documents location without assuming a drive letter', () => {
    const paths = resolveAppDataPaths('X:\\Redirected\\Documents')
    expect(paths.root).toBe('X:\\Redirected\\Documents\\GachaTaskManager')
    expect(paths.database).toBe(
      'X:\\Redirected\\Documents\\GachaTaskManager\\data\\gacha-task-manager.sqlite'
    )
  })

  it('copies a consistent legacy database and keeps the legacy source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gacha-data-migration-'))
    temporaryDirectories.push(root)
    const legacyRoot = join(root, 'legacy')
    const documents = join(root, 'documents')
    const legacyDatabase = join(legacyRoot, 'data', 'gacha-task-manager.sqlite')
    mkdirSync(join(legacyRoot, 'data'), { recursive: true })
    const database = new DatabaseSync(legacyDatabase)
    database.exec('CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES (\'preserved\');')
    database.close()

    const destination = resolveAppDataPaths(documents)
    await expect(migrateLegacyAppData(legacyRoot, destination)).resolves.toBe(true)
    expect(existsSync(legacyDatabase)).toBe(true)
    const migrated = new DatabaseSync(destination.database, { readOnly: true })
    expect(migrated.prepare('SELECT value FROM sample').get()).toEqual({ value: 'preserved' })
    migrated.close()
  })
})
