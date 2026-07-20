import {
  CHECKLIST_CATEGORIES,
  CHECKLIST_SECTIONS,
  SUPPORTED_GAME_IDS,
  type ChecklistItem,
  type GameSummary,
  type SyncSettings
} from '../shared/contracts'
import type { AppDatabase } from './database'
import {
  parseChecklistCategory,
  parseChecklistSection,
  parseCreateChecklistItem,
  parseGameId,
  parseItemId,
  parseUpdateChecklistItem
} from './validation'

const SECTION_CATEGORIES = {
  tasks: ['main_quest', 'side_quest'],
  events: ['limited_event', 'permanent_event'],
  cycles: ['weekly', 'endgame'],
  exploration: ['exploration'],
  custom: ['custom']
} as const

export type LocalCommandResult =
  | {
      command: 'describe_commands'
      schemaVersion: 1
      supportedGameIds: readonly string[]
      categories: readonly string[]
      sections: readonly string[]
      commands: readonly string[]
      destructiveCommands: readonly string[]
      maximumBatchSize: 100
    }
  | { command: 'list_games'; games: GameSummary[] }
  | {
      command: 'get_all_snapshots'
      snapshots: Array<{
        game: GameSummary
        items: ChecklistItem[]
        archivedItems: ChecklistItem[]
        syncSettings: SyncSettings
      }>
    }
  | {
      command: 'get_game_snapshot'
      game: GameSummary
      items: ChecklistItem[]
      archivedItems: ChecklistItem[]
      syncSettings: SyncSettings
    }
  | { command: 'create_item' | 'update_item' | 'restore_item'; item: ChecklistItem }
  | { command: 'create_items' | 'update_items'; items: ChecklistItem[] }
  | { command: 'archive_item'; archived: true }
  | { command: 'archive_items'; archivedCount: number }
  | { command: 'archive_completed_section'; archivedCount: number }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireConfirmation(value: unknown): void {
  if (value !== true) throw new Error('删除命令必须显式传入 confirm: true')
}

export class LocalCommandService {
  constructor(private readonly database: AppDatabase) {}

  execute(input: unknown): LocalCommandResult {
    if (!isRecord(input) || typeof input.command !== 'string') {
      throw new Error('本地命令格式不正确')
    }

    switch (input.command) {
      case 'describe_commands':
        return {
          command: 'describe_commands',
          schemaVersion: 1,
          supportedGameIds: SUPPORTED_GAME_IDS,
          categories: CHECKLIST_CATEGORIES,
          sections: CHECKLIST_SECTIONS,
          commands: [
            'describe_commands',
            'list_games',
            'get_all_snapshots',
            'get_game_snapshot',
            'create_item',
            'create_items',
            'update_item',
            'update_items',
            'archive_item',
            'archive_items',
            'restore_item',
            'archive_completed_section'
          ],
          destructiveCommands: ['archive_item', 'archive_items', 'archive_completed_section'],
          maximumBatchSize: 100
        }
      case 'list_games':
        return { command: 'list_games', games: this.database.listGames() }
      case 'get_all_snapshots':
        return this.database.readConsistently(() => ({
          command: 'get_all_snapshots' as const,
          snapshots: this.database.listGames().map((game) => ({
            game,
            items: this.database.listChecklistItems(game.id),
            archivedItems: input.includeArchived === true
              ? this.database.listArchivedChecklistItems(game.id)
              : [],
            syncSettings: this.database.getSyncSettings(game.id)
          }))
        }))
      case 'get_game_snapshot': {
        const gameId = parseGameId(input.gameId)
        const category = input.category === undefined
          ? undefined
          : parseChecklistCategory(input.category)
        if (input.completed !== undefined && typeof input.completed !== 'boolean') {
          throw new Error('完成状态筛选格式不正确')
        }
        return this.database.readConsistently(() => {
          const game = this.database.listGames().find((candidate) => candidate.id === gameId)
          if (!game) throw new Error('游戏不存在')
          let items = this.database.listChecklistItems(gameId)
          if (category !== undefined) items = items.filter((item) => item.category === category)
          if (input.completed !== undefined) {
            items = items.filter((item) => item.completed === input.completed)
          }
          return {
            command: 'get_game_snapshot' as const,
            game,
            items,
            archivedItems: input.includeArchived === true
              ? this.database.listArchivedChecklistItems(gameId)
              : [],
            syncSettings: this.database.getSyncSettings(gameId)
          }
        })
      }
      case 'create_item':
        return {
          command: 'create_item',
          item: this.database.createChecklistItem(parseCreateChecklistItem(input.item))
        }
      case 'create_items': {
        if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) {
          throw new Error('批量新增事项必须包含 1 到 100 项')
        }
        const items = input.items.map(parseCreateChecklistItem)
        return { command: 'create_items', items: this.database.createChecklistItems(items) }
      }
      case 'update_item':
        return {
          command: 'update_item',
          item: this.database.updateChecklistItem(parseUpdateChecklistItem(input.item))
        }
      case 'update_items': {
        if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) {
          throw new Error('批量更新事项必须包含 1 到 100 项')
        }
        const items = input.items.map(parseUpdateChecklistItem)
        return { command: 'update_items', items: this.database.updateChecklistItems(items) }
      }
      case 'archive_item':
        requireConfirmation(input.confirm)
        this.database.archiveChecklistItem(parseItemId(input.id))
        return { command: 'archive_item', archived: true }
      case 'archive_items': {
        requireConfirmation(input.confirm)
        if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.length > 100) {
          throw new Error('批量删除事项必须包含 1 到 100 个 ID')
        }
        const ids = input.ids.map(parseItemId)
        return { command: 'archive_items', archivedCount: this.database.archiveChecklistItems(ids) }
      }
      case 'restore_item':
        return { command: 'restore_item', item: this.database.restoreChecklistItem(parseItemId(input.id)) }
      case 'archive_completed_section': {
        requireConfirmation(input.confirm)
        const gameId = parseGameId(input.gameId)
        const section = parseChecklistSection(input.section)
        return {
          command: 'archive_completed_section',
          archivedCount: this.database.archiveCompletedSection(gameId, [...SECTION_CATEGORIES[section]])
        }
      }
      default:
        throw new Error(`不支持的本地命令：${input.command}`)
    }
  }
}
