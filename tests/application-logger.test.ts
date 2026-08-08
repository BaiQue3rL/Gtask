import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ApplicationLogger } from '../src/main/application-logger'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gtask-logs-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('application logger', () => {
  it('stores structured logs and redacts sensitive values', () => {
    const directory = temporaryDirectory()
    const logger = new ApplicationLogger(directory, {
      now: () => new Date('2026-08-03T12:00:00.000Z')
    })

    logger.error('sync_failed', {
      gameId: 'genshin',
      token: 'do-not-store',
      message: 'phone=13800138000 authorization=Bearer-secret'
    })

    const entry = JSON.parse(readFileSync(logger.filePath, 'utf8').trim())
    expect(entry).toMatchObject({
      timestamp: '2026-08-03T12:00:00.000Z',
      level: 'error',
      event: 'sync_failed',
      details: {
        gameId: 'genshin',
        token: '[redacted]'
      }
    })
    expect(entry.details.message).not.toContain('13800138000')
    expect(entry.details.message).not.toContain('Bearer-secret')
  })

  it('rotates the active log while keeping a bounded history', () => {
    const directory = temporaryDirectory()
    const logger = new ApplicationLogger(directory, {
      maximumBytes: 1024,
      retainedFiles: 2
    })

    for (let index = 0; index < 40; index += 1) {
      logger.info('rotation_test', { index, text: 'x'.repeat(120) })
    }

    expect(readdirSync(directory).sort()).toEqual([
      'gtask.log',
      'gtask.log.1',
      'gtask.log.2'
    ])
  })
})
