import { mkdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const executable = argument('--executable')
const script = argument('--script')
const database = argument('--database')
if (!executable || !script || !database) {
  throw new Error('需要 --executable、--script 和 --database')
}

const resolvedDatabase = resolve(database)
mkdirSync(dirname(resolvedDatabase), { recursive: true })
const client = new Client({ name: 'packaged-smoke-test', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: resolve(executable),
  args: [resolve(script), '--database', resolvedDatabase],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stderr: 'pipe'
})

try {
  await client.connect(transport)
  const tools = await client.listTools()
  const snapshot = await client.callTool({
    name: 'read_gtask_checklists',
    arguments: {}
  })
  if (snapshot.isError) throw new Error('打包 MCP 读取清单失败')
  const snapshots = snapshot.structuredContent?.snapshots
  if (!Array.isArray(snapshots) || snapshots.length !== 4) {
    throw new Error('打包 MCP 未返回四款游戏')
  }
  process.stdout.write(`${JSON.stringify({
    toolCount: tools.tools.length,
    gameCount: snapshots.length,
    gameIds: snapshots.map((entry) => entry.game?.id)
  }, null, 2)}\n`)
} finally {
  await client.close()
  if (argument('--cleanup') === 'true') {
    rmSync(dirname(resolvedDatabase), { recursive: true, force: true })
  }
}
