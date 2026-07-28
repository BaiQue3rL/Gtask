import { execFile } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

export interface PreparedCodexPluginMarketplace {
  marketplacePath: string
  pluginPath: string
  launcherPath: string
  deeplink: string
}

export interface CodexMcpLauncherOptions {
  integrationDirectory: string
  executablePath: string
  mcpScriptPath: string
  databasePath: string
  commandShellPath: string
}

const ELECTRON_NODE_SUPPORT_FILES = [
  'icudtl.dat',
  'snapshot_blob.bin',
  'v8_context_snapshot.bin'
] as const

export function prepareStableMcpElectronRuntime(
  sourceExecutable: string,
  integrationDirectory: string,
  runtimeVersion: string
): string {
  const safeVersion = runtimeVersion.trim().replace(/[^a-zA-Z0-9._-]/g, '-')
  if (!safeVersion) throw new Error('MCP 运行时版本不能为空')
  const sourceDirectory = dirname(sourceExecutable)
  const runtimeDirectory = join(integrationDirectory, 'electron-node', safeVersion)
  const executablePath = join(runtimeDirectory, 'gtask-mcp-node.exe')
  const requiredFiles = [
    { source: sourceExecutable, destination: executablePath },
    ...ELECTRON_NODE_SUPPORT_FILES.map((name) => ({
      source: join(sourceDirectory, name),
      destination: join(runtimeDirectory, name)
    }))
  ]
  if (requiredFiles.every(({ destination }) => existsSync(destination))) {
    return executablePath
  }

  mkdirSync(runtimeDirectory, { recursive: true })
  for (const { source, destination } of requiredFiles) {
    if (!existsSync(source)) throw new Error(`MCP 运行时缺少文件：${source}`)
    if (existsSync(destination)) continue
    try {
      linkSync(source, destination)
    } catch {
      copyFileSync(source, destination)
    }
  }
  return executablePath
}

export interface PrepareCodexPluginOptions extends CodexMcpLauncherOptions {
  sourcePluginPath: string
  personalMarketplacePath: string
  personalPluginPath: string
}

interface MarketplaceDocument {
  name: string
  interface?: { displayName?: string }
  plugins: Array<Record<string, unknown>>
}

const PLUGIN_NAME = 'gacha-task-manager'
const PERSONAL_PLUGIN_ID = `${PLUGIN_NAME}@personal`

export interface CodexPluginInstallResult {
  pluginId: string
  version: string
  installedPath: string
  message: string
}

function checkedBatchValue(value: string): string {
  if (/[\r\n"]/.test(value)) throw new Error('Codex MCP 启动路径包含不支持的字符')
  return value.replaceAll('%', '%%')
}

export function refreshCodexMcpLauncher(options: CodexMcpLauncherOptions): string {
  const launcherPath = join(options.integrationDirectory, 'launch-gacha-mcp.cmd')
  mkdirSync(options.integrationDirectory, { recursive: true })
  const executablePath = checkedBatchValue(options.executablePath)
  const mcpScriptPath = checkedBatchValue(options.mcpScriptPath)
  const databasePath = checkedBatchValue(options.databasePath)
  writeFileSync(launcherPath, [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `start "" /wait /b "${executablePath}" "${mcpScriptPath}" --database "${databasePath}"`,
    'exit /b %errorlevel%',
    ''
  ].join('\r\n'), 'utf8')
  return launcherPath
}

function readOrCreatePersonalMarketplace(path: string): MarketplaceDocument {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as MarketplaceDocument
    if (parsed.name !== 'personal' || !Array.isArray(parsed.plugins)) {
      throw new Error('默认 Codex marketplace 格式不兼容')
    }
    return parsed
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('默认 Codex marketplace 不是有效 JSON')
    if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error
    return {
      name: 'personal',
      interface: { displayName: 'Personal' },
      plugins: []
    }
  }
}

export function prepareCodexPluginMarketplace(
  options: PrepareCodexPluginOptions
): PreparedCodexPluginMarketplace {
  const pluginPath = options.personalPluginPath
  const marketplacePath = options.personalMarketplacePath
  const launcherPath = refreshCodexMcpLauncher(options)
  mkdirSync(dirname(pluginPath), { recursive: true })
  cpSync(options.sourcePluginPath, pluginPath, { recursive: true, force: true })

  const manifestPath = join(pluginPath, '.codex-plugin', 'plugin.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  if (manifest.name !== PLUGIN_NAME) throw new Error('内置 Codex 插件清单格式不正确')
  writeFileSync(join(pluginPath, '.mcp.json'), `${JSON.stringify({
    mcpServers: {
      gacha_task_manager: {
        command: options.commandShellPath,
        args: ['/d', '/c', launcherPath],
        cwd: options.integrationDirectory
      }
    }
  }, null, 2)}\n`, 'utf8')

  const marketplace = readOrCreatePersonalMarketplace(marketplacePath)
  const entry = {
    name: PLUGIN_NAME,
    source: { source: 'local', path: `./plugins/${PLUGIN_NAME}` },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
    category: 'Productivity'
  }
  const existingIndex = marketplace.plugins.findIndex((candidate) => candidate.name === PLUGIN_NAME)
  if (existingIndex >= 0) marketplace.plugins[existingIndex] = entry
  else marketplace.plugins.push(entry)
  marketplace.interface ??= { displayName: 'Personal' }
  marketplace.interface.displayName ||= 'Personal'
  mkdirSync(dirname(marketplacePath), { recursive: true })
  writeFileSync(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, 'utf8')

  return {
    marketplacePath,
    pluginPath,
    launcherPath,
    deeplink: `codex://plugins/${PLUGIN_NAME}?marketplacePath=${encodeURIComponent(marketplacePath)}`
  }
}

export async function installCodexPluginFromPersonalMarketplace(
  codexCliPath: string
): Promise<CodexPluginInstallResult> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      codexCliPath,
      ['plugin', 'add', PERSONAL_PLUGIN_ID, '--json'],
      { windowsHide: true, timeout: 30_000 },
      (error, output, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message
          reject(new Error(`Codex 插件更新失败：${detail}`))
          return
        }
        resolve(output)
      }
    )
  })

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new Error('Codex 插件更新完成，但返回结果无法识别')
  }
  if (
    payload.pluginId !== PERSONAL_PLUGIN_ID ||
    typeof payload.version !== 'string' ||
    typeof payload.installedPath !== 'string'
  ) {
    throw new Error('Codex 未返回有效的插件安装结果')
  }
  return {
    pluginId: payload.pluginId,
    version: payload.version,
    installedPath: payload.installedPath,
    message: `插件已更新至 ${payload.version}`
  }
}
