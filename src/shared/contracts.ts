export const SUPPORTED_GAME_IDS = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const

export type GameId = (typeof SUPPORTED_GAME_IDS)[number]

export const CHECKLIST_CATEGORIES = [
  'main_quest',
  'side_quest',
  'limited_event',
  'permanent_event',
  'weekly',
  'endgame',
  'exploration',
  'custom'
] as const

export type ChecklistCategory = (typeof CHECKLIST_CATEGORIES)[number]
export type ChecklistSource = 'manual' | 'public_schedule' | 'personal_sync'

export interface GameSummary {
  id: GameId
  name: string
  shortName: string
  accent: string
  sortOrder: number
  enabled: boolean
}

export interface AppInfo {
  version: string
  dataPath: string
}

export interface ChecklistItem {
  id: string
  gameId: GameId
  category: ChecklistCategory
  title: string
  completed: boolean
  progressPercent: number | null
  startsAt: string | null
  endsAt: string | null
  resetRule: string | null
  periodKey: string | null
  source: ChecklistSource
  manualCompletionLocked: boolean
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateChecklistItemInput {
  gameId: GameId
  category: ChecklistCategory
  title: string
  progressPercent?: number | null
  startsAt?: string | null
  endsAt?: string | null
  resetRule?: string | null
}

export interface UpdateChecklistItemInput {
  id: string
  category?: ChecklistCategory
  title?: string
  completed?: boolean
  progressPercent?: number | null
  startsAt?: string | null
  endsAt?: string | null
  resetRule?: string | null
}

export interface GachaApi {
  getAppInfo: () => Promise<AppInfo>
  listGames: () => Promise<GameSummary[]>
  listChecklistItems: (gameId: GameId) => Promise<ChecklistItem[]>
  createChecklistItem: (input: CreateChecklistItemInput) => Promise<ChecklistItem>
  updateChecklistItem: (input: UpdateChecklistItemInput) => Promise<ChecklistItem>
  archiveChecklistItem: (id: string) => Promise<void>
}
