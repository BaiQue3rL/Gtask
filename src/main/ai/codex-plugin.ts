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
  appMarketplacePath?: string
}

export function detectCodexPlugin(
  options: CodexPluginDetectionOptions = {}
): CodexPluginStatus {
  const userHome = options.userHome ?? homedir()
  const exists = options.exists ?? existsSync
  const readText = options.readText ?? ((path: string) => readFileSync(path, 'utf8'))
  const listDirectory = options.listDirectory ?? ((path: string) => readdirSync(path))
  const configPath = join(userHome, '.codex', 'config.toml')
  const personalMarketplacePath = join(userHome, '.agents', 'plugins', 'marketplace.json')
  const cacheRoot = join(userHome, '.codex', 'plugins', 'cache')
  let enabled = false
  let marketplaceName = 'personal'
  try {
    if (exists(configPath)) {
      const config = readText(configPath)
      const matches = [...config.matchAll(
        /\[plugins\."gacha-task-manager@([^"]+)"\]([\s\S]*?)(?=\r?\n\[|$)/g
      )]
      const active = matches.find((match) => /^enabled\s*=\s*true\s*$/m.test(match[2]))
      marketplaceName = active?.[1] ?? matches[0]?.[1] ?? marketplaceName
      enabled = Boolean(active)
    }
  } catch {
    enabled = false
  }

  let cachePath = join(cacheRoot, marketplaceName, 'gacha-task-manager')
  let cached = false
  try {
    cached = exists(cachePath) && listDirectory(cachePath).length > 0
  } catch {
    cached = false
  }

  const marketplacePath = marketplaceName === 'personal'
    ? personalMarketplacePath
    : options.appMarketplacePath ?? personalMarketplacePath
  return {
    installed: enabled && cached,
    marketplacePath,
    cachePath,
    deeplink: `codex://plugins/gacha-task-manager?marketplacePath=${encodeURIComponent(marketplacePath)}`
  }
}
