import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { backupDirectoryForDatabase, openDatabaseWithMigrationBackup } from './database-bootstrap'
import { createLocalMcpServer } from './local-mcp-server'

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function defaultDatabasePath(): string {
  throw new Error('请通过 --database 指定 Gtask 数据库路径；不会在默认目录新建另一份数据库')
}

export async function startLocalMcpServerProcess(): Promise<void> {
  const databasePath = argumentValue('--database') ?? defaultDatabasePath()
  const backupDirectory = backupDirectoryForDatabase(databasePath)
  const database = await openDatabaseWithMigrationBackup(databasePath, backupDirectory)
  const server = createLocalMcpServer(database, { backupDirectory })
  let closed = false

  const closeDatabase = (): void => {
    if (closed) return
    closed = true
    database.close()
  }

  process.once('SIGINT', async () => {
    await server.close()
    closeDatabase()
    process.exit(0)
  })
  process.once('exit', closeDatabase)

  try {
    await server.connect(new StdioServerTransport())
  } catch (error) {
    closeDatabase()
    throw error
  }
}
