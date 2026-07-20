import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { AppDatabase } from './database'
import type { BackupSummary } from '../shared/contracts'

function localDateKey(reference: Date): string {
  const year = reference.getFullYear()
  const month = String(reference.getMonth() + 1).padStart(2, '0')
  const day = String(reference.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function verifyBackupIntegrity(databasePath: string): void {
  const backupDatabase = new DatabaseSync(databasePath)
  try {
    const row = backupDatabase.prepare('PRAGMA quick_check').get() as Record<string, unknown>
    if (Object.values(row)[0] !== 'ok') throw new Error('SQLite 备份完整性检查失败')
  } finally {
    backupDatabase.close()
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

export function listBackups(backupDirectory: string): BackupSummary[] {
  const resolvedDirectory = resolve(backupDirectory)
  if (!existsSync(resolvedDirectory)) return []
  return readdirSync(resolvedDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
    .map((entry): BackupSummary => {
      const stats = statSync(join(resolvedDirectory, entry.name))
      const kind: BackupSummary['kind'] = entry.name.includes('-before-v')
        ? 'pre_migration'
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
