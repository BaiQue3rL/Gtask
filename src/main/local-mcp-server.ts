import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import * as z from 'zod/v4'
import {
  CHECKLIST_CATEGORIES,
  SUPPORTED_GAME_IDS,
  type ChecklistCategory,
  type GameId
} from '../shared/contracts'
import type { AppDatabase } from './database'
import { LocalCommandService, type LocalCommandResult } from './local-command-service'

const gameIdSchema = z.enum(SUPPORTED_GAME_IDS)
const categorySchema = z.enum(CHECKLIST_CATEGORIES)
const sectionSchema = z.enum(['tasks', 'events', 'cycles', 'exploration', 'custom'])
const scheduleKindSchema = z.enum(['weekly', 'fixed_window', 'remote_schedule'])
const nullableTextSchema = z.string().max(200).nullable().optional()
const nullableDateSchema = z.string().nullable().optional()
const nullableProgressSchema = z.number().min(0).max(100).nullable().optional()

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
  modeKey: nullableTextSchema
}

function toolResult(result: LocalCommandResult) {
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

export function createLocalMcpServer(database: AppDatabase): McpServer {
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
        modeKey: nullableTextSchema
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

  return server
}
