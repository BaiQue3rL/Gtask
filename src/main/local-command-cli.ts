import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppDatabase } from './database'
import { LocalCommandService } from './local-command-service'

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function defaultDatabasePath(): string {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('无法确定 APPDATA，请通过 --database 指定数据库路径')
  return join(appData, 'gacha-task-manager', 'data', 'gacha-task-manager.sqlite')
}

function readRequest(): unknown {
  const inline = argumentValue('--request')
  const content = inline ?? readFileSync(0, 'utf8').trim()
  if (!content) throw new Error('请通过标准输入或 --request 传入 JSON 命令')
  return JSON.parse(content) as unknown
}

const database = new AppDatabase(argumentValue('--database') ?? defaultDatabasePath())
try {
  const result = new LocalCommandService(database).execute(readRequest())
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`)
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '未知错误' })}\n`
  )
  process.exitCode = 1
} finally {
  database.close()
}
