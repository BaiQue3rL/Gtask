import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { CURRENT_SCHEMA_VERSION, type AppDatabase } from './database'
import type { BackupSummary } from '../shared/contracts'

export const DEFAULT_DAILY_BACKUP_RETENTION = 30

const DAILY_BACKUP_FILE_NAME = /^gacha-task-manager-(\d{4}-\d{2}-\d{2})\.sqlite$/

function localDateKey(reference: Date): string {
  const year = reference.getFullYear()
  const month = String(reference.getMonth() + 1).padStart(2, '0')
  const day = String(reference.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function verifyBackupIntegrity(databasePath: string): void {
  const walPath = `${databasePath}-wal`
  const shmPath = `${databasePath}-shm`
  const walExisted = existsSync(walPath)
  const shmExisted = existsSync(shmPath)
  const backupDatabase = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const row = backupDatabase.prepare('PRAGMA quick_check').get() as Record<string, unknown>
    if (Object.values(row)[0] !== 'ok') throw new Error('SQLite 备份完整性检查失败')
  } finally {
    backupDatabase.close()
    if (!walExisted) rmSync(walPath, { force: true })
    if (!shmExisted) rmSync(shmPath, { force: true })
  }
}

function verifyRestorableDatabase(databasePath: string): void {
  verifyBackupIntegrity(databasePath)
  const walPath = `${databasePath}-wal`
  const shmPath = `${databasePath}-shm`
  const walExisted = existsSync(walPath)
  const shmExisted = existsSync(shmPath)
  const candidate = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const requiredTables = ['schema_migrations', 'games', 'checklist_items', 'sync_states']
    const rows = candidate
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
    const tableNames = new Set(rows.map((row) => row.name))
    if (requiredTables.some((table) => !tableNames.has(table))) {
      throw new Error('所选文件不是可恢复的 Gtask 数据库')
    }
    const versionRow = candidate
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null }
    const version = Number(versionRow.version)
    if (!Number.isInteger(version) || version < 1) {
      throw new Error('所选备份缺少有效的数据库版本')
    }
    if (version > CURRENT_SCHEMA_VERSION) {
      throw new Error(`所选备份来自更高版本（v${version}），当前应用无法恢复`)
    }
  } finally {
    candidate.close()
    if (!walExisted) rmSync(walPath, { force: true })
    if (!shmExisted) rmSync(shmPath, { force: true })
  }
}

export async function createDailyBackup(
  database: AppDatabase,
  backupDirectory: string,
  reference = new Date()
): Promise<string | null> {
  const resolvedDirectory = resolve(backupDirectory)
  mkdirSync(resolvedDirectory, { recursive: true })
  const destination = join(resolvedDirectory, `gacha-task-manager-${localDateKey(reference)}.sqlite`)
  if (existsSync(destination)) return null

  const temporaryDestination = `${destination}.tmp`
  if (existsSync(temporaryDestination)) rmSync(temporaryDestination)
  try {
    await database.backupTo(temporaryDestination)
    verifyBackupIntegrity(temporaryDestination)
    renameSync(temporaryDestination, destination)
    return destination
  } catch (error) {
    if (existsSync(temporaryDestination)) rmSync(temporaryDestination)
    throw error
  }
}

/**
 * Keeps automatic daily snapshots bounded without touching user-created or safety backups.
 */
export function pruneDailyBackups(
  backupDirectory: string,
  retention = DEFAULT_DAILY_BACKUP_RETENTION
): string[] {
  if (!Number.isInteger(retention) || retention < 1) {
    throw new Error('每日备份保留数量必须是大于零的整数')
  }

  const resolvedDirectory = resolve(backupDirectory)
  if (!existsSync(resolvedDirectory)) return []
  const expired = readdirSync(resolvedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && DAILY_BACKUP_FILE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left))
    .slice(retention)

  for (const fileName of expired) rmSync(join(resolvedDirectory, fileName), { force: true })
  return expired
}

function timestampKey(reference: Date): string {
  const date = localDateKey(reference).replaceAll('-', '')
  const time = [reference.getHours(), reference.getMinutes(), reference.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join('')
  return `${date}-${time}`
}

export async function createPreMigrationBackup(
  databasePath: string,
  backupDirectory: string,
  targetVersion: number,
  reference = new Date()
): Promise<string | null> {
  if (!existsSync(databasePath)) return null
  const source = new DatabaseSync(databasePath)
  try {
    let currentVersion = 0
    try {
      const row = source.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
        version: number | null
      }
      currentVersion = Number(row.version ?? 0)
    } catch {
      currentVersion = 0
    }
    if (currentVersion >= targetVersion) return null

    const resolvedDirectory = resolve(backupDirectory)
    mkdirSync(resolvedDirectory, { recursive: true })
    const destination = join(
      resolvedDirectory,
      `gacha-task-manager-before-v${targetVersion}-${timestampKey(reference)}.sqlite`
    )
    const temporaryDestination = `${destination}.tmp`
    if (existsSync(temporaryDestination)) rmSync(temporaryDestination)
    try {
      await backup(source, temporaryDestination)
      verifyBackupIntegrity(temporaryDestination)
      renameSync(temporaryDestination, destination)
      return destination
    } catch (error) {
      if (existsSync(temporaryDestination)) rmSync(temporaryDestination)
      throw error
    }
  } finally {
    source.close()
  }
}

export async function createManualBackup(
  database: AppDatabase,
  backupDirectory: string,
  reference = new Date()
): Promise<string> {
  const resolvedDirectory = resolve(backupDirectory)
  mkdirSync(resolvedDirectory, { recursive: true })
  const destination = join(
    resolvedDirectory,
    `gacha-task-manager-manual-${timestampKey(reference)}-${String(reference.getMilliseconds()).padStart(3, '0')}.sqlite`
  )
  const temporaryDestination = `${destination}.tmp`
  try {
    await database.backupTo(temporaryDestination)
    verifyBackupIntegrity(temporaryDestination)
    renameSync(temporaryDestination, destination)
    return destination
  } catch (error) {
    if (existsSync(temporaryDestination)) rmSync(temporaryDestination)
    throw error
  }
}

async function createPreRestoreBackup(
  database: AppDatabase,
  backupDirectory: string,
  reference = new Date()
): Promise<string> {
  const resolvedDirectory = resolve(backupDirectory)
  mkdirSync(resolvedDirectory, { recursive: true })
  const destination = join(
    resolvedDirectory,
    `gacha-task-manager-before-restore-${timestampKey(reference)}-${String(reference.getMilliseconds()).padStart(3, '0')}.sqlite`
  )
  const temporaryDestination = `${destination}.tmp`
  try {
    await database.backupTo(temporaryDestination)
    verifyBackupIntegrity(temporaryDestination)
    renameSync(temporaryDestination, destination)
    return destination
  } catch (error) {
    if (existsSync(temporaryDestination)) rmSync(temporaryDestination)
    throw error
  }
}

/**
 * Replaces the live database with a known backup. A safety copy is always written first.
 * On success the supplied AppDatabase has been closed and must not be used again.
 */
export async function restoreBackup(
  database: AppDatabase,
  databasePath: string,
  backupDirectory: string,
  fileName: string,
  reference = new Date()
): Promise<string> {
  const resolvedDirectory = resolve(backupDirectory)
  if (typeof fileName !== 'string' || basename(fileName) !== fileName || !fileName.endsWith('.sqlite')) {
    throw new Error('备份文件名不合法')
  }
  const sourcePath = resolve(resolvedDirectory, fileName)
  if (dirname(sourcePath) !== resolvedDirectory || !existsSync(sourcePath)) {
    throw new Error('找不到指定的备份文件')
  }
  verifyRestorableDatabase(sourcePath)

  const resolvedDatabasePath = resolve(databasePath)
  const temporaryDatabasePath = `${resolvedDatabasePath}.restore.tmp`
  const rollbackDatabasePath = `${resolvedDatabasePath}.restore.rollback`
  rmSync(temporaryDatabasePath, { force: true })
  rmSync(`${temporaryDatabasePath}-wal`, { force: true })
  rmSync(`${temporaryDatabasePath}-shm`, { force: true })
  rmSync(rollbackDatabasePath, { force: true })
  copyFileSync(sourcePath, temporaryDatabasePath)

  try {
    verifyRestorableDatabase(temporaryDatabasePath)
  } catch (error) {
    rmSync(temporaryDatabasePath, { force: true })
    rmSync(`${temporaryDatabasePath}-wal`, { force: true })
    rmSync(`${temporaryDatabasePath}-shm`, { force: true })
    throw error
  }

  const safetyBackupPath = await createPreRestoreBackup(database, resolvedDirectory, reference)
  database.close()

  let originalMoved = false
  try {
    if (existsSync(resolvedDatabasePath)) {
      renameSync(resolvedDatabasePath, rollbackDatabasePath)
      originalMoved = true
    }
    rmSync(`${resolvedDatabasePath}-wal`, { force: true })
    rmSync(`${resolvedDatabasePath}-shm`, { force: true })
    renameSync(temporaryDatabasePath, resolvedDatabasePath)
    rmSync(rollbackDatabasePath, { force: true })
    return safetyBackupPath
  } catch (error) {
    rmSync(temporaryDatabasePath, { force: true })
    rmSync(`${temporaryDatabasePath}-wal`, { force: true })
    rmSync(`${temporaryDatabasePath}-shm`, { force: true })
    if (originalMoved && existsSync(rollbackDatabasePath)) {
      rmSync(resolvedDatabasePath, { force: true })
      renameSync(rollbackDatabasePath, resolvedDatabasePath)
    }
    throw error
  }
}

export function listBackups(backupDirectory: string): BackupSummary[] {
  const resolvedDirectory = resolve(backupDirectory)
  if (!existsSync(resolvedDirectory)) return []
  return readdirSync(resolvedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
    .map((entry): BackupSummary => {
      const stats = statSync(join(resolvedDirectory, entry.name))
      const kind: BackupSummary['kind'] = entry.name.includes('-before-v')
        ? 'pre_migration'
        : entry.name.includes('-before-restore-')
          ? 'pre_restore'
          : entry.name.includes('-manual-')
            ? 'manual'
            : 'daily'
      return {
        fileName: entry.name,
        sizeBytes: stats.size,
        updatedAt: stats.mtime.toISOString(),
        kind
      }
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
}
