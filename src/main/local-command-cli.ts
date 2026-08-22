import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppDatabase } from './database'
import { openDatabaseWithMigrationBackup } from './database-bootstrap'
import { LocalCommandService } from './local-command-service'

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function defaultDatabasePath(): string {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('无法确定 APPDATA，请通过 --database 指定数据库路径')
  return join(appData, 'gtask', 'data', 'gtask.sqlite')
}

function readRequest(): unknown {
  const inline = argumentValue('--request')
  const base64 = argumentValue('--request-base64')
  const requestFile = argumentValue('--request-file')
  const content = inline
    ?? (base64 ? Buffer.from(base64, 'base64').toString('utf8') : undefined)
    ?? (requestFile ? readFileSync(requestFile, 'utf8') : undefined)
    ?? readFileSync(0, 'utf8').trim()
  if (!content) {
    throw new Error('请通过标准输入、--request、--request-base64 或 --request-file 传入 JSON 命令')
  }
  return JSON.parse(content) as unknown
}

async function main(): Promise<void> {
  let database: AppDatabase | null = null
  try {
    database = await openDatabaseWithMigrationBackup(
      argumentValue('--database') ?? defaultDatabasePath()
    )
    const result = new LocalCommandService(database).execute(readRequest())
    process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`)
  } finally {
    database?.close()
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : '未知错误' })}\n`
  )
  process.exitCode = 1
})
