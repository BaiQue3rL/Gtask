import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareCodexPluginMarketplace } from '../src/main/ai/codex-plugin-installer'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Codex plugin installer', () => {
  it('creates a local marketplace and packaged MCP launch command', () => {
    const integrationDirectory = mkdtempSync(join(tmpdir(), 'gacha-codex-plugin-'))
    temporaryDirectories.push(integrationDirectory)
    const executablePath = 'C:\\Apps\\幻游清单\\幻游清单.exe'
    const mcpScriptPath = 'C:\\Apps\\幻游清单\\resources\\app.asar\\out\\main\\local-mcp-server-cli.js'
    const databasePath = 'D:\\Documents\\GachaTaskManager\\data\\gacha-task-manager.sqlite'
    const prepared = prepareCodexPluginMarketplace({
      sourcePluginPath: join(process.cwd(), 'integrations', 'gacha-task-manager'),
      integrationDirectory,
      executablePath,
      mcpScriptPath,
      databasePath
    })

    const marketplace = JSON.parse(readFileSync(prepared.marketplacePath, 'utf8'))
    const mcp = JSON.parse(readFileSync(join(prepared.pluginPath, '.mcp.json'), 'utf8'))
    expect(marketplace).toMatchObject({
      name: 'gacha-task-manager-app',
      plugins: [{
        name: 'gacha-task-manager',
        source: { source: 'local', path: './plugins/gacha-task-manager' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }
      }]
    })
    expect(mcp.mcpServers.gacha_task_manager).toEqual({
      command: executablePath,
      args: [mcpScriptPath, '--database', databasePath],
      cwd: 'C:\\Apps\\幻游清单',
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
    expect(decodeURIComponent(prepared.deeplink)).toContain(prepared.marketplacePath)
  })
})
