import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  prepareCodexPluginMarketplace,
  prepareStableMcpElectronRuntime,
  refreshCodexMcpLauncher
} from '../src/main/ai/codex-plugin-installer'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('Codex plugin installer', () => {
  it('persists the minimal Electron Node runtime outside portable temp folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'gacha-codex-runtime-'))
    temporaryDirectories.push(root)
    const sourceDirectory = join(root, 'portable-temp')
    const integrationDirectory = join(root, 'AppData', 'gtask', 'codex-integration')
    mkdirSync(sourceDirectory, { recursive: true })
    const sourceExecutable = join(sourceDirectory, 'Gtask.exe')
    writeFileSync(sourceExecutable, 'electron')
    for (const name of ['icudtl.dat', 'snapshot_blob.bin', 'v8_context_snapshot.bin']) {
      writeFileSync(join(sourceDirectory, name), name)
    }

    const executablePath = prepareStableMcpElectronRuntime(
      sourceExecutable,
      integrationDirectory,
      '0.1.0-rc.20'
    )

    expect(executablePath).toBe(join(
      integrationDirectory,
      'electron-node',
      '0.1.0-rc.20',
      'gtask-mcp-node.exe'
    ))
    expect(readFileSync(executablePath, 'utf8')).toBe('electron')
    expect(readFileSync(
      join(integrationDirectory, 'electron-node', '0.1.0-rc.20', 'icudtl.dat'),
      'utf8'
    )).toBe('icudtl.dat')
  })

  it('uses the auto-discovered personal marketplace and a stable MCP launcher', () => {
    const root = mkdtempSync(join(tmpdir(), 'gacha-codex-plugin-'))
    temporaryDirectories.push(root)
    const integrationDirectory = join(root, 'AppData', 'gacha-task-manager', 'codex-integration')
    const personalMarketplacePath = join(root, '.agents', 'plugins', 'marketplace.json')
    const personalPluginPath = join(root, 'plugins', 'gacha-task-manager')
    const executablePath = 'C:\\Apps\\Gtask\\Gtask.exe'
    const mcpScriptPath = 'C:\\Apps\\Gtask\\resources\\app.asar\\out\\main\\local-mcp-server-cli.js'
    const databasePath = 'D:\\Documents\\GachaTaskManager\\data\\gacha-task-manager.sqlite'
    const prepared = prepareCodexPluginMarketplace({
      sourcePluginPath: join(process.cwd(), 'integrations', 'gacha-task-manager'),
      integrationDirectory,
      personalMarketplacePath,
      personalPluginPath,
      executablePath,
      mcpScriptPath,
      databasePath,
      commandShellPath: 'C:\\Windows\\System32\\cmd.exe'
    })

    const marketplace = JSON.parse(readFileSync(prepared.marketplacePath, 'utf8'))
    const mcp = JSON.parse(readFileSync(join(prepared.pluginPath, '.mcp.json'), 'utf8'))
    const launcher = readFileSync(prepared.launcherPath, 'utf8')
    expect(marketplace).toMatchObject({
      name: 'personal',
      plugins: [{
        name: 'gacha-task-manager',
        source: { source: 'local', path: './plugins/gacha-task-manager' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }
      }]
    })
    expect(mcp.mcpServers.gacha_task_manager).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/c', prepared.launcherPath],
      cwd: integrationDirectory
    })
    expect(launcher).not.toContain('start ""')
    expect(launcher).toContain(`if not exist "${executablePath}" exit /b 2`)
    expect(launcher).toContain(`if not exist "${mcpScriptPath}" exit /b 3`)
    expect(launcher).toContain(
      `"${executablePath}" "${mcpScriptPath}" --database "${databasePath}"`
    )
    expect(decodeURIComponent(prepared.deeplink)).toContain(personalMarketplacePath)
  })

  it.runIf(process.platform === 'win32')('missing MCP runtime exits silently without invoking Windows start', () => {
    const root = mkdtempSync(join(tmpdir(), 'gacha-codex-launcher-'))
    temporaryDirectories.push(root)
    const launcherPath = refreshCodexMcpLauncher({
      integrationDirectory: root,
      executablePath: join(root, 'missing-runtime', 'gtask-mcp-node.exe'),
      mcpScriptPath: join(root, 'missing-runtime', 'local-mcp-server-cli.js'),
      databasePath: join(root, 'data', 'gacha-task-manager.sqlite'),
      commandShellPath: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
    })

    const result = spawnSync(
      process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/c', launcherPath],
      { encoding: 'utf8', windowsHide: true, timeout: 5_000 }
    )

    expect(result.status).toBe(2)
    expect(result.error).toBeUndefined()
  })

  it('preserves unrelated personal marketplace plugins', () => {
    const root = mkdtempSync(join(tmpdir(), 'gacha-codex-plugin-'))
    temporaryDirectories.push(root)
    const marketplacePath = join(root, '.agents', 'plugins', 'marketplace.json')
    const integrationDirectory = join(root, 'integration')
    const pluginPath = join(root, 'plugins', 'gacha-task-manager')
    mkdirSync(join(root, '.agents', 'plugins'), { recursive: true })
    writeFileSync(marketplacePath, JSON.stringify({
      name: 'personal',
      interface: { displayName: 'My plugins' },
      plugins: [{
        name: 'other-plugin',
        source: { source: 'local', path: './plugins/other-plugin' },
        policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
        category: 'Developer tools'
      }]
    }), { encoding: 'utf8', flag: 'w' })

    prepareCodexPluginMarketplace({
      sourcePluginPath: join(process.cwd(), 'integrations', 'gacha-task-manager'),
      integrationDirectory,
      personalMarketplacePath: marketplacePath,
      personalPluginPath: pluginPath,
      executablePath: 'C:\\Apps\\Gtask.exe',
      mcpScriptPath: 'C:\\Apps\\resources\\app.asar\\mcp.js',
      databasePath: 'D:\\Documents\\GachaTaskManager\\data\\db.sqlite',
      commandShellPath: 'C:\\Windows\\System32\\cmd.exe'
    })

    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'))
    expect(marketplace.interface.displayName).toBe('My plugins')
    expect(marketplace.plugins.map((plugin: { name: string }) => plugin.name)).toEqual([
      'other-plugin',
      'gacha-task-manager'
    ])
  })
})
