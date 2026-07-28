import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const configPath = argument('--config')
if (!configPath) throw new Error('需要 --config 指向插件 .mcp.json')
const document = JSON.parse(readFileSync(resolve(configPath), 'utf8'))
const server = document.mcpServers?.gacha_task_manager
if (!server?.command || !Array.isArray(server.args)) {
  throw new Error('插件 MCP 配置缺少 gacha_task_manager')
}

const client = new Client({ name: 'gacha-plugin-smoke-test', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: server.command,
  args: server.args,
  cwd: server.cwd,
  env: { ...process.env, ...(server.env ?? {}) },
  stderr: 'pipe'
})
transport.stderr?.on('data', (chunk) => process.stderr.write(chunk))

try {
  await client.connect(transport)
  const tools = await client.listTools()
  const snapshot = await client.callTool({
    name: 'read_gacha_checklists',
    arguments: {}
  })
  if (snapshot.isError) throw new Error('插件 MCP 读取清单失败')
  const snapshots = snapshot.structuredContent?.snapshots
  if (!Array.isArray(snapshots) || snapshots.length !== 4) {
    throw new Error('插件 MCP 未返回四款游戏')
  }
  process.stdout.write(`${JSON.stringify({
    toolCount: tools.tools.length,
    gameCount: snapshots.length,
    gameIds: snapshots.map((entry) => entry.game?.id)
  }, null, 2)}\n`)
} finally {
  await client.close()
}
