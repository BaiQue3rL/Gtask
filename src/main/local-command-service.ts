import type { ChecklistItem, GameSummary, SyncSettings } from '../shared/contracts'
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
  | { command: 'list_games'; games: GameSummary[] }
  | {
      command: 'get_game_snapshot'
      game: GameSummary
      items: ChecklistItem[]
      archivedItems: ChecklistItem[]
      syncSettings: SyncSettings
    }
  | { command: 'create_item' | 'update_item' | 'restore_item'; item: ChecklistItem }
  | { command: 'archive_item'; archived: true }
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
      case 'list_games':
        return { command: 'list_games', games: this.database.listGames() }
      case 'get_game_snapshot': {
        const gameId = parseGameId(input.gameId)
        const game = this.database.listGames().find((candidate) => candidate.id === gameId)
        if (!game) throw new Error('游戏不存在')
        let items = this.database.listChecklistItems(gameId)
        if (input.category !== undefined) {
          const category = parseChecklistCategory(input.category)
          items = items.filter((item) => item.category === category)
        }
        if (input.completed !== undefined) {
          if (typeof input.completed !== 'boolean') throw new Error('完成状态筛选格式不正确')
          items = items.filter((item) => item.completed === input.completed)
        }
        return {
          command: 'get_game_snapshot',
          game,
          items,
          archivedItems: input.includeArchived === true
            ? this.database.listArchivedChecklistItems(gameId)
            : [],
          syncSettings: this.database.getSyncSettings(gameId)
        }
      }
      case 'create_item':
        return { command: 'create_item', item: this.database.createChecklistItem(parseCreateChecklistItem(input.item)) }
      case 'update_item':
        return { command: 'update_item', item: this.database.updateChecklistItem(parseUpdateChecklistItem(input.item)) }
      case 'archive_item':
        requireConfirmation(input.confirm)
        this.database.archiveChecklistItem(parseItemId(input.id))
        return { command: 'archive_item', archived: true }
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
