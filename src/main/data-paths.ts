import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'

export const APP_DATA_DIRECTORY_NAME = 'GachaTaskManager'

export interface AppDataPaths {
  root: string
  database: string
  backups: string
}

export function resolveAppDataPaths(documentsDirectory: string): AppDataPaths {
  const root = resolve(documentsDirectory, APP_DATA_DIRECTORY_NAME)
  return {
    root,
    database: join(root, 'data', 'gacha-task-manager.sqlite'),
    backups: join(root, 'backups')
  }
}

export async function migrateLegacyAppData(
  legacyRoot: string,
  destination: AppDataPaths
): Promise<boolean> {
  const legacyDatabase = join(resolve(legacyRoot), 'data', 'gacha-task-manager.sqlite')
  if (existsSync(destination.database) || !existsSync(legacyDatabase)) return false

  mkdirSync(join(destination.root, 'data'), { recursive: true })
  mkdirSync(destination.backups, { recursive: true })
  const temporaryDatabase = `${destination.database}.migrating`
  rmSync(temporaryDatabase, { force: true })
  const source = new DatabaseSync(legacyDatabase, { readOnly: true })
  try {
    await backup(source, temporaryDatabase)
    const check = new DatabaseSync(temporaryDatabase, { readOnly: true })
    try {
      const row = check.prepare('PRAGMA quick_check').get() as Record<string, unknown>
      if (Object.values(row)[0] !== 'ok') throw new Error('迁移后的数据库完整性检查失败')
    } finally {
      check.close()
    }
    renameSync(temporaryDatabase, destination.database)
  } catch (error) {
    rmSync(temporaryDatabase, { force: true })
    throw error
  } finally {
    source.close()
  }

  const legacyBackups = join(resolve(legacyRoot), 'backups')
  if (existsSync(legacyBackups)) {
    for (const entry of readdirSync(legacyBackups, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.sqlite')) continue
      const target = join(destination.backups, basename(entry.name))
      if (!existsSync(target)) copyFileSync(join(legacyBackups, entry.name), target)
    }
  }
  return true
}
