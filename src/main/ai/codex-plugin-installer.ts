import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface PreparedCodexPluginMarketplace {
  marketplacePath: string
  pluginPath: string
  deeplink: string
}

export interface PrepareCodexPluginOptions {
  sourcePluginPath: string
  integrationDirectory: string
  executablePath: string
  mcpScriptPath: string
}

export function prepareCodexPluginMarketplace(
  options: PrepareCodexPluginOptions
): PreparedCodexPluginMarketplace {
  const pluginPath = join(options.integrationDirectory, 'plugins', 'gacha-task-manager')
  const marketplacePath = join(options.integrationDirectory, 'marketplace.json')
  mkdirSync(dirname(pluginPath), { recursive: true })
  cpSync(options.sourcePluginPath, pluginPath, { recursive: true, force: true })

  const manifestPath = join(pluginPath, '.codex-plugin', 'plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  if (manifest.name !== 'gacha-task-manager') throw new Error('内置 Codex 插件清单格式不正确')
  writeFileSync(join(pluginPath, '.mcp.json'), `${JSON.stringify({
    mcpServers: {
      gacha_task_manager: {
        command: options.executablePath,
        args: [options.mcpScriptPath],
        cwd: dirname(options.executablePath),
        env: { ELECTRON_RUN_AS_NODE: '1' }
      }
    }
  }, null, 2)}\n`, 'utf8')
  writeFileSync(marketplacePath, `${JSON.stringify({
    name: 'gacha-task-manager-app',
    interface: { displayName: '幻游清单' },
    plugins: [{
      name: 'gacha-task-manager',
      source: { source: 'local', path: './plugins/gacha-task-manager' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity'
    }]
  }, null, 2)}\n`, 'utf8')

  return {
    marketplacePath,
    pluginPath,
    deeplink: `codex://plugins/gacha-task-manager?marketplacePath=${encodeURIComponent(marketplacePath)}`
  }
}
