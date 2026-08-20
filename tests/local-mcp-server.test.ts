import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { GTASK_MCP_PROTOCOL_VERSION } from '../src/shared/contracts'
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
  database = new AppDatabase(':memory:', { seedBundledBaselines: false })
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
      'queue_gacha_baseline_maintenance',
      'claim_gacha_schedule_job',
      'update_gacha_schedule_job_progress',
      'register_gacha_activity_tag',
      'apply_gacha_public_schedule',
      'fail_gacha_schedule_job'
    ])
    const updateTool = tools.tools.find((tool) => tool.name === 'update_gacha_item')
    expect(Object.keys(
      (updateTool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    )).toEqual(expect.arrayContaining([
      'activityTags',
      'mapNodeKind',
      'parentRemoteKey',
    ]))
    const publicScheduleTool = tools.tools.find(
      (tool) => tool.name === 'apply_gacha_public_schedule'
    )
    expect(Object.keys(
      (publicScheduleTool?.inputSchema as { properties?: Record<string, unknown> }).properties ?? {}
    )).toContain('verifiedUnchangedTargets')

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
      arguments: {
        agentId: 'test-agent',
        name: '测试搜索 Agent',
        webSearch: true,
        protocolVersion: GTASK_MCP_PROTOCOL_VERSION
      }
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
        progressPhase: 'searching',
        contract: {
          schemaVersion: 14,
          authority: 'interface_contract',
          target: 'events',
          requestContext: {
            outputLocale: 'zh-CN',
            userTimeZone: expect.any(String)
          },
          workflow: [
            'inventory',
            'research_required_fields',
            'verify',
            'match_existing',
            'submit'
          ],
          sections: [{
            target: 'events',
            itemShapes: expect.arrayContaining([
              expect.objectContaining({
                categories: ['limited_event'],
                requiredFields: expect.arrayContaining([
                  'title',
                  'startsAt',
                  'endsAt'
                ])
              })
            ])
          }]
        }
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
        contentLocale: 'zh-CN',
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

    const rejectedEnglishTitle = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'test-agent',
        jobId: queued.id,
        contentLocale: 'zh-CN',
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
        contentLocale: 'zh-CN',
        retrievedAt: '2026-07-20T15:30:00.000Z',
        items: [
          {
            remoteKey: 'official:event:test',
            category: 'limited_event',
            title: 'AI 交叉验证活动',
            titleSourceUrl: 'https://example.com/official-event-cn',
            startsAt: '2026-07-21T02:00:00.000Z',
            endsAt: '2026-08-01T19:59:00.000Z',
            scheduleKind: 'fixed_window',
            activityTags: ['combat', 'parkour', 'challenge'],
            sourceUrl: 'https://example.com/official-event',
            confidence: 0.98
          }
        ],
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
          activityTags: ['战斗', '跑酷', '挑战'],
          completed: false
        })
      ])
    )
    expect(database!.getSyncSettings('genshin')).toMatchObject({ status: 'success' })
  })

  it('旧缓存上报的协议号只作诊断，不阻塞本机 Codex 管理端', async () => {
    const connected = await connect()
    const result = await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: {
        agentId: 'old-plugin-agent',
        name: '旧插件 Agent',
        webSearch: true,
        protocolVersion: '2026-07-01.0'
      }
    })

    expect(result.isError).not.toBe(true)
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: expect.stringContaining('"reportedProtocolVersion": "2026-07-01.0"')
      })
    ]))
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        text: expect.stringContaining('"contractAuthority": "tool_schema_and_job_contract"')
      })
    ]))
    expect(database!.getAiScheduleAgentStatus().connected).toBe(true)
  })

  it('完整核查无差异时显式完成任务且不重写任何清单项', async () => {
    const connected = await connect()
    await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: {
        agentId: 'unchanged-mcp-agent',
        name: '无变化核查 Agent',
        webSearch: true,
        protocolVersion: GTASK_MCP_PROTOCOL_VERSION
      }
    })
    const queued = database!.createAiScheduleJob(
      'zenless', 'public_schedule', new Date('2026-08-20T10:00:00.000Z'), false, 'cycles'
    )
    const claimed = await connected.callTool({
      name: 'claim_gacha_schedule_job',
      arguments: { agentId: 'unchanged-mcp-agent', jobId: queued.id }
    })
    expect(claimed.structuredContent).toMatchObject({
      job: {
        id: queued.id,
        currentVersionWindow: null,
        matchCandidates: []
      }
    })

    const applied = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'unchanged-mcp-agent',
        jobId: queued.id,
        contentLocale: 'zh-CN',
        retrievedAt: '2026-08-20T10:01:00.000Z',
        items: [],
        verifiedUnchangedTargets: ['cycles'],
        evidence: [{
          url: 'https://example.com/zenless-cycles',
          platform: '官方平台',
          publisher: '官方账号',
          official: true,
          language: 'zh-CN',
          note: '完整核查后没有模式、规则或锚点变化'
        }]
      }
    })

    expect(applied.isError).not.toBe(true)
    expect(applied.structuredContent).toMatchObject({
      job: { status: 'completed', message: expect.stringContaining('未发现变化') },
      merge: { added: 0, updated: 0, preserved: 0 }
    })
    expect(database!.listChecklistItems('zenless')).toEqual([])
  })

  it('新活动玩法必须先注册稳定标签 ID，注册后可复用并按界面语言展示', async () => {
    const connected = await connect()
    await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: {
        agentId: 'custom-tag-agent',
        name: '新玩法标签 Agent',
        webSearch: true,
        protocolVersion: GTASK_MCP_PROTOCOL_VERSION
      }
    })
    const queued = database!.createAiScheduleJob(
      'zenless',
      'public_schedule',
      new Date('2026-08-02T08:00:00.000Z'),
      false,
      'events'
    )
    await connected.callTool({
      name: 'claim_gacha_schedule_job',
      arguments: { agentId: 'custom-tag-agent' }
    })

    const unregistered = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'custom-tag-agent',
        jobId: queued.id,
        contentLocale: 'zh-CN',
        retrievedAt: '2026-08-02T08:01:00.000Z',
        items: [{
          remoteKey: 'zenless:event:new-mechanic',
          category: 'limited_event',
          title: '新机制活动',
          titleSourceUrl: 'https://example.com/new-mechanic',
          activityTags: ['custom.gravity-painting', 'challenge', 'story'],
          startsAt: '2026-08-02T08:00:00.000Z',
          endsAt: '2026-08-20T08:00:00.000Z',
          sourceUrl: 'https://example.com/new-mechanic',
          confidence: 0.9
        }],
        evidence: [{
          url: 'https://example.com/new-mechanic',
          platform: '官方平台',
          publisher: '官方账号',
          official: true,
          language: 'zh-CN'
        }]
      }
    })
    expect(unregistered.isError).toBe(true)

    const registered = await connected.callTool({
      name: 'register_gacha_activity_tag',
      arguments: {
        agentId: 'custom-tag-agent',
        jobId: queued.id,
        id: 'custom.gravity-painting',
        dimension: 'gameplay',
        labels: { 'zh-CN': '重力绘画', 'en-US': 'Gravity painting' },
        description: '通过改变重力方向绘制并连接目标图案。',
        aliases: ['重力涂绘'],
        sourceUrl: 'https://example.com/new-mechanic',
        evidence: [{ url: 'https://example.com/new-mechanic', note: '官方玩法说明' }]
      }
    })
    expect(registered.isError).not.toBe(true)
    expect(registered.structuredContent).toMatchObject({
      tag: { id: 'custom.gravity-painting', dimension: 'gameplay' }
    })

    const applied = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'custom-tag-agent',
        jobId: queued.id,
        contentLocale: 'zh-CN',
        retrievedAt: '2026-08-02T08:02:00.000Z',
        items: [{
          remoteKey: 'zenless:event:new-mechanic',
          category: 'limited_event',
          title: '新机制活动',
          titleSourceUrl: 'https://example.com/new-mechanic',
          activityTags: ['custom.gravity-painting', 'challenge', 'story'],
          startsAt: '2026-08-02T08:00:00.000Z',
          endsAt: '2026-08-20T08:00:00.000Z',
          sourceUrl: 'https://example.com/new-mechanic',
          confidence: 0.9
        }],
        evidence: [{
          url: 'https://example.com/new-mechanic',
          platform: '官方平台',
          publisher: '官方账号',
          official: true,
          language: 'zh-CN'
        }]
      }
    })
    expect(applied.isError).not.toBe(true)
    expect(database!.listChecklistItems('zenless')).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: '新机制活动', activityTags: ['重力绘画', '挑战', '剧情'] })
    ]))
  })

  it('公开资料回写拒绝不带时区的时间', async () => {
    const connected = await connect()
    await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: {
        agentId: 'timezone-agent',
        name: '时区测试 Agent',
        webSearch: true,
        protocolVersion: GTASK_MCP_PROTOCOL_VERSION
      }
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
        contentLocale: 'zh-CN',
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

  it('活动任务通过 MCP 明示全部旧标签目标并支持安全的标签专用回写', async () => {
    const connected = await connect()
    database!.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'personal:event:mcp-enrichment',
      category: 'limited_event',
      title: '巡星之礼',
      startsAt: '2026-07-20T00:00:00.000Z',
      endsAt: '2026-08-20T00:00:00.000Z'
    }])
    await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: {
        agentId: 'tag-mcp-agent',
        name: '标签 MCP Agent',
        webSearch: true,
        protocolVersion: GTASK_MCP_PROTOCOL_VERSION
      }
    })
    const queued = database!.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      new Date('2026-07-26T00:00:00.000Z'),
      false,
      'events'
    )
    const claimed = await connected.callTool({
      name: 'claim_gacha_schedule_job',
      arguments: { agentId: 'tag-mcp-agent' }
    })
    const target = (
      claimed.structuredContent as {
        job: { activityTagTargets: Array<{ itemId: string; title: string }> }
      }
    ).job.activityTagTargets[0]
    expect(target).toMatchObject({ title: '巡星之礼' })

    const omitted = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'tag-mcp-agent',
        jobId: queued.id,
        contentLocale: 'zh-CN',
        retrievedAt: '2026-07-26T00:10:00.000Z',
        items: [{
          remoteKey: 'public:event:new',
          category: 'limited_event',
          title: '本轮新活动',
          titleSourceUrl: 'https://example.com/cn/new-event',
          activityTags: ['combat', 'challenge', 'story'],
          startsAt: '2026-07-26T10:00:00+08:00',
          endsAt: '2026-08-10T03:59:00+08:00',
          sourceUrl: 'https://example.com/cn/new-event',
          confidence: 0.98
        }],
        evidence: [{
          url: 'https://example.com/cn/new-event',
          platform: '官方平台',
          publisher: '官方账号',
          official: true,
          language: 'zh-CN'
        }]
      }
    })
    expect(omitted.isError).not.toBe(true)
    expect(database!.listChecklistItems('star-rail').some((item) => item.title === '本轮新活动'))
      .toBe(true)
    expect(database!.listChecklistItems('star-rail').find((item) => item.title === '巡星之礼'))
      .toMatchObject({ activityTags: [] })

    const tagJob = database!.createAiScheduleJob(
      'star-rail',
      'public_schedule',
      new Date('2026-07-26T00:11:00.000Z'),
      false,
      'events'
    )
    const tagClaimed = await connected.callTool({
      name: 'claim_gacha_schedule_job',
      arguments: { agentId: 'tag-mcp-agent' }
    })
    const tagTarget = (
      tagClaimed.structuredContent as {
        job: { activityTagTargets: Array<{ itemId: string; title: string }> }
      }
    ).job.activityTagTargets.find((candidate) => candidate.title === '巡星之礼')!

    const applied = await connected.callTool({
      name: 'apply_gacha_public_schedule',
      arguments: {
        agentId: 'tag-mcp-agent',
        jobId: tagJob.id,
        contentLocale: 'zh-CN',
        retrievedAt: '2026-07-26T00:12:00.000Z',
        items: [],
        activityTagUpdates: [{
          itemId: tagTarget.itemId,
          title: tagTarget.title,
          activityTags: ['sign-in', 'quest', 'festival'],
          sourceUrl: 'https://example.com/cn/check-in',
          confidence: 0.99
        }],
        evidence: [{
          url: 'https://example.com/cn/check-in',
          platform: '官方平台',
          publisher: '官方账号',
          official: true,
          language: 'zh-CN'
        }]
      }
    })
    expect(applied.isError).not.toBe(true)
    expect(database!.listChecklistItems('star-rail').find((item) => item.title === '巡星之礼'))
      .toMatchObject({ activityTags: ['签到', '任务', '节庆'], source: 'public_schedule' })
  })

  it('公开资料 MCP 接受地图区域目录并以 0% 初始化', async () => {
    const connected = await connect()
    await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: {
        agentId: 'map-agent',
        name: '地图测试 Agent',
        webSearch: true,
        protocolVersion: GTASK_MCP_PROTOCOL_VERSION
      }
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
        contentLocale: 'zh-CN',
        retrievedAt: '2026-07-22T13:30:00.000Z',
        items: [
          {
            remoteKey: 'exploration:fontaine',
            category: 'exploration',
            title: '枫丹',
            titleSourceUrl: sourceUrl,
            mapNodeKind: 'region',
            modeKey: 'fontaine',
            sourceUrl,
            confidence: 0.98
          },
          {
            remoteKey: 'exploration:fontaine:sea-of-bygone-eras',
            category: 'exploration',
            title: '旧日之海',
            titleSourceUrl: sourceUrl,
            mapNodeKind: 'subregion',
            parentRemoteKey: 'exploration:fontaine',
            parentTitle: '枫丹',
            modeKey: 'sea-of-bygone-eras',
            sourceUrl,
            confidence: 0.98
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
    expect(database!.listChecklistItems('genshin').find((item) => item.title === '枫丹'))
      .toMatchObject({
        category: 'exploration',
        mapNodeKind: 'region',
        progressPercent: 0,
        completed: false
      })
    expect(database!.listChecklistItems('genshin').find((item) => item.title === '旧日之海'))
      .toMatchObject({
        mapNodeKind: 'subregion',
        parentRemoteKey: 'exploration:fontaine',
        progressPercent: 0
      })
  })

  it('公开资料 MCP 通过“版更校时”更新独立版本窗口而不创建任务事项', async () => {
    const connected = await connect()
    await connected.callTool({
      name: 'register_gacha_schedule_agent',
      arguments: {
        agentId: 'version-agent',
        name: '版本校时 Agent',
        webSearch: true,
        protocolVersion: GTASK_MCP_PROTOCOL_VERSION
      }
    })
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
        contentLocale: 'zh-CN',
        retrievedAt: new Date(now).toISOString(),
        versionWindow: {
          periodKey: 'genshin:version:test-current',
          startsAt,
          endsAt,
          timeZone: 'Asia/Shanghai',
          sourceUrl,
          confidence: 0.78
        },
        items: [],
        evidence: [{
          url: sourceUrl,
          platform: '官方平台',
          publisher: '原神官方',
          official: true,
          language: 'zh-CN',
          note: '暂定：由当前版本官方开始时间与已公布后续排期交叉核验。'
        }]
      }
    })

    expect(result.isError).not.toBe(true)
    expect(database!.listChecklistItems('genshin')).toEqual([])
    expect(database!.listGameVersionSummaries(new Date(now))[0]).toEqual({
      gameId: 'genshin',
      endsAt
    })
    expect(database!.getSyncTargetStates('genshin')).toContainEqual(
      expect.objectContaining({ target: 'tasks', lastSuccessAt: expect.any(String) })
    )
  })

  it('可在无界面和无在线 Agent 时创建基准表维护任务', async () => {
    const connected = await connect()
    const queued = await connected.callTool({
      name: 'queue_gacha_baseline_maintenance',
      arguments: {
        gameId: 'genshin',
        target: 'events',
        outputLocale: 'zh-CN',
        userTimeZone: 'Asia/Shanghai'
      }
    })
    expect(queued.isError).not.toBe(true)
    expect(queued.structuredContent).toMatchObject({
      command: 'queue_baseline_maintenance',
      job: { gameId: 'genshin', target: 'events', status: 'pending' }
    })
  })

})
