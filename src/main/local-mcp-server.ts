import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod/v4'
import {
  CHECKLIST_CATEGORIES,
  SYNC_PROGRESS_PHASES,
  SUPPORTED_GAME_IDS,
  type ChecklistCategory,
  type GameId
} from '../shared/contracts'
import type { AppDatabase } from './database'
import { listBackups } from './backup'
import { LocalCommandService, type LocalCommandResult } from './local-command-service'
import type { NormalizedSyncItem } from './sync/types'

const gameIdSchema = z.enum(SUPPORTED_GAME_IDS)
const categorySchema = z.enum(CHECKLIST_CATEGORIES)
const sectionSchema = z.enum(['tasks', 'events', 'cycles', 'exploration', 'custom'])
const scheduleKindSchema = z.enum(['weekly', 'fixed_window', 'remote_schedule'])
const nullableTextSchema = z.string().max(200).nullable().optional()
const nullableDateSchema = z.string().nullable().optional()
const nullableProgressSchema = z.number().min(0).max(100).nullable().optional()
const recurrenceRuleSchema = z.string().max(200).refine(
  (value) => /^interval-days:\d{1,3}$/.test(value) ||
    /^monthly-days:[\d,]+@\d{2}:\d{2}\[Asia\/Shanghai\]$/.test(value),
  '自动周期规则格式不正确'
).nullable().optional()
const publicScheduleCategorySchema = z.enum(['limited_event', 'weekly', 'endgame', 'exploration'])
const syncProgressPhaseSchema = z.enum(SYNC_PROGRESS_PHASES)
const chineseScheduleTitleSchema = z.string().min(1).max(100).regex(
  /\p{Script=Han}/u,
  '公开资料名称必须包含经中文来源核对的中文正式名称'
)
const isoDateSchema = z.string().max(50)
  .regex(/T.*(?:Z|[+-]\d{2}:\d{2})$/i, '时间必须包含 Z 或明确的 UTC 偏移量')
  .refine((value) => !Number.isNaN(Date.parse(value)), '必须是有效时间')
const httpUrlSchema = z.string().max(500).url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'https:' || protocol === 'http:'
}, '只允许 HTTP/HTTPS 来源')

const checklistFields = {
  category: categorySchema,
  title: z.string().min(1).max(100),
  progressPercent: nullableProgressSchema,
  parentTitle: nullableTextSchema,
  startsAt: nullableDateSchema,
  endsAt: nullableDateSchema,
  resetRule: nullableTextSchema,
  scheduleKind: scheduleKindSchema.nullable().optional(),
  resetWeekday: z.number().int().min(1).max(7).nullable().optional(),
  timeZone: nullableTextSchema,
  modeKey: nullableTextSchema,
  recurrenceRule: recurrenceRuleSchema
}

function toolResult(result: LocalCommandResult | Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result as unknown as Record<string, unknown>
  }
}

function toolError(error: unknown) {
  const message = error instanceof Error ? error.message : '未知错误'
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true
  }
}

export interface LocalMcpServerOptions {
  backupDirectory?: string
}

export function createLocalMcpServer(
  database: AppDatabase,
  options: LocalMcpServerOptions = {}
): McpServer {
  const commands = new LocalCommandService(database)
  const server = new McpServer({ name: 'gacha-task-manager', version: '0.1.0' })

  server.registerTool(
    'describe_gacha_commands',
    {
      title: '查看幻游清单命令能力',
      description: '返回支持的游戏、分类、版块、命令和需要显式确认的删除操作。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => toolResult(commands.execute({ command: 'describe_commands' }))
  )

  server.registerTool(
    'read_gacha_checklists',
    {
      title: '读取幻游清单',
      description: '读取四款游戏或指定游戏的本地清单、同步状态和可选回收站内容。',
      inputSchema: {
        gameId: gameIdSchema.optional().describe('省略时读取全部四款游戏'),
        category: categorySchema.optional().describe('可选的事项分类筛选，仅在指定游戏时生效'),
        completed: z.boolean().optional().describe('可选的完成状态筛选，仅在指定游戏时生效'),
        includeArchived: z.boolean().optional().default(false).describe('是否包含回收站事项')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ gameId, category, completed, includeArchived }) => {
      try {
        return toolResult(
          gameId
            ? commands.execute({
                command: 'get_game_snapshot',
                gameId: gameId as GameId,
                category: category as ChecklistCategory | undefined,
                completed,
                includeArchived
              })
            : commands.execute({ command: 'get_all_snapshots', includeArchived })
        )
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'write_gacha_checklists',
    {
      title: '更新幻游清单',
      description:
        '执行新增、更新、恢复或软删除命令。先调用 describe_gacha_commands；删除必须在 request 中显式传入 confirm: true。',
      inputSchema: {
        request: z.record(z.string(), z.unknown()).describe('LocalCommandService 命令对象')
      },
      annotations: { destructiveHint: true, openWorldHint: false }
    },
    async ({ request }) => {
      try {
        return toolResult(commands.execute(request))
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'create_gacha_item',
    {
      title: '新增幻游清单事项',
      description: '向指定游戏新增活动、周期事项、地图探索或自定义事项。主线和支线是唯一状态项，不能重复新增。',
      inputSchema: { gameId: gameIdSchema, ...checklistFields },
      annotations: { destructiveHint: false, openWorldHint: false }
    },
    async (item) => {
      try {
        return toolResult(commands.execute({ command: 'create_item', item }))
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'update_gacha_item',
    {
      title: '更新幻游清单事项',
      description: '按事项 ID 修改名称、分类、完成状态、进度、时间或周期字段。只需传入需要改变的字段。',
      inputSchema: {
        id: z.string().min(1).max(100),
        category: categorySchema.optional(),
        title: z.string().min(1).max(100).optional(),
        completed: z.boolean().optional(),
        progressPercent: nullableProgressSchema,
        parentTitle: nullableTextSchema,
        startsAt: nullableDateSchema,
        endsAt: nullableDateSchema,
        resetRule: nullableTextSchema,
        scheduleKind: scheduleKindSchema.nullable().optional(),
        resetWeekday: z.number().int().min(1).max(7).nullable().optional(),
        timeZone: nullableTextSchema,
        modeKey: nullableTextSchema,
        recurrenceRule: recurrenceRuleSchema
      },
      annotations: { destructiveHint: false, openWorldHint: false }
    },
    async (item) => {
      try {
        return toolResult(commands.execute({ command: 'update_item', item }))
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'restore_gacha_item',
    {
      title: '恢复幻游清单事项',
      description: '按事项 ID 从回收站恢复一条事项。',
      inputSchema: { id: z.string().min(1).max(100) },
      annotations: { destructiveHint: false, openWorldHint: false }
    },
    async ({ id }) => {
      try {
        return toolResult(commands.execute({ command: 'restore_item', id }))
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'archive_gacha_item',
    {
      title: '删除幻游清单事项',
      description: '按事项 ID 软删除一条事项，可从回收站恢复。必须显式确认。',
      inputSchema: {
        id: z.string().min(1).max(100),
        confirm: z.boolean().describe('只有明确为 true 时才执行删除')
      },
      annotations: { destructiveHint: true, openWorldHint: false }
    },
    async ({ id, confirm }) => {
      try {
        return toolResult(commands.execute({ command: 'archive_item', id, confirm }))
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'archive_completed_gacha_section',
    {
      title: '删除版块已完成事项',
      description: '仅软删除指定游戏和指定版块中的已完成事项。必须显式确认。',
      inputSchema: {
        gameId: gameIdSchema,
        section: sectionSchema,
        confirm: z.boolean().describe('只有明确为 true 时才执行删除')
      },
      annotations: { destructiveHint: true, openWorldHint: false }
    },
    async ({ gameId, section, confirm }) => {
      try {
        return toolResult(
          commands.execute({ command: 'archive_completed_section', gameId, section, confirm })
        )
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'register_gacha_schedule_agent',
    {
      title: '登记公开资料 AI Agent',
      description: '登记或刷新具备联网搜索能力的 AI Agent 心跳；Agent 应至少每五分钟调用一次。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
        webSearch: z.literal(true).describe('必须确认具备联网搜索能力')
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId, name }) => {
      try {
        return toolResult({
          command: 'register_schedule_agent',
          agent: database.registerAiScheduleAgent(agentId, name)
        })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'claim_gacha_schedule_job',
    {
      title: '领取公开资料检索任务',
      description: '领取用户从“刷新清单”发起的最早一条待处理任务，同时刷新 Agent 心跳。无任务时返回 null。',
      inputSchema: { agentId: z.string().min(1).max(100) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId }) => {
      try {
        return toolResult({ command: 'claim_schedule_job', job: database.claimAiScheduleJob(agentId) })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'update_gacha_schedule_job_progress',
    {
      title: '更新公开资料同步进度',
      description: '把 Codex 当前的检索、核验、整理、重试或写入阶段实时显示在幻游清单中。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        jobId: z.string().uuid(),
        phase: syncProgressPhaseSchema,
        message: z.string().min(1).max(200),
        current: z.number().int().min(0).nullable().optional(),
        total: z.number().int().min(1).nullable().optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId, jobId, phase, message, current, total }) => {
      try {
        return toolResult({
          command: 'update_schedule_job_progress',
          job: database.updateAiScheduleJobProgress(
            jobId,
            agentId,
            phase,
            message,
            current ?? null,
            total ?? null
          )
        })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'claim_gacha_semantic_review',
    {
      title: '领取同步语义核验候选',
      description: '领取一条已脱敏的清单或个人进度候选。只包含判断所需字段，不包含 Cookie、Token、UID 或账号信息。',
      inputSchema: { agentId: z.string().min(1).max(100) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId }) => {
      try {
        return toolResult({
          command: 'claim_semantic_review',
          candidate: database.claimSemanticReviewCandidate(agentId)
        })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'approve_gacha_semantic_review',
    {
      title: '通过同步语义核验',
      description: '提交 Codex 对名称、分类、时间或个人状态含义的核验结果。置信度低于 0.9、跨版块或违反数据库安全规则时拒绝写入。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        candidateId: z.string().uuid(),
        confidence: z.number().min(0.9).max(1),
        item: z.object({
          remoteKey: z.string().min(1).max(200),
          category: categorySchema,
          title: chineseScheduleTitleSchema,
          completed: z.boolean().optional(),
          parentTitle: nullableTextSchema,
          startsAt: isoDateSchema.nullable().optional(),
          endsAt: isoDateSchema.nullable().optional(),
          resetRule: nullableTextSchema,
          periodKey: nullableTextSchema,
          scheduleKind: scheduleKindSchema.nullable().optional(),
          resetWeekday: z.number().int().min(1).max(7).nullable().optional(),
          timeZone: nullableTextSchema,
          modeKey: nullableTextSchema,
          recurrenceRule: recurrenceRuleSchema,
          sourceUrl: httpUrlSchema.nullable().optional()
        }).strict(),
        evidence: z.array(z.object({
          url: httpUrlSchema,
          note: z.string().min(1).max(500)
        }).strict()).min(1).max(20)
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId, candidateId, confidence, item, evidence }) => {
      try {
        return toolResult({
          command: 'approve_semantic_review',
          ...database.approveSemanticReviewCandidate(
            candidateId,
            agentId,
            item as NormalizedSyncItem,
            confidence,
            evidence
          )
        })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'reject_gacha_semantic_review',
    {
      title: '拒绝同步语义核验候选',
      description: '当字段含义无法证实、资料冲突或不应写入清单时结束候选，保留现有清单不变。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        candidateId: z.string().uuid(),
        message: z.string().min(1).max(500),
        evidence: z.array(z.object({
          url: httpUrlSchema,
          note: z.string().min(1).max(500)
        }).strict()).max(20).default([])
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId, candidateId, message, evidence }) => {
      try {
        return toolResult({
          command: 'reject_semantic_review',
          candidate: database.rejectSemanticReviewCandidate(
            candidateId,
            agentId,
            message,
            evidence
          )
        })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'apply_gacha_public_schedule',
    {
      title: '提交已验证的公开资料',
      description: '把联网检索并交叉验证后的活动、周期排期或地图区域目录提交给已领取任务。每个名称必须来自中文来源并包含中文，不能提交个人探索度、完成状态或删除操作。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        jobId: z.string().uuid(),
        retrievedAt: isoDateSchema,
        items: z.array(z.object({
          remoteKey: z.string().min(1).max(200),
          category: publicScheduleCategorySchema,
          title: chineseScheduleTitleSchema,
          titleSourceUrl: httpUrlSchema,
          parentTitle: z.string().max(200).nullable().optional(),
          startsAt: isoDateSchema.nullable().optional(),
          endsAt: isoDateSchema.nullable().optional(),
          resetRule: z.string().max(200).nullable().optional(),
          periodKey: z.string().max(200).nullable().optional(),
          scheduleKind: scheduleKindSchema.nullable().optional(),
          resetWeekday: z.number().int().min(1).max(7).nullable().optional(),
          timeZone: z.string().max(200).nullable().optional(),
          modeKey: z.string().max(200).nullable().optional(),
          recurrenceRule: recurrenceRuleSchema,
          sourceUrl: httpUrlSchema,
          confidence: z.number().min(0).max(1)
        }).strict()).min(1).max(200),
        evidence: z.array(z.object({
          url: httpUrlSchema,
          platform: z.string().min(1).max(100),
          publisher: z.string().min(1).max(100),
          official: z.boolean(),
          language: z.enum(['zh-CN', 'other']),
          publishedAt: isoDateSchema.nullable().optional(),
          note: z.string().max(500).optional()
        }).strict()).min(1).max(20)
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId, jobId, retrievedAt, items, evidence }) => {
      try {
        const chineseEvidenceUrls = new Set(
          evidence.filter((entry) => entry.language === 'zh-CN').map((entry) => entry.url)
        )
        for (const item of items) {
          if (!chineseEvidenceUrls.has(item.titleSourceUrl)) {
            throw new Error(`“${item.title}”缺少对应的中文名称来源证据`)
          }
        }
        const normalizedItems: NormalizedSyncItem[] = items.map(({
          confidence: _confidence,
          titleSourceUrl: _titleSourceUrl,
          ...item
        }) => item)
        const normalizedEvidence = evidence.map(({ language, ...entry }) => ({
          ...entry,
          note: [entry.note, `页面语言：${language}`].filter(Boolean).join('；')
        }))
        const result = database.applyAiScheduleJob(
          jobId,
          agentId,
          normalizedItems,
          { retrievedAt, evidence: normalizedEvidence }
        )
        return toolResult({ command: 'apply_public_schedule', ...result })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'fail_gacha_schedule_job',
    {
      title: '报告公开资料检索失败',
      description: '在搜索、交叉验证或结构化失败时结束已领取任务，不修改现有清单。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        jobId: z.string().uuid(),
        message: z.string().min(1).max(500)
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId, jobId, message }) => {
      try {
        return toolResult({
          command: 'fail_schedule_job',
          job: database.failAiScheduleJob(jobId, agentId, message)
        })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  if (options.backupDirectory) {
    server.registerResource(
      'gacha-backups',
      'gacha://backups',
      {
        title: '幻游清单本地备份',
        description: '最近的每日、手动和数据库升级前备份元数据；不包含登录凭据。',
        mimeType: 'application/json'
      },
      async () => ({
        contents: [
          {
            uri: 'gacha://backups',
            mimeType: 'application/json',
            text: JSON.stringify({ backups: listBackups(options.backupDirectory!) }, null, 2)
          }
        ]
      })
    )
  }

  return server
}
