import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import {
  hasCodexMcpLauncher,
  prepareStableMcpElectronRuntime,
  refreshCodexMcpLauncher
} from '../src/main/ai/codex-mcp-runtime'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('Codex MCP runtime', () => {
  it('does not provision a maintainer runtime for ordinary users', () => {
    const root = mkdtempSync(join(tmpdir(), 'gtask-codex-launcher-detection-'))
    temporaryDirectories.push(root)
    expect(hasCodexMcpLauncher(root)).toBe(false)
    const currentLauncher = join(root, 'launch-gtask-mcp.cmd')
    writeFileSync(currentLauncher, 'current')
    expect(hasCodexMcpLauncher(root)).toBe(true)
    rmSync(currentLauncher)
    writeFileSync(join(root, 'launch-gacha-mcp.cmd'), 'retired')
    expect(hasCodexMcpLauncher(root)).toBe(true)
  })

  it('persists the minimal Electron Node runtime outside portable temp folders', () => {
    const root = mkdtempSync(join(tmpdir(), 'gtask-codex-runtime-'))
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
      '1.1.0'
    )

    expect(executablePath).toBe(join(
      integrationDirectory,
      'electron-node',
      '1.1.0',
      'gtask-mcp-node.exe'
    ))
    expect(readFileSync(executablePath, 'utf8')).toBe('electron')
    expect(readFileSync(
      join(integrationDirectory, 'electron-node', '1.1.0', 'icudtl.dat'),
      'utf8'
    )).toBe('icudtl.dat')
  })

  it.runIf(process.platform === 'win32')(
    'missing MCP runtime exits silently without invoking Windows start',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'gtask-codex-launcher-'))
      temporaryDirectories.push(root)
      const legacyLauncherPath = join(root, 'launch-gacha-mcp.cmd')
      writeFileSync(legacyLauncherPath, 'retired')
      const launcherPath = refreshCodexMcpLauncher({
        integrationDirectory: root,
        executablePath: join(root, 'missing-runtime', 'gtask-mcp-node.exe'),
        mcpScriptPath: join(root, 'missing-runtime', 'local-mcp-server-cli.js'),
        databasePath: join(root, 'data', 'gtask.sqlite'),
        commandShellPath: process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'
      })

      const result = spawnSync(
        process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/c', launcherPath],
        { encoding: 'utf8', windowsHide: true, timeout: 5_000 }
      )

      expect(result.status).toBe(2)
      expect(result.error).toBeUndefined()
      expect(() => readFileSync(legacyLauncherPath)).toThrow()
    }
  )
})
