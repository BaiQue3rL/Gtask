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
      'archive_completed_gacha_section',
      'register_gacha_schedule_agent',
      'claim_gacha_schedule_job',
      'update_gacha_schedule_job_progress',
      'claim_gacha_semantic_review',
      'approve_gacha_semantic_review',
      'reject_gacha_semantic_review',
      'apply_gacha_public_schedule',
      'fail_gacha_schedule_job'
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

  it('通过 Agent 心跳、任务领取和专用工具安全写入公开排期', async () => {
    const connected = await connect()
    expect(database!.getAiScheduleAgentStatus().connected).toBe(false)
    expect(() => database!.createAiScheduleJob('genshin', 'public_schedule')).toThrow('尚未连接')

    const registered = await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: { agentId: 'test-agent', name: '测试搜索 Agent', webSearch: true }
    })
    expect(registered.isError).not.toBe(true)
    expect(database!.getAiScheduleAgentStatus()).toMatchObject({
      connected: true,
      agentId: 'test-agent'
    })

    const queued = database!.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date(),
      false,
      'events'
    )
    expect(database!.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date(),
      false,
      'events'
    ).id).toBe(queued.id)
    const claimed = await connected.callTool({
      name: 'claim_gacha_schedule_job',
      arguments: { agentId: 'test-agent' }
    })
    expect(claimed.structuredContent).toMatchObject({
      command: 'claim_schedule_job',
      job: {
        id: queued.id,
        gameId: 'genshin',
        status: 'claimed',
        progressPhase: 'searching'
      }
    })

    const progress = await connected.callTool({
      name: 'update_gacha_schedule_job_progress',
      arguments: {
        agentId: 'test-agent',
        jobId: queued.id,
        phase: 'verifying',
        message: '正在交叉核验 2 个中文官方来源',
        current: 2,
        total: 3
      }
    })
    expect(progress.structuredContent).toMatchObject({
      command: 'update_schedule_job_progress',
      job: {
        id: queued.id,
        progressPhase: 'verifying',
        progressCurrent: 2,
        progressTotal: 3,
        message: '正在交叉核验 2 个中文官方来源'
      }
    })

    const rejectedCompletion = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'test-agent',
        jobId: queued.id,
        retrievedAt: '2026-07-20T15:30:00.000Z',
        items: [{
          remoteKey: 'official:event:test',
          category: 'limited_event',
          title: '不能夹带完成状态',
          titleSourceUrl: 'https://example.com/official-event-cn',
          sourceUrl: 'https://example.com/official-event',
          confidence: 0.98,
          completed: true
        }],
        evidence: [{
          url: 'https://example.com/official-event',
          platform: 'official-site',
          publisher: '官方账号',
          official: true,
          language: 'zh-CN'
        }]
      }
    })
    expect(rejectedCompletion.isError).toBe(true)
    expect(database!.listChecklistItems('genshin').some((item) => item.title === '不能夹带完成状态')).toBe(false)

    const rejectedPermanentEvent = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'test-agent',
        jobId: queued.id,
        retrievedAt: '2026-07-20T15:30:00.000Z',
        items: [{
          remoteKey: 'official:event:permanent',
          category: 'permanent_event',
          title: '常驻活动只能由用户维护',
          titleSourceUrl: 'https://example.com/official-event-cn',
          sourceUrl: 'https://example.com/official-event',
          confidence: 0.98
        }],
        evidence: [{
          url: 'https://example.com/official-event',
          platform: 'official-site',
          publisher: '官方账号',
          official: true,
          language: 'zh-CN'
        }]
      }
    })
    expect(rejectedPermanentEvent.isError).toBe(true)
    expect(database!.listChecklistItems('genshin').some((item) => item.title === '常驻活动只能由用户维护')).toBe(false)

    const rejectedEnglishTitle = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'test-agent',
        jobId: queued.id,
        retrievedAt: '2026-07-20T15:30:00.000Z',
        items: [{
          remoteKey: 'official:event:english',
          category: 'limited_event',
          title: 'English Event Name',
          titleSourceUrl: 'https://example.com/official-event-cn',
          sourceUrl: 'https://example.com/official-event',
          confidence: 0.98
        }],
        evidence: [{
          url: 'https://example.com/official-event-cn',
          platform: 'official-site',
          publisher: '官方账号',
          official: true,
          language: 'zh-CN'
        }]
      }
    })
    expect(rejectedEnglishTitle.isError).toBe(true)

    const applied = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'test-agent',
        jobId: queued.id,
        retrievedAt: '2026-07-20T15:30:00.000Z',
        items: [{
          remoteKey: 'official:event:test',
          category: 'limited_event',
          title: 'AI 交叉验证活动',
          titleSourceUrl: 'https://example.com/official-event-cn',
          startsAt: '2026-07-21T02:00:00.000Z',
          endsAt: '2026-08-01T19:59:00.000Z',
          scheduleKind: 'fixed_window',
          activityTags: ['战斗', '跑酷'],
          sourceUrl: 'https://example.com/official-event',
          confidence: 0.98
        }],
        evidence: [{
          url: 'https://example.com/official-event-cn',
          platform: 'official-site',
          publisher: '官方账号',
          official: true,
          language: 'zh-CN',
          publishedAt: '2026-07-20T12:00:00.000Z'
        }]
      }
    })
    expect(applied.isError).not.toBe(true)
    expect(applied.structuredContent).toMatchObject({
      command: 'apply_public_schedule',
      job: { status: 'completed' },
      merge: { added: 1, updated: 0 }
    })
    expect(database!.listChecklistItems('genshin')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'AI 交叉验证活动',
          source: 'public_schedule',
          sourceUrl: 'https://example.com/official-event',
          activityTags: ['战斗', '跑酷'],
          completed: false
        })
      ])
    )
    expect(database!.getSyncSettings('genshin')).toMatchObject({ status: 'success' })
  })

  it('公开资料回写拒绝不带时区的时间', async () => {
    const connected = await connect()
    await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: { agentId: 'timezone-agent', name: '时区测试 Agent', webSearch: true }
    })
    const queued = database!.createAiScheduleJob('genshin', 'public_schedule')
    await connected.callTool({
      name: 'claim_gacha_schedule_job',
      arguments: { agentId: 'timezone-agent' }
    })
    const result = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'timezone-agent',
        jobId: queued.id,
        retrievedAt: '2026-07-22T20:00:00',
        items: [{
          remoteKey: 'event:no-timezone',
          category: 'limited_event',
          title: '缺少时区的活动',
          titleSourceUrl: 'https://example.com/cn',
          endsAt: '2026-07-23T20:00:00',
          sourceUrl: 'https://example.com/cn',
          confidence: 0.9
        }],
        evidence: [{
          url: 'https://example.com/cn',
          platform: '官方平台',
          publisher: '官方账号',
          official: true,
          language: 'zh-CN'
        }]
      }
    })
    expect(result.isError).toBe(true)
    expect(database!.listChecklistItems('genshin').some((item) => item.remoteKey === 'event:no-timezone')).toBe(false)
  })

  it('公开资料 MCP 接受地图区域目录并以 0% 初始化', async () => {
    const connected = await connect()
    await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: { agentId: 'map-agent', name: '地图测试 Agent', webSearch: true }
    })
    const queued = database!.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date(),
      false,
      'exploration'
    )
    await connected.callTool({
      name: 'claim_gacha_schedule_job',
      arguments: { agentId: 'map-agent' }
    })
    const sourceUrl = 'https://example.com/genshin-map-cn'
    const result = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'map-agent',
        jobId: queued.id,
        retrievedAt: '2026-07-22T13:30:00.000Z',
        items: [{
          remoteKey: 'exploration:fontaine',
          category: 'exploration',
          title: '枫丹',
          titleSourceUrl: sourceUrl,
          parentTitle: '提瓦特大陆',
          modeKey: 'fontaine',
          sourceUrl,
          confidence: 0.98
        }],
        evidence: [{
          url: sourceUrl,
          platform: '官方平台',
          publisher: '原神官方',
          official: true,
          language: 'zh-CN'
        }]
      }
    })

    expect(result.isError).not.toBe(true)
    expect(database!.listChecklistItems('genshin').find((item) => item.title === '枫丹'))
      .toMatchObject({ category: 'exploration', progressPercent: 0, completed: false })
  })

  it('公开资料 MCP 通过“版更校时”统一校正固定任务时间且不改完成状态', async () => {
    const connected = await connect()
    await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: { agentId: 'version-agent', name: '版本校时 Agent', webSearch: true }
    })
    database!.updateChecklistItem({ id: 'genshin:main_quest', completed: true })
    const queued = database!.createAiScheduleJob(
      'genshin',
      'public_schedule',
      new Date(),
      false,
      'tasks'
    )
    await connected.callTool({
      name: 'claim_gacha_schedule_job',
      arguments: { agentId: 'version-agent' }
    })
    const now = Date.now()
    const startsAt = new Date(now - 24 * 60 * 60 * 1_000).toISOString()
    const endsAt = new Date(now + 40 * 24 * 60 * 60 * 1_000).toISOString()
    const sourceUrl = 'https://example.com/genshin-version-cn'
    const result = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'version-agent',
        jobId: queued.id,
        retrievedAt: new Date(now).toISOString(),
        items: [
          {
            remoteKey: 'version:genshin:main',
            category: 'main_quest',
            title: '主线任务',
            titleSourceUrl: sourceUrl,
            startsAt,
            endsAt,
            periodKey: 'genshin:version:test-current',
            scheduleKind: 'fixed_window',
            timeZone: 'Asia/Shanghai',
            modeKey: 'game-version',
            sourceUrl,
            confidence: 0.99
          },
          {
            remoteKey: 'version:genshin:side',
            category: 'side_quest',
            title: '支线任务',
            titleSourceUrl: sourceUrl,
            startsAt,
            endsAt,
            periodKey: 'genshin:version:test-current',
            scheduleKind: 'fixed_window',
            timeZone: 'Asia/Shanghai',
            modeKey: 'game-version',
            sourceUrl,
            confidence: 0.99
          }
        ],
        evidence: [{
          url: sourceUrl,
          platform: '官方平台',
          publisher: '原神官方',
          official: true,
          language: 'zh-CN'
        }]
      }
    })

    expect(result.isError).not.toBe(true)
    expect(database!.listChecklistItems('genshin').filter(
      (item) => item.category === 'main_quest' || item.category === 'side_quest'
    )).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'main_quest',
        completed: true,
        endsAt,
        periodKey: 'genshin:version:test-current'
      }),
      expect.objectContaining({
        category: 'side_quest',
        completed: false,
        endsAt,
        periodKey: 'genshin:version:test-current'
      })
    ]))
    expect(database!.getSyncTargetStates('genshin')).toContainEqual(
      expect.objectContaining({ target: 'tasks', lastSuccessAt: expect.any(String) })
    )
  })

  it('Codex 可领取脱敏语义候选，并通过专用工具安全写回', async () => {
    const connected = await connect()
    await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: { agentId: 'semantic-agent', name: '语义核验 Agent', webSearch: true }
    })
    database!.queueSemanticReviewCandidates('star-rail', 'personal_sync', [{
      target: 'events',
      kind: 'personal-item-semantics',
      payload: {
        officialEventId: '6011',
        title: '反贪「砖」家',
        observedStatus: { allFinished: true, actStatus: 'OtherActStatusFinish' }
      }
    }])

    const claimed = await connected.callTool({
      name: 'claim_gacha_semantic_review',
      arguments: { agentId: 'semantic-agent' }
    })
    expect(claimed.isError).not.toBe(true)
    expect(claimed.structuredContent).toMatchObject({
      command: 'claim_semantic_review',
      candidate: {
        gameId: 'star-rail',
        source: 'personal_sync',
        target: 'events',
        status: 'claimed',
        payload: { title: '反贪「砖」家' }
      }
    })
    const candidateId = (claimed.structuredContent as {
      candidate: { id: string }
    }).candidate.id

    const approved = await connected.callTool({
      name: 'approve_gacha_semantic_review',
      arguments: {
        agentId: 'semantic-agent',
        candidateId,
        confidence: 0.95,
        item: {
          remoteKey: 'event:miyoushe:6011',
          category: 'limited_event',
          title: '反贪「砖」家',
          activityTags: ['经营'],
          completed: false,
          startsAt: '2026-07-20T02:00:00.000Z',
          endsAt: '2026-08-10T01:59:00.000Z',
          sourceUrl: 'https://example.com/star-rail-event'
        },
        evidence: [{
          url: 'https://example.com/star-rail-schema',
          note: '字段仅代表活动生命周期，不代表玩家已完成'
        }]
      }
    })
    expect(approved.isError).not.toBe(true)
    expect(approved.structuredContent).toMatchObject({
      command: 'approve_semantic_review',
      candidate: { status: 'approved' },
      merge: { added: 1 }
    })
    expect(database!.listChecklistItems('star-rail')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '反贪「砖」家',
        completed: false,
        source: 'personal_sync'
      })
    ]))
  })
})
