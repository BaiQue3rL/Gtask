import {
  CHECKLIST_CATEGORIES,
  SUPPORTED_GAME_IDS,
  type ChecklistCategory,
  type CreateChecklistItemInput,
  type GameId,
  type UpdateChecklistItemInput
} from '../shared/contracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseGameId(value: unknown): GameId {
  if (typeof value !== 'string' || !SUPPORTED_GAME_IDS.includes(value as GameId)) {
    throw new Error('不支持的游戏')
  }
  return value as GameId
}

function parseCategory(value: unknown): ChecklistCategory {
  if (typeof value !== 'string' || !CHECKLIST_CATEGORIES.includes(value as ChecklistCategory)) {
    throw new Error('不支持的事项分类')
  }
  return value as ChecklistCategory
}

function parseTitle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('事项名称格式不正确')
  const title = value.trim()
  if (!title) throw new Error('事项名称不能为空')
  if (title.length > 100) throw new Error('事项名称不能超过 100 个字符')
  return title
}

function parseNullableString(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 200) throw new Error(`${fieldName}格式不正确`)
  return value
}

function parseProgress(value: unknown): number | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error('探索进度必须在 0 到 100 之间')
  }
  return value
}

export function parseCreateChecklistItem(value: unknown): CreateChecklistItemInput {
  if (!isRecord(value)) throw new Error('新增事项参数格式不正确')
  return {
    gameId: parseGameId(value.gameId),
    category: parseCategory(value.category),
    title: parseTitle(value.title),
    progressPercent: parseProgress(value.progressPercent),
    startsAt: parseNullableString(value.startsAt, '开始时间'),
    endsAt: parseNullableString(value.endsAt, '结束时间'),
    resetRule: parseNullableString(value.resetRule, '重置规则')
  }
}

export function parseUpdateChecklistItem(value: unknown): UpdateChecklistItemInput {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id) {
    throw new Error('更新事项参数格式不正确')
  }

  if (value.completed !== undefined && typeof value.completed !== 'boolean') {
    throw new Error('完成状态格式不正确')
  }

  return {
    id: value.id,
    category: value.category === undefined ? undefined : parseCategory(value.category),
    title: value.title === undefined ? undefined : parseTitle(value.title),
    completed: value.completed,
    progressPercent: parseProgress(value.progressPercent),
    startsAt: parseNullableString(value.startsAt, '开始时间'),
    endsAt: parseNullableString(value.endsAt, '结束时间'),
    resetRule: parseNullableString(value.resetRule, '重置规则')
  }
}

export function parseItemId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 100) throw new Error('事项 ID 格式不正确')
  return value
}
