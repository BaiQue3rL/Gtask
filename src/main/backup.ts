import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import type { AppDatabase } from './database'

function localDateKey(reference: Date): string {
  const year = reference.getFullYear()
  const month = String(reference.getMonth() + 1).padStart(2, '0')
  const day = String(reference.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
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
    await backup(source, destination)
    return destination
  } finally {
    source.close()
  }
}
