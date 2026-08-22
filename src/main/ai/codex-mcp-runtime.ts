import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'

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
const LEGACY_MCP_LAUNCHER_NAME = 'launch-gacha-mcp.cmd'

export function hasCodexMcpLauncher(integrationDirectory: string): boolean {
  return [
    join(integrationDirectory, 'launch-gtask-mcp.cmd'),
    join(integrationDirectory, LEGACY_MCP_LAUNCHER_NAME)
  ].some((path) => existsSync(path))
}

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

function checkedBatchValue(value: string): string {
  if (/[\r\n"]/.test(value)) throw new Error('Codex MCP 启动路径包含不支持的字符')
  return value.replaceAll('%', '%%')
}

export function refreshCodexMcpLauncher(options: CodexMcpLauncherOptions): string {
  const launcherPath = join(options.integrationDirectory, 'launch-gtask-mcp.cmd')
  const legacyLauncherPath = join(options.integrationDirectory, LEGACY_MCP_LAUNCHER_NAME)
  mkdirSync(options.integrationDirectory, { recursive: true })
  const executablePath = checkedBatchValue(options.executablePath)
  const mcpScriptPath = checkedBatchValue(options.mcpScriptPath)
  const databasePath = checkedBatchValue(options.databasePath)
  writeFileSync(launcherPath, [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal',
    'set "ELECTRON_RUN_AS_NODE=1"',
    `if not exist "${executablePath}" exit /b 2`,
    `if not exist "${mcpScriptPath}" exit /b 3`,
    `"${executablePath}" "${mcpScriptPath}" --database "${databasePath}"`,
    'exit /b %errorlevel%',
    ''
  ].join('\r\n'), 'utf8')
  if (existsSync(legacyLauncherPath)) rmSync(legacyLauncherPath)
  return launcherPath
}
