import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AppDatabase } from '../src/main/database'
import { createLocalMcpServer } from '../src/main/local-mcp-server'
import { createDailyBackup } from '../src/main/backup'

let database: AppDatabase | null = null
let server: McpServer | null = null
let client: Client | null = null
let temporaryDirectory: string | null = null

afterEach(async () => {
  await client?.close()
  await server?.close()
  database?.close()
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  client = null
  server = null
  database = null
  temporaryDirectory = null
})

async function connect(): Promise<Client> {
  database = new AppDatabase(':memory:')
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-mcp-resource-test-'))
  await createDailyBackup(database, temporaryDirectory, new Date('2026-07-20T08:00:00+08:00'))
  server = createLocalMcpServer(database, { backupDirectory: temporaryDirectory })
  client = new Client({ name: 'gacha-test-client', version: '1.0.0' })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return client
}

describe('本地 MCP server', () => {
  it('公布读写工具并通过协议读取四游戏清单', async () => {
    const connected = await connect()
    const tools = await connected.listTools()
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      'describe_gacha_commands',
      'read_gacha_checklists',
      'write_gacha_checklists',
      'create_gacha_item',
      'update_gacha_item',
      'restore_gacha_item',
      'archive_gacha_item',
      'archive_completed_gacha_section'
    ])

    const response = await connected.callTool({
      name: 'read_gacha_checklists',
      arguments: {}
    })
    expect(response.isError).not.toBe(true)
    expect(response.structuredContent).toMatchObject({
      command: 'get_all_snapshots',
      snapshots: [
        { game: { id: 'genshin' } },
        { game: { id: 'star-rail' } },
        { game: { id: 'zenless' } },
        { game: { id: 'wuthering-waves' } }
      ]
    })

    const resources = await connected.listResources()
    expect(resources.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ uri: 'gacha://backups' })])
    )
    const backupResource = await connected.readResource({ uri: 'gacha://backups' })
    const backupContent = backupResource.contents[0]
    if (!('text' in backupContent)) throw new Error('备份资源不是文本 JSON')
    expect(JSON.parse(backupContent.text)).toMatchObject({
      backups: [expect.objectContaining({ kind: 'daily' })]
    })
  })

  it('通过协议写入并保留删除显式确认保护', async () => {
    const connected = await connect()
    const created = await connected.callTool({
      name: 'create_gacha_item',
      arguments: {
        gameId: 'genshin',
        category: 'custom',
        title: 'MCP 新增事项'
      }
    })
    expect(created.isError).not.toBe(true)
    expect(created.structuredContent).toMatchObject({
      command: 'create_item',
      item: { title: 'MCP 新增事项' }
    })

    const item = (created.structuredContent as { item: { id: string } }).item
    const rejected = await connected.callTool({
      name: 'archive_gacha_item',
      arguments: { id: item.id, confirm: false }
    })
    expect(rejected.isError).toBe(true)
    expect(rejected.content).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('confirm: true') })])
    )
  })
})
