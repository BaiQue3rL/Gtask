import { join, resolve } from 'node:path'

export const APP_DATA_DIRECTORY_NAME = 'GachaTaskManager'

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
    database: join(root, 'data', 'gacha-task-manager.sqlite'),
    backups: join(root, 'backups'),
    logs: join(root, 'logs')
  }
}
