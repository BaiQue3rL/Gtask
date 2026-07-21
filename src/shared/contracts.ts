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

export const CHECKLIST_SECTIONS = ['tasks', 'events', 'cycles', 'exploration', 'custom'] as const
export type ChecklistSection = (typeof CHECKLIST_SECTIONS)[number]

export const SYNC_RUN_MODES = ['manual', 'automatic'] as const
export type SyncRunMode = (typeof SYNC_RUN_MODES)[number]
export const SYNC_SCOPES = ['public_schedule', 'public_and_personal'] as const
export type SyncScope = (typeof SYNC_SCOPES)[number]
export type SyncStatus = 'idle' | 'success' | 'error' | 'stale' | 'verification_required'
export const SCHEDULE_KINDS = ['weekly', 'fixed_window', 'remote_schedule'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]
export const CREDENTIAL_PROVIDERS = ['miyoushe', 'kuro-community', 'deepseek'] as const
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number]

export interface CredentialStatus {
  provider: CredentialProvider
  stored: boolean
  updatedAt: string | null
}

export interface AiProviderConnectionResult {
  connected: boolean
  provider: 'deepseek'
  model: string
  message: string
  testedAt: string
}

export interface BackupSummary {
  fileName: string
  sizeBytes: number
  updatedAt: string
  kind: 'daily' | 'pre_migration' | 'pre_restore' | 'manual'
}

export type AiScheduleJobStatus = 'pending' | 'claimed' | 'completed' | 'failed'

export interface AiScheduleAgentStatus {
  connected: boolean
  agentId: string | null
  name: string | null
  lastSeenAt: string | null
}

export interface AiScheduleJob {
  id: string
  gameId: GameId
  scope: SyncScope
  status: AiScheduleJobStatus
  requestedAt: string
  claimedAt: string | null
  completedAt: string | null
  agentId: string | null
  agentName: string | null
  message: string | null
}

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
  parentTitle: string | null
  startsAt: string | null
  endsAt: string | null
  resetRule: string | null
  periodKey: string | null
  scheduleKind: ScheduleKind | null
  resetWeekday: number | null
  timeZone: string | null
  modeKey: string | null
  source: ChecklistSource
  remoteKey: string | null
  sourceUrl: string | null
  manualCompletionLocked: boolean
  lastSyncedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateChecklistItemInput {
  gameId: GameId
  category: ChecklistCategory
  title: string
  progressPercent?: number | null
  parentTitle?: string | null
  startsAt?: string | null
  endsAt?: string | null
  resetRule?: string | null
  scheduleKind?: ScheduleKind | null
  resetWeekday?: number | null
  timeZone?: string | null
  modeKey?: string | null
}

export interface UpdateChecklistItemInput {
  id: string
  category?: ChecklistCategory
  title?: string
  completed?: boolean
  progressPercent?: number | null
  parentTitle?: string | null
  startsAt?: string | null
  endsAt?: string | null
  resetRule?: string | null
  scheduleKind?: ScheduleKind | null
  resetWeekday?: number | null
  timeZone?: string | null
  modeKey?: string | null
}

export interface ArchiveCompletedSectionInput {
  gameId: GameId
  section: ChecklistSection
}

export interface SyncSettings {
  gameId: GameId
  runMode: SyncRunMode
  autoScope: SyncScope
  status: SyncStatus
  lastScope: SyncScope | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  message: string | null
}

export interface UpdateSyncSettingsInput {
  gameId: GameId
  runMode: SyncRunMode
  autoScope: SyncScope
}

export interface SyncSourceResult {
  source: 'public_schedule' | 'personal_data'
  status: 'success' | 'error' | 'skipped' | 'verification_required'
  message: string
  added: number
  updated: number
  preserved: number
}

export interface SyncResult {
  gameId: GameId
  requestedScope: SyncScope
  status: 'success' | 'partial' | 'error'
  startedAt: string
  finishedAt: string
  sources: SyncSourceResult[]
  message: string
}

export interface GachaApi {
  getAppInfo: () => Promise<AppInfo>
  openDataDirectory: () => Promise<void>
  openExternalUrl: (url: string) => Promise<void>
  listBackups: () => Promise<BackupSummary[]>
  createBackup: () => Promise<BackupSummary>
  restoreBackup: (fileName: string) => Promise<boolean>
  getAiScheduleAgentStatus: () => Promise<AiScheduleAgentStatus>
  listGames: () => Promise<GameSummary[]>
  listChecklistItems: (gameId: GameId) => Promise<ChecklistItem[]>
  listArchivedChecklistItems: (gameId: GameId) => Promise<ChecklistItem[]>
  createChecklistItem: (input: CreateChecklistItemInput) => Promise<ChecklistItem>
  updateChecklistItem: (input: UpdateChecklistItemInput) => Promise<ChecklistItem>
  archiveChecklistItem: (id: string) => Promise<void>
  restoreChecklistItem: (id: string) => Promise<ChecklistItem>
  archiveCompletedSection: (input: ArchiveCompletedSectionInput) => Promise<number>
  getSyncSettings: (gameId: GameId) => Promise<SyncSettings>
  updateSyncSettings: (input: UpdateSyncSettingsInput) => Promise<SyncSettings>
  syncGame: (gameId: GameId, scope: SyncScope) => Promise<SyncResult>
  listCredentialStatuses: () => Promise<CredentialStatus[]>
  saveDeepSeekApiKey: (apiKey: string) => Promise<CredentialStatus>
  testDeepSeekConnection: () => Promise<AiProviderConnectionResult>
  clearCredential: (provider: CredentialProvider) => Promise<boolean>
  onSyncCompleted: (callback: (result: SyncResult) => void) => () => void
  onChecklistChanged: (callback: () => void) => () => void
}
