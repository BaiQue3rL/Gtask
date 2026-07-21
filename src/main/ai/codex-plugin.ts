import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CodexPluginStatus {
  installed: boolean
  marketplacePath: string
  cachePath: string
  deeplink: string
}

export interface CodexPluginDetectionOptions {
  userHome?: string
  exists?: (path: string) => boolean
  readText?: (path: string) => string
  listDirectory?: (path: string) => string[]
}

export function detectCodexPlugin(
  options: CodexPluginDetectionOptions = {}
): CodexPluginStatus {
  const userHome = options.userHome ?? homedir()
  const exists = options.exists ?? existsSync
  const readText = options.readText ?? ((path: string) => readFileSync(path, 'utf8'))
  const listDirectory = options.listDirectory ?? ((path: string) => readdirSync(path))
  const configPath = join(userHome, '.codex', 'config.toml')
  const marketplacePath = join(userHome, '.agents', 'plugins', 'marketplace.json')
  const cachePath = join(userHome, '.codex', 'plugins', 'cache', 'personal', 'gacha-task-manager')
  let enabled = false
  try {
    if (exists(configPath)) {
      const config = readText(configPath)
      const heading = '[plugins."gacha-task-manager@personal"]'
      const sectionStart = config.indexOf(heading)
      const remainder = sectionStart >= 0 ? config.slice(sectionStart + heading.length) : ''
      const nextSection = remainder.search(/\r?\n\[/)
      const block = nextSection >= 0 ? remainder.slice(0, nextSection) : remainder
      enabled = /^enabled\s*=\s*true\s*$/m.test(block)
    }
  } catch {
    enabled = false
  }

  let cached = false
  try {
    cached = exists(cachePath) && listDirectory(cachePath).length > 0
  } catch {
    cached = false
  }

  return {
    installed: enabled && cached && exists(marketplacePath),
    marketplacePath,
    cachePath,
    deeplink: `codex://plugins/gacha-task-manager?marketplacePath=${encodeURIComponent(marketplacePath)}`
  }
}
