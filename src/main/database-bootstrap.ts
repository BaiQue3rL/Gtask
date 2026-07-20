import { basename, dirname, join } from 'node:path'
import { createPreMigrationBackup } from './backup'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from './database'

export function backupDirectoryForDatabase(databasePath: string): string {
  const databaseDirectory = dirname(databasePath)
  return basename(databaseDirectory).toLowerCase() === 'data'
    ? join(dirname(databaseDirectory), 'backups')
    : join(databaseDirectory, 'backups')
}

export async function openDatabaseWithMigrationBackup(
  databasePath: string,
  backupDirectory = backupDirectoryForDatabase(databasePath)
): Promise<AppDatabase> {
  await createPreMigrationBackup(databasePath, backupDirectory, CURRENT_SCHEMA_VERSION)
  return new AppDatabase(databasePath)
}
