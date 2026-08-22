import { existsSync, mkdirSync, readdirSync, renameSync, rmdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const APP_DATA_DIRECTORY_NAME = 'Gtask'
export const APP_DATABASE_FILE_NAME = 'gtask.sqlite'

// These identifiers are intentionally isolated here so released installations can
// migrate once without keeping the retired product name in business modules.
const LEGACY_APP_DATA_DIRECTORY_NAME = 'GachaTaskManager'
const LEGACY_DATABASE_FILE_NAME = 'gacha-task-manager.sqlite'
const LEGACY_BACKUP_PREFIX = 'gacha-task-manager-'

export interface AppDataPaths {
  root: string
  database: string
  backups: string
  logs: string
}

export function resolveAppDataPaths(documentsDirectory: string): AppDataPaths {
  const root = resolve(documentsDirectory, APP_DATA_DIRECTORY_NAME)
  return {
    root,
    database: join(root, 'data', APP_DATABASE_FILE_NAME),
    backups: join(root, 'backups'),
    logs: join(root, 'logs')
  }
}

interface PendingRename {
  source: string
  destination: string
}

interface RootMigration {
  mode: 'renamed' | 'entries'
  entries: PendingRename[]
}

function isEmptyDirectory(path: string): boolean {
  return existsSync(path) && readdirSync(path).length === 0
}

function isWindowsDirectoryLock(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false
  return ['EACCES', 'EBUSY', 'EPERM'].includes(String(error.code))
}

function moveRootWithFallback(source: string, destination: string): RootMigration {
  try {
    renameSync(source, destination)
    return { mode: 'renamed', entries: [] }
  } catch (error) {
    if (!isWindowsDirectoryLock(error)) throw error
  }

  mkdirSync(destination)
  const entries: PendingRename[] = []
  try {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const rename = {
        source: join(source, entry.name),
        destination: join(destination, entry.name)
      }
      if (existsSync(rename.destination)) {
        throw new Error(`数据迁移目标已经存在：${rename.destination}`)
      }
      renameSync(rename.source, rename.destination)
      entries.push(rename)
    }
    try {
      rmdirSync(source)
    } catch (error) {
      // Windows can retain a directory handle after all children have moved. An
      // empty compatibility directory is harmless and will be removed on a later start.
      if (!isWindowsDirectoryLock(error) || !isEmptyDirectory(source)) throw error
    }
    return { mode: 'entries', entries }
  } catch (error) {
    for (const rename of [...entries].reverse()) {
      if (existsSync(rename.destination) && !existsSync(rename.source)) {
        renameSync(rename.destination, rename.source)
      }
    }
    if (isEmptyDirectory(destination)) rmdirSync(destination)
    throw error
  }
}

function rollbackRootMigration(
  migration: RootMigration,
  legacyRoot: string,
  currentRoot: string
): void {
  if (migration.mode === 'renamed') {
    if (existsSync(currentRoot) && !existsSync(legacyRoot)) renameSync(currentRoot, legacyRoot)
    return
  }

  mkdirSync(legacyRoot, { recursive: true })
  for (const rename of [...migration.entries].reverse()) {
    if (existsSync(rename.destination) && !existsSync(rename.source)) {
      renameSync(rename.destination, rename.source)
    }
  }
  if (isEmptyDirectory(currentRoot)) rmdirSync(currentRoot)
}

function legacyArtifactRenames(root: string): PendingRename[] {
  const dataDirectory = join(root, 'data')
  const databaseRenames = ['', '-wal', '-shm'].map((suffix) => ({
    source: join(dataDirectory, `${LEGACY_DATABASE_FILE_NAME}${suffix}`),
    destination: join(dataDirectory, `${APP_DATABASE_FILE_NAME}${suffix}`)
  }))
  const backupDirectory = join(root, 'backups')
  const backupRenames = existsSync(backupDirectory)
    ? readdirSync(backupDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(LEGACY_BACKUP_PREFIX))
      .map((entry) => ({
        source: join(backupDirectory, entry.name),
        destination: join(
          backupDirectory,
          `gtask-${entry.name.slice(LEGACY_BACKUP_PREFIX.length)}`
        )
      }))
    : []
  return [...databaseRenames, ...backupRenames].filter(({ source }) => existsSync(source))
}

function verifyDatabaseIntegrity(databasePath: string): void {
  if (!existsSync(databasePath)) return
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const result = database.prepare('PRAGMA quick_check').get() as Record<string, unknown>
    if (Object.values(result)[0] !== 'ok') throw new Error('SQLite 数据完整性检查失败')
  } finally {
    database.close()
  }
}

/**
 * Migrates the released data directory before any application database handle is opened.
 * Every filesystem rename is reversible, and a partially completed directory rename is
 * safely resumed on the next startup.
 */
export function migrateLegacyAppDataPaths(documentsDirectory: string): AppDataPaths {
  const current = resolveAppDataPaths(documentsDirectory)
  const legacyRoot = resolve(documentsDirectory, LEGACY_APP_DATA_DIRECTORY_NAME)
  const currentExists = existsSync(current.root)
  let legacyExists = existsSync(legacyRoot)
  if (currentExists && legacyExists && isEmptyDirectory(legacyRoot)) {
    try {
      rmdirSync(legacyRoot)
      legacyExists = false
    } catch (error) {
      if (!isWindowsDirectoryLock(error)) throw error
    }
  }
  if (currentExists && legacyExists) {
    if (!isEmptyDirectory(legacyRoot)) {
      throw new Error('同时检测到新旧数据目录，请先确认要保留的数据后再启动 Gtask')
    }
  }

  let rootMigration: RootMigration | null = null
  if (!currentExists && legacyExists) {
    rootMigration = moveRootWithFallback(legacyRoot, current.root)
  }

  if (!existsSync(current.root)) return current

  const applied: PendingRename[] = []
  try {
    for (const rename of legacyArtifactRenames(current.root)) {
      if (existsSync(rename.destination)) {
        throw new Error(`数据迁移目标已经存在：${rename.destination}`)
      }
      renameSync(rename.source, rename.destination)
      applied.push(rename)
    }
    verifyDatabaseIntegrity(current.database)
    return current
  } catch (error) {
    for (const rename of [...applied].reverse()) {
      if (existsSync(rename.destination) && !existsSync(rename.source)) {
        renameSync(rename.destination, rename.source)
      }
    }
    if (rootMigration) rollbackRootMigration(rootMigration, legacyRoot, current.root)
    throw error
  }
}
