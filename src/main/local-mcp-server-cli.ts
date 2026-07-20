import { startLocalMcpServerProcess } from './local-mcp-runtime'

async function main(): Promise<void> {
  await startLocalMcpServerProcess()
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'MCP 服务启动失败'}\n`)
  process.exitCode = 1
})
