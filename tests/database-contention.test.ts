import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database'

let temporaryDirectory: string | null = null
let database: AppDatabase | null = null

afterEach(() => {
  database?.close()
  database = null
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe('SQLite 多进程写入竞争', () => {
  it('等待 MCP 写事务释放，而不是立即抛出 database is locked', async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-sqlite-contention-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    const script = `
      const { DatabaseSync } = require('node:sqlite')
      const database = new DatabaseSync(process.argv[1])
      database.exec('PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE')
      process.stdout.write('ready\\n')
      setTimeout(() => {
        database.exec('COMMIT')
        database.close()
      }, 250)
    `
    const child = spawn(process.execPath, ['-e', script, databasePath], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.once('data', () => resolve())
      child.once('error', reject)
      child.stderr.once('data', (chunk) => reject(new Error(String(chunk))))
    })
    await ready

    const startedAt = Date.now()
    const item = database.createChecklistItem({
      gameId: 'genshin',
      category: 'custom',
      title: '并发写入等待测试'
    })

    expect(item.title).toBe('并发写入等待测试')
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150)
    await once(child, 'exit')
  }, 10_000)
})
