import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod/v4'
import {
  CHECKLIST_CATEGORIES,
  CODEX_REASONING_EFFORTS,
  CODEX_WORKER_MODELS,
  GTASK_MCP_PROTOCOL_VERSION,
  MAP_NODE_KINDS,
  SYNC_PROGRESS_PHASES,
  SUPPORTED_GAME_IDS,
  type ChecklistCategory,
  type ChecklistItem,
  type GameId
} from '../shared/contracts'
import type { AppDatabase } from './database'
import {
  ACTIVITY_TAG_DIMENSIONS,
  ACTIVITY_TAG_TAXONOMY_VERSION,
  MAX_AI_ACTIVITY_TAGS,
  MIN_AI_ACTIVITY_TAGS,
  isValidActivityTagId
} from './activity-tags'
import { listBackups } from './backup'
import { LocalCommandService, type LocalCommandResult } from './local-command-service'
import type {
  ActivityTagUpdate,
  CodexArchiveDecision,
  CodexScheduleItem,
  PersonalMetadataUpdate,
  PersonalReviewResolution
} from './sync/types'

const gameIdSchema = z.enum(SUPPORTED_GAME_IDS)
const categorySchema = z.enum(CHECKLIST_CATEGORIES)
const sectionSchema = z.enum(['tasks', 'events', 'cycles', 'exploration', 'custom'])
const scheduleKindSchema = z.enum(['weekly', 'fixed_window', 'remote_schedule'])
const mapNodeKindSchema = z.enum(MAP_NODE_KINDS)
const nullableTextSchema = z.string().max(200).nullable().optional()
const nullableDateSchema = z.string().nullable().optional()
const nullableProgressSchema = z.number().min(0).max(100).nullable().optional()
const personalRuleValueSchema = z.union([
  z.string().max(200),
  z.number().finite(),
  z.boolean()
])
const recurrenceRuleSchema = z.string().max(200).refine(
  (value) => /^interval-days:\d{1,3}$/.test(value) ||
    /^monthly-days:[\d,]+@\d{2}:\d{2}\[Asia\/Shanghai\]$/.test(value),
  '自动周期规则格式不正确'
).nullable().optional()
const publicScheduleCategorySchema = z.enum([
  'main_quest',
  'side_quest',
  'limited_event',
  'weekly',
  'endgame',
  'exploration'
])
const syncProgressPhaseSchema = z.enum(SYNC_PROGRESS_PHASES)
const isoDateSchema = z.string().max(50)
  .regex(/T.*(?:Z|[+-]\d{2}:\d{2})$/i, '时间必须包含 Z 或明确的 UTC 偏移量')
  .refine((value) => !Number.isNaN(Date.parse(value)), '必须是有效时间')
const httpUrlSchema = z.string().max(500).url().refine((value) => {
  const protocol = new URL(value).protocol
  return protocol === 'https:' || protocol === 'http:'
}, '只允许 HTTP/HTTPS 来源')
const activityTagIdSchema = z.string().min(1).max(80).refine(
  (value) => isValidActivityTagId(value),
  '活动标签必须引用 contract.activityTagCatalog 中已注册的稳定 ID'
)

const checklistFields = {
  category: categorySchema,
  title: z.string().min(1).max(100),
  activityTags: z.array(z.string().min(1).max(80)).max(5).optional(),
  progressPercent: nullableProgressSchema,
  parentTitle: nullableTextSchema,
  mapNodeKind: mapNodeKindSchema.nullable().optional(),
  parentRemoteKey: nullableTextSchema,
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
      title: '查看 Gtask 命令能力',
      description: '返回支持的游戏、分类、版块、命令和需要显式确认的删除操作。',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => toolResult(commands.execute({ command: 'describe_commands' }))
  )

  server.registerTool(
    'read_gacha_checklists',
    {
      title: '读取 Gtask',
      description: '读取全部已启用游戏或指定游戏的本地清单、同步状态和可选回收站内容。',
      inputSchema: {
        gameId: gameIdSchema.optional().describe('省略时读取全部已启用游戏'),
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
      title: '更新 Gtask',
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
      title: '新增 Gtask 事项',
      description: '向指定游戏新增活动、周期事项、地图探索或自定义事项。字段语义与清单记录一致；主线和支线是唯一状态项，不能重复新增。',
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
      title: '更新 Gtask 事项',
      description: '按事项 ID 修改名称、分类、完成状态、进度、时间或周期字段。只需传入需要改变的字段。',
      inputSchema: {
        id: z.string().min(1).max(100),
        category: categorySchema.optional(),
        title: z.string().min(1).max(100).optional(),
        activityTags: z.array(z.string().min(1).max(80)).max(5).optional(),
        completed: z.boolean().optional(),
        progressPercent: nullableProgressSchema,
        parentTitle: nullableTextSchema,
        mapNodeKind: mapNodeKindSchema.nullable().optional(),
        parentRemoteKey: nullableTextSchema,
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
      title: '恢复 Gtask 事项',
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
      title: '删除 Gtask 事项',
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
        webSearch: z.literal(true).describe('必须确认具备联网搜索能力'),
        protocolVersion: z.string().min(1).max(50)
          .describe(`必须等于当前 Gtask MCP 协议 ${GTASK_MCP_PROTOCOL_VERSION}`)
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId, name, protocolVersion }) => {
      try {
        if (protocolVersion !== GTASK_MCP_PROTOCOL_VERSION) {
          throw new Error(
            `Gtask 插件协议不兼容：应用需要 ${GTASK_MCP_PROTOCOL_VERSION}，` +
            `当前为 ${protocolVersion}。请先在设置中更新插件`
          )
        }
        return toolResult({
          command: 'register_schedule_agent',
          protocolVersion: GTASK_MCP_PROTOCOL_VERSION,
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
      description: '领取用户从“同步公开数据”发起的最早任务。返回的 job.contract 是当前版块所需数据、字段语义和完成条件的权威机器可读契约；Codex 应先读取契约再联网检索。无任务时返回 null。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        jobId: z.string().uuid().optional(),
        model: z.enum(CODEX_WORKER_MODELS).optional(),
        reasoningEffort: z.enum(CODEX_REASONING_EFFORTS).optional()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId, jobId, model, reasoningEffort }) => {
      try {
        return toolResult({
          command: 'claim_schedule_job',
          job: database.claimAiScheduleJob(
            agentId,
            new Date(),
            jobId,
            model && reasoningEffort ? { model, reasoningEffort } : undefined
          )
        })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'update_gacha_schedule_job_progress',
    {
      title: '更新公开资料同步进度',
      description: '记录 Codex 当前的结构化阶段、数量与内部诊断。Gtask 只按 phase/current/total 生成固定用户文案，不直接展示 message。',
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
    'register_gacha_activity_tag',
    {
      title: '注册新的活动标签',
      description: '仅在现有 activityTagCatalog 无法准确描述一种新玩法时使用。注册可复用的 custom.* 稳定标签 ID 后，再在当前任务提交中引用该 ID。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        jobId: z.string().uuid(),
        id: z.string().regex(/^custom\.[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
        dimension: z.enum(ACTIVITY_TAG_DIMENSIONS),
        labels: z.record(z.string().min(2).max(35), z.string().min(1).max(40)),
        description: z.string().min(4).max(300),
        aliases: z.array(z.string().min(1).max(40)).max(20).default([]),
        sourceUrl: httpUrlSchema,
        evidence: z.array(z.object({
          url: httpUrlSchema,
          note: z.string().min(1).max(500)
        }).strict()).min(1).max(20)
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId, jobId, id, dimension, labels, description, aliases, sourceUrl, evidence }) => {
      try {
        return toolResult({
          command: 'register_activity_tag',
          taxonomyVersion: ACTIVITY_TAG_TAXONOMY_VERSION,
          tag: database.registerActivityTagForJob({
            jobId,
            agentId,
            id,
            dimension,
            labels,
            description,
            aliases,
            sourceUrl,
            evidence
          })
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
      description: '按已领取 job.contract 提交 Codex 核验后的当前版本时间、活动、周期排期或地图目录；输入 schema 是各版块字段的并集，条件必填与禁止字段以 contract 为准。也可把确认错误、重复或失效的同步项移入回收站。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        jobId: z.string().uuid(),
        contentLocale: z.string().min(2).max(35)
          .describe('必须等于 job.contract.requestContext.outputLocale'),
        retrievedAt: isoDateSchema.describe('本次资料检索完成的绝对时间'),
        items: z.array(z.object({
          matchItemId: z.string().min(1).max(100).optional()
            .describe('与领取任务的 matchCandidates 语义相同时填写其 itemId'),
          remoteKey: z.string().min(1).max(200)
            .describe('稳定机器身份；同一逻辑事项重复同步时保持稳定'),
          category: publicScheduleCategorySchema,
          title: z.string().min(1).max(100),
          titleSourceUrl: httpUrlSchema,
          activityTags: z.array(activityTagIdSchema)
            .min(MIN_AI_ACTIVITY_TAGS).max(MAX_AI_ACTIVITY_TAGS).optional()
            .describe('可选；只有资料明确支持时才提交稳定 ID，没有可靠依据时留空'),
          parentTitle: z.string().max(200).nullable().optional(),
          mapNodeKind: mapNodeKindSchema.nullable().optional(),
          parentRemoteKey: z.string().max(200).nullable().optional(),
          startsAt: isoDateSchema.nullable().optional()
            .describe('绝对开始时间；限时活动必须提供'),
          endsAt: isoDateSchema.nullable().optional()
            .describe('绝对结束时间；限时活动必须提供'),
          resetRule: z.string().max(200).nullable().optional(),
          periodKey: z.string().max(200).nullable().optional(),
          scheduleKind: scheduleKindSchema.nullable().optional(),
          resetWeekday: z.number().int().min(1).max(7).nullable().optional(),
          timeZone: z.string().max(200).nullable().optional(),
          modeKey: z.string().max(200).nullable().optional(),
          recurrenceRule: recurrenceRuleSchema,
          sourceUrl: httpUrlSchema,
          confidence: z.number().min(0).max(1)
        }).strict()).max(200).describe('结构化事项；字段要求以领取任务的 contract 为准'),
        activityTagUpdates: z.array(z.object({
          itemId: z.string().min(1).max(100),
          title: z.string().min(1).max(100),
          activityTags: z.array(activityTagIdSchema)
            .min(MIN_AI_ACTIVITY_TAGS).max(MAX_AI_ACTIVITY_TAGS)
            .describe('只提交资料明确支持的稳定 ID；无需覆盖全部待补目标'),
          sourceUrl: httpUrlSchema,
          confidence: z.number().min(0).max(1),
          unresolvedReason: z.string().max(500).nullable().optional()
        }).strict()).max(100).optional(),
        archiveItems: z.array(z.object({
          itemId: z.string().min(1).max(100),
          reason: z.string().min(1).max(500)
        }).strict()).max(100).optional(),
        verifiedEmptyTargets: z.array(z.literal('events')).max(1).optional(),
        evidence: z.array(z.object({
          url: httpUrlSchema,
          platform: z.string().min(1).max(100),
          publisher: z.string().min(1).max(100),
          official: z.boolean(),
          language: z.string().min(2).max(35),
          publishedAt: isoDateSchema.nullable().optional(),
          note: z.string().max(500).optional()
        }).strict()).min(1).max(100)
          .describe('覆盖本次提交核心事实的至少一条直接证据')
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async ({
      agentId,
      jobId,
      contentLocale,
      retrievedAt,
      items,
      activityTagUpdates,
      archiveItems,
      verifiedEmptyTargets,
      evidence
    }) => {
      try {
        const claimedJob = database.getAiScheduleJobById(jobId)
        if (
          items.length === 0 &&
          (activityTagUpdates?.length ?? 0) === 0 &&
          (archiveItems?.length ?? 0) === 0 &&
          (verifiedEmptyTargets?.length ?? 0) === 0 &&
          claimedJob.activityTagTargets.length === 0
        ) {
          throw new Error('公开数据提交没有包含可处理的清单结果')
        }
        const normalizedItems: CodexScheduleItem[] = items.map(({
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
          { retrievedAt, evidence: normalizedEvidence },
          new Date(),
          (activityTagUpdates ?? []) as ActivityTagUpdate[],
          verifiedEmptyTargets ?? [],
          (archiveItems ?? []) as CodexArchiveDecision[]
          ,
          contentLocale
        )
        return toolResult({ command: 'apply_public_schedule', ...result })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'apply_gacha_personal_metadata',
    {
      title: '补全个人清单标签与时间',
      description: '仅按 personal_metadata job.contract 补全既有个人活动的玩法标签及活动/周期事项的缺失起止时间；不能改变完成状态、分类、来源或清单成员。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        jobId: z.string().uuid(),
        contentLocale: z.string().min(2).max(35),
        retrievedAt: isoDateSchema,
        updates: z.array(z.object({
          itemId: z.string().min(1).max(100),
          title: z.string().min(1).max(100),
          activityTags: z.array(activityTagIdSchema)
            .min(MIN_AI_ACTIVITY_TAGS).max(MAX_AI_ACTIVITY_TAGS).optional(),
          activityTagEvidence: z.array(z.object({
            tagId: activityTagIdSchema,
            sourceUrl: httpUrlSchema,
            note: z.string().min(1).max(300)
          }).strict()).min(1).max(MAX_AI_ACTIVITY_TAGS).optional(),
          startsAt: isoDateSchema.nullable().optional(),
          endsAt: isoDateSchema.nullable().optional(),
          unresolvedFields: z.array(z.enum(['activityTags', 'startsAt', 'endsAt'])).max(3).optional(),
          unresolvedReason: z.string().min(1).max(500).nullable().optional(),
          sourceUrl: httpUrlSchema,
          confidence: z.number().min(0).max(1)
        }).strict()).min(1).max(100),
        evidence: z.array(z.object({
          url: httpUrlSchema,
          platform: z.string().min(1).max(100),
          publisher: z.string().min(1).max(100),
          official: z.boolean(),
          language: z.string().min(2).max(35),
          publishedAt: isoDateSchema.nullable().optional(),
          note: z.string().max(500).optional()
        }).strict()).max(100).default([])
      },
      annotations: { destructiveHint: false, openWorldHint: true }
    },
    async ({ agentId, jobId, contentLocale, retrievedAt, updates, evidence }) => {
      try {
        const normalizedEvidence = evidence.map(({ language, ...entry }) => ({
          ...entry,
          note: [entry.note, `页面语言：${language}`].filter(Boolean).join('；')
        }))
        return toolResult({
          command: 'apply_personal_metadata',
          ...database.applyPersonalMetadataJob(
            jobId,
            agentId,
            updates as PersonalMetadataUpdate[],
            {
              retrievedAt,
              evidence: normalizedEvidence,
              activityTagEvidence: updates.flatMap((update) =>
                (update.activityTagEvidence ?? []).map((entry) => ({
                  itemId: update.itemId,
                  title: update.title,
                  ...entry
                }))
              )
            },
            contentLocale
          )
        })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'apply_gacha_personal_review',
    {
      title: '提交个人数据异常核验',
      description: '按 personal_review job.contract 逐项解决个人数据语义异常。活动清单已先行建立，本工具按稳定官方 ID 后台修正；结构不完整的地图等异常仍在整批解决后激活。',
      inputSchema: {
        agentId: z.string().min(1).max(100),
        jobId: z.string().uuid(),
        contentLocale: z.string().min(2).max(35),
        retrievedAt: isoDateSchema,
        resolutions: z.array(z.object({
          candidateId: z.string().uuid(),
          decision: z.enum(['include', 'exclude']),
          eventScope: z.enum(['limited', 'permanent', 'unknown']).optional(),
          reason: z.string().min(1).max(500),
          title: z.string().min(1).max(100).optional(),
          activityTags: z.array(activityTagIdSchema)
            .min(MIN_AI_ACTIVITY_TAGS).max(MAX_AI_ACTIVITY_TAGS).optional()
            .describe('个人异常审核通常省略此字段，由后续 personal_metadata 任务补标'),
          completed: z.boolean().optional(),
          completionRule: z.object({
            fieldPath: z.string().regex(/^observedStatus(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u).max(160),
            completedValues: z.array(personalRuleValueSchema).min(1).max(20),
            incompleteValues: z.array(personalRuleValueSchema).max(20)
          }).strict().nullable().optional(),
          startsAt: isoDateSchema.nullable().optional(),
          endsAt: isoDateSchema.nullable().optional(),
          modeKey: z.string().min(1).max(200).nullable().optional(),
          periodKey: z.string().min(1).max(200).nullable().optional(),
          mapNodeKind: mapNodeKindSchema.nullable().optional(),
          parentExternalId: z.string().min(1).max(300).nullable().optional(),
          sourceUrl: httpUrlSchema.nullable().optional(),
          confidence: z.number().min(0).max(1)
        }).strict()).min(1).max(100),
        evidence: z.array(z.object({
          url: httpUrlSchema,
          platform: z.string().min(1).max(100),
          publisher: z.string().min(1).max(100),
          official: z.boolean(),
          language: z.string().min(2).max(35),
          publishedAt: isoDateSchema.nullable().optional(),
          note: z.string().max(500).optional()
        }).strict()).max(100).default([])
      },
      annotations: { destructiveHint: true, openWorldHint: true }
    },
    async ({ agentId, jobId, contentLocale, retrievedAt, resolutions, evidence }) => {
      try {
        const normalizedEvidence = evidence.map(({ language, ...entry }) => ({
          ...entry,
          note: [entry.note, `页面语言：${language}`].filter(Boolean).join('；')
        }))
        const result = database.applyPersonalReviewJob(
          jobId,
          agentId,
          resolutions as PersonalReviewResolution[],
          { retrievedAt, evidence: normalizedEvidence },
          contentLocale
        )
        if (result.job.target === 'events' || result.job.target === 'cycles') {
          database.createPersonalMetadataJob(
            result.job.gameId,
            result.job.target,
            result.job.requestContext,
            new Date(),
            true
          )
        }
        return toolResult({ command: 'apply_personal_review', ...result })
      } catch (error) {
        return toolError(error)
      }
    }
  )

  server.registerTool(
    'fail_gacha_schedule_job',
    {
      title: '报告公开资料检索失败',
      description: 'Codex 穷尽有用检索后结束已领取任务；不撤销此前已经安全保存的版块结果。',
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
        title: 'Gtask 本地备份',
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
