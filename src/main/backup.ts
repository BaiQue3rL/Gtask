import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
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
