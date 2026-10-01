import { afterEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AiScheduleJob, AiScheduleResearchDecision } from '../src/shared/contracts'
import { AppDatabase } from '../src/main/database'
import { createLocalMcpServer } from '../src/main/local-mcp-server'
import { selectCodexWorkerRoutes } from '../src/main/ai/codex-schedule-worker'

let database: AppDatabase
let server: McpServer
let client: Client

afterEach(async () => {
  await client?.close()
  await server?.close()
  database?.close()
  vi.useRealTimers()
})

async function connect() {
  database = new AppDatabase(':memory:', { seedBundledBaselines: false })
  server = createLocalMcpServer(database)
  client = new Client({ name: 'maintenance-workflow', version: '1.0.0' })
  const [left, right] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(right), client.connect(left)])
  for (const agentId of ['direct', 'background']) {
    await client.callTool({ name: 'register_gtask_schedule_agent', arguments: {
      agentId, name: agentId, webSearch: true
    } })
  }
}

async function start() {
  const result = await client.callTool({ name: 'queue_gtask_baseline_maintenance', arguments: {
    gameId: 'star-rail', target: 'events', agentId: 'direct'
  } })
  expect(result.isError).not.toBe(true)
  return (result.structuredContent as { job: AiScheduleJob }).job
}

const decision: AiScheduleResearchDecision = {
  key: 'event:4.6:love-ghosts-robots:startsAt',
  target: 'events', status: 'resolved',
  previousValue: '2026-09-25T04:00:00+08:00',
  adoptedValue: '2026-09-28T11:00:00+08:00',
  timeBasis: 'nominal_maintenance',
  reason: '后续适用官方更新说明覆盖旧日历；11:00 是预计维护完成排期，非实测',
  sources: [
    { url: 'https://hsr.hoyoverse.com/zh-cn/news/166468', publishedAt: '2026-09-28',
      statement: '9月28日版本更新后开放；06:00开始维护，预计五小时' }
  ]
}

async function checkpoint(jobId: string, researchDecisions: AiScheduleResearchDecision[], agentId = 'direct') {
  return client.callTool({ name: 'update_gtask_schedule_job_progress', arguments: {
    jobId, agentId, phase: 'verifying', message: '记录公开裁决', researchDecisions
  } })
}

describe('维护流程：单一执行方、裁决续接和有界状态', () => {
  it('既有证据已经足够时，明确纠错理由允许修复旧解读，不能把流程变成新的死锁', async () => {
    await connect()
    const job = await start()
    const mistaken = { ...decision, adoptedValue: decision.previousValue,
      reason: '旧判断误把日历视为现行规则' }
    expect((await checkpoint(job.id, [mistaken])).isError).not.toBe(true)
    expect((await checkpoint(job.id, [decision])).isError).toBe(true)
    const corrected = { ...decision,
      correctionReason: '用户指出同一活动的后续官方公告覆盖旧日历；纠正旧解读，已有原文足够，无需重复搜索' }
    expect((await checkpoint(job.id, [corrected])).isError).not.toBe(true)
    expect(database.getAiScheduleJobSummary(job.id, true)?.researchDecisions).toEqual([corrected])
  })

  it('新版排期原位纠正旧日期，保留完成和手动锁，并明确保存预计时间依据', async () => {
    await connect()
    database.mergeSyncedItems('star-rail', 'public_schedule', [{
      remoteKey: 'event:4.6:love-ghosts-robots', category: 'limited_event', title: '爱，幽灵与机器人',
      startsAt: decision.previousValue, endsAt: '2026-11-11T03:59:59+08:00',
      activityTags: ['management', 'story']
    }])
    const before = database.listChecklistItems('star-rail')[0]
    database.updateChecklistItem({ id: before.id, completed: true })
    const job = await start()
    expect(job.contract.maintenancePolicy?.rules.join(' ')).toContain('预计维护完成')
    expect((await checkpoint(job.id, [decision])).isError).not.toBe(true)
    const result = await client.callTool({ name: 'apply_gtask_public_schedule', arguments: {
      agentId: 'direct', jobId: job.id, contentLocale: 'zh-CN', retrievedAt: new Date().toISOString(),
      items: [{
        matchItemId: before.id, remoteKey: before.remoteKey, category: 'limited_event', title: before.title,
        startsAt: decision.adoptedValue, endsAt: '2026-11-11T03:59:59+08:00',
        activityTags: ['management', 'story'], confidence: 0.95,
        sourceUrl: decision.sources[0].url, titleSourceUrl: decision.sources[0].url
      }],
      evidence: [{ kind: 'web', url: decision.sources[0].url, platform: 'official-site',
        publisher: 'HoYoverse', official: true, language: 'zh-CN', note: decision.reason }]
    } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(database.listChecklistItems('star-rail')).toEqual([expect.objectContaining({
      id: before.id, remoteKey: before.remoteKey, completed: true, manualCompletionLocked: true,
      startsAt: '2026-09-28T11:00:00+08:00'
    })])
    expect(database.getAiScheduleJobSummary(job.id, true)).toMatchObject({
      auditComplete: true, researchDecisions: [decision]
    })
  })

  it('创建时即归属，后台不可调度或抢领；重复直接请求复用同一任务', async () => {
    await connect()
    const job = await start()
    expect(job).toMatchObject({ status: 'claimed', agentId: 'direct', attemptCount: 1 })
    expect(selectCodexWorkerRoutes({ jobs: [job], runningRoutes: [], preferences: {
      strategy: 'fixed', model: 'gpt-5.6-sol', reasoningEffort: 'medium'
    } })).toEqual([])
    const [contender, resumed] = await Promise.all([
      client.callTool({ name: 'claim_gtask_schedule_job', arguments: { jobId: job.id, agentId: 'background' } }),
      client.callTool({ name: 'queue_gtask_baseline_maintenance', arguments: {
        gameId: 'star-rail', target: 'events', agentId: 'direct'
      } })
    ])
    expect(contender.structuredContent).toMatchObject({ claimOutcome: 'claimed_by_another_agent', job: null })
    expect(resumed.structuredContent).toMatchObject({ claimOutcome: 'resumed', job: { id: job.id, attemptCount: 1 } })
    const wrongOwner = await checkpoint(job.id, [decision], 'background')
    expect(wrongOwner.isError).toBe(true)
    expect(wrongOwner.structuredContent).toMatchObject({ error: { message: expect.stringContaining('未由当前 Agent') } })
    expect(database.getAiScheduleJobById(job.id).researchDecisions).toEqual([])
  })

  it('未知 Agent 的原子创建全部回滚，不遗留可被后台抢走的任务', async () => {
    await connect()
    const result = await client.callTool({ name: 'queue_gtask_baseline_maintenance', arguments: {
      gameId: 'genshin', target: 'events', agentId: 'unregistered'
    } })
    expect(result.isError).toBe(true)
    expect(database.getActiveAiScheduleJob('genshin')).toBeNull()
  })

  it('只读查询不领取或续租，不枚举清单；状态摘要比完整领取显著更小', async () => {
    await connect()
    const job = await start()
    const spy = vi.spyOn(database, 'listChecklistItems')
    const before = database.getAiScheduleJobSummary(job.id)
    vi.useFakeTimers()
    vi.setSystemTime(new Date(Date.now() + 60_000))
    const result = await client.callTool({ name: 'get_gtask_schedule_job', arguments: { jobId: job.id } })
    expect(result.structuredContent).toMatchObject({ job: before })
    expect(spy).not.toHaveBeenCalled()
    expect(JSON.stringify(result.structuredContent).length).toBeLessThan(JSON.stringify(job).length / 4)
    const missing = await client.callTool({ name: 'get_gtask_schedule_job', arguments: {
      jobId: '00000000-0000-4000-8000-000000000000'
    } })
    expect(missing.structuredContent).toMatchObject({ currentStatus: 'not_found', job: null })
    spy.mockRestore()
  })

  it('裁决及 nominal 依据可续接；同一来源不能反复推翻，新增官方证据才允许更正', async () => {
    await connect()
    const job = await start()
    const saved = await checkpoint(job.id, [decision])
    expect(saved.isError).not.toBe(true)
    expect(saved.structuredContent).toMatchObject({ job: { id: job.id } })
    expect((saved.structuredContent as { job: object }).job).not.toHaveProperty('matchCandidates')
    const resumed = await client.callTool({ name: 'claim_gtask_schedule_job', arguments: { jobId: job.id, agentId: 'direct' } })
    expect(resumed.structuredContent).toMatchObject({ job: { researchDecisions: [decision] } })
    const rejected = await checkpoint(job.id, [{ ...decision, status: 'pending', adoptedValue: null }])
    expect(rejected.isError).toBe(true)
    expect(database.getAiScheduleJobById(job.id).researchDecisions).toEqual([decision])
    const corrected = { ...decision, adoptedValue: '2026-09-28T10:30:00+08:00', timeBasis: 'exact' as const,
      sources: [...decision.sources, { url: 'https://hsr.hoyoverse.com/zh-cn/news/correction',
        publishedAt: '2026-09-29', statement: '官方后续确认实际开放时间10:30' }] }
    expect((await checkpoint(job.id, [corrected])).isError).not.toBe(true)
    const result = await client.callTool({ name: 'apply_gtask_public_schedule', arguments: {
      agentId: 'direct', jobId: job.id, contentLocale: 'zh-CN', retrievedAt: new Date().toISOString(),
      items: [], verifiedUnchangedTargets: ['events'],
      evidence: corrected.sources.map((source) => ({ kind: 'web', url: source.url, note: source.statement,
        platform: 'official-site', publisher: 'HoYoverse', official: true, language: 'zh-CN' }))
    } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    const finished = await client.callTool({ name: 'get_gtask_schedule_job', arguments: {
      jobId: job.id, includeResearch: true
    } })
    expect(finished.structuredContent).toMatchObject({
      job: { status: 'completed', auditComplete: true, researchDecisions: [corrected] }
    })
  })

  it('待核实项不阻断确认项的保存，也不能把不完整核查报告为无变化或全部完成', async () => {
    await connect()
    const job = await start()
    const pending = { ...decision, key: 'unresolved', status: 'pending' as const,
      adoptedValue: null, reason: '主要规则及独立补查均缺少服务器时间依据' }
    expect((await checkpoint(job.id, [pending])).isError).not.toBe(true)
    const request = { agentId: 'direct', jobId: job.id, contentLocale: 'zh-CN',
      retrievedAt: new Date().toISOString(),
      evidence: pending.sources.map((source) => ({ kind: 'web', url: source.url, note: source.statement,
        platform: 'official-site', publisher: 'HoYoverse', official: true, language: 'zh-CN' })) }
    const invalid = await client.callTool({ name: 'apply_gtask_public_schedule', arguments: {
      ...request, items: [], verifiedUnchangedTargets: ['events']
    } })
    expect(invalid.isError).toBe(true)
    const result = await client.callTool({ name: 'apply_gtask_public_schedule', arguments: {
      ...request, items: [{
        remoteKey: 'confirmed-web-event', category: 'limited_event', title: '已核验网页活动',
        startsAt: '2026-09-28T10:00:00+08:00', endsAt: '2026-11-11T06:00:00+08:00',
        activityTags: ['web-event'], confidence: 1,
        sourceUrl: decision.sources[0].url, titleSourceUrl: decision.sources[0].url
      }]
    } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ merge: { added: 1 } })
    expect(database.getAiScheduleJobSummary(job.id, true)).toMatchObject({
      status: 'completed', auditComplete: false, unresolvedDecisionCount: 1,
      researchDecisions: [pending]
    })
    expect(database.listChecklistItems('star-rail')).toHaveLength(1)
  })
})
