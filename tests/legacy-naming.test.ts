import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const ignoredDirectories = new Set(['.git', 'node_modules', 'out', 'release', 'tmp'])
const compatibilityFiles = new Set([
  'src/main/data-paths.ts',
  'src/main/database.ts',
  'src/main/ai/codex-mcp-runtime.ts',
  'src/renderer/src/game-visibility.ts',
  'tests/data-paths.test.ts',
  'tests/database.test.ts',
  'tests/codex-mcp-runtime.test.ts',
  'tests/game-visibility.test.ts',
  'tests/legacy-naming.test.ts'
])
const retiredIdentifiers = [
  'GachaTaskManager',
  'gacha-task-manager',
  'gacha_task_manager',
  'com.gachataskmanager.app',
  'gacha-app-background-worker',
  'CODEX_GACHA_BACKGROUND',
  'gacha-chatgpt-http',
  'gacha-verification://',
  'gacha://',
  'sync-gacha-schedules',
  'launch-gacha-mcp',
  'window.gacha',
  'GachaApi'
]

function textFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : textFiles(join(directory, entry.name))
    }
    return entry.isFile() ? [join(directory, entry.name)] : []
  })
}

describe('retired product naming', () => {
  it('is isolated to explicit one-time compatibility migrations', () => {
    const root = process.cwd()
    const offenders = textFiles(root).flatMap((file) => {
      const path = relative(root, file).replaceAll('\\', '/')
      if (compatibilityFiles.has(path)) return []
      const buffer = readFileSync(file)
      if (buffer.includes(0)) return []
      const content = buffer.toString('utf8')
      return retiredIdentifiers
        .filter((identifier) => content.includes(identifier))
        .map((identifier) => `${path}: ${identifier}`)
    })

    expect(offenders).toEqual([])
  })
})
