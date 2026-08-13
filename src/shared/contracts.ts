export const SUPPORTED_GAME_IDS = ['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const
export const GTASK_MCP_PROTOCOL_VERSION = '2026-08-09.1'

export type GameId = (typeof SUPPORTED_GAME_IDS)[number]

export const CHECKLIST_CATEGORIES = [
  'limited_event',
  'endgame',
  'exploration',
  'custom'
] as const

export type ChecklistCategory = (typeof CHECKLIST_CATEGORIES)[number]
export type ChecklistSource = 'manual' | 'public_schedule' | 'personal_sync'
export const MAP_NODE_KINDS = ['region', 'subregion'] as const
export type MapNodeKind = (typeof MAP_NODE_KINDS)[number]

export const CHECKLIST_SECTIONS = ['events', 'cycles', 'exploration', 'custom'] as const
export type ChecklistSection = (typeof CHECKLIST_SECTIONS)[number]

export type SyncScope = 'public_schedule'
export type SyncRequestScope = SyncScope | 'personal_data'
export const SYNC_TARGETS = ['all', 'tasks', 'events', 'cycles', 'exploration'] as const
export type SyncTarget = (typeof SYNC_TARGETS)[number]
export type SyncIndicatorTarget = SyncTarget
export type PersonalSyncTarget = Exclude<SyncTarget, 'all' | 'tasks'>
export type SyncStatus = 'idle' | 'success' | 'error' | 'stale' | 'verification_required'
export const SCHEDULE_KINDS = ['fixed_window', 'remote_schedule'] as const
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number]
export const CREDENTIAL_PROVIDERS = ['miyoushe', 'kuro-community'] as const
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number]

export const CODEX_WORKER_STRATEGIES = ['fixed'] as const
export type CodexWorkerStrategy = (typeof CODEX_WORKER_STRATEGIES)[number]
export const CODEX_WORKER_MODELS = [
  'inherit',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna'
] as const
export type CodexWorkerModel = (typeof CODEX_WORKER_MODELS)[number]
export const CODEX_REASONING_EFFORTS = [
  'inherit',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra'
] as const
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number]

export interface CodexWorkerPreferences {
  strategy: CodexWorkerStrategy
  model: CodexWorkerModel
  reasoningEffort: CodexReasoningEffort
}

export const RENDERING_MODES = ['compatibility', 'accelerated'] as const
export type RenderingMode = (typeof RENDERING_MODES)[number]

export interface RenderingModeState {
  configured: RenderingMode
  active: RenderingMode
  restartRequired: boolean
}

export interface SoftwareUpdateSettings {
  autoCheckEnabled: boolean
  updateSource: SoftwareUpdateSource
  lastSuccessfulCheckAt: string | null
  lastAutomaticCheckAt: string | null
}

export const SOFTWARE_UPDATE_SOURCES = ['auto', 'gitee', 'github'] as const
export type SoftwareUpdateSource = (typeof SOFTWARE_UPDATE_SOURCES)[number]

export type SoftwareUpdateCheckOutcome =
  | 'update_available'
  | 'up_to_date'
  | 'unavailable'
  | 'error'

export interface SoftwareUpdateCheckResult {
  outcome: SoftwareUpdateCheckOutcome
  currentVersion: string
  latestVersion: string | null
  releaseUrl: string | null
  checkedAt: string | null
  message: string
}

export interface RemoteCatalogCheckResult {
  outcome: 'updated' | 'up_to_date' | 'cooldown'
  revision: string | null
  checkedAt: string
  added: number
  updated: number
  preserved: number
  archived: number
  expiredRemoved: number
  message: string
  manualRetryAt: string | null
}

export interface RemoteCatalogUpdateStatus {
  revision: string | null
  manualRetryAt: string | null
}

export interface CredentialStatus {
  provider: CredentialProvider
  stored: boolean
  updatedAt: string | null
}

export interface KuroCommunityRole {
  roleId: string
  roleName: string
  serverId: string
  serverName: string | null
}

export interface KuroCommunitySmsState {
  sessionId: string
  expiresAt: string
  message: string
}

export interface KuroCommunityLoginResult {
  sessionId: string
  roles: KuroCommunityRole[]
}

export type MiyousheQrLoginStatus =
  | 'waiting_scan'
  | 'waiting_confirmation'
  | 'confirmed'
  | 'expired'

export interface MiyousheQrLoginState {
  sessionId: string
  qrCodeDataUrl: string | null
  status: MiyousheQrLoginStatus
  message: string
  expiresAt: string
}

export interface BackupSummary {
  fileName: string
  sizeBytes: number
  updatedAt: string
  kind: 'daily' | 'pre_migration' | 'pre_restore' | 'manual'
}

export type AiScheduleJobStatus = 'pending' | 'claimed' | 'completed' | 'failed'
export type AiScheduleJobKind = 'public_catalog'
export const SYNC_PROGRESS_PHASES = [
  'queued',
  'fetching',
  'searching',
  'verifying',
  'structuring',
  'writing',
  'retrying',
  'verification',
  'merging',
  'completed',
  'failed',
  'cancelled'
] as const
export type SyncProgressPhase = (typeof SYNC_PROGRESS_PHASES)[number]
export type SyncProgressStatus =
  | 'waiting'
  | 'running'
  | 'verification_required'
  | 'completed'
  | 'error'
  | 'cancelled'

export interface SyncProgressUpdate {
  gameId: GameId
  target: SyncTarget
  source: 'public_schedule' | 'personal_data'
  phase: SyncProgressPhase
  status: SyncProgressStatus
  /** Structured retry origin used for UI decisions; never infer it from message text. */
  retryKind?: 'codex_connection' | 'source_request' | null
  /** Internal diagnostic only. Product UI must derive copy from structured fields. */
  message: string
  current: number | null
  total: number | null
  updatedAt: string
}

export interface AiScheduleAgentStatus {
  connected: boolean
  agentId: string | null
  name: string | null
  lastSeenAt: string | null
}

export interface ActivityTagEnrichmentTarget {
  itemId: string
  title: string
  currentTags: string[]
  source: ChecklistSource
  remoteKey: string | null
  sourceUrl: string | null
  startsAt: string | null
  endsAt: string | null
}

export interface AiScheduleMatchCandidate {
  itemId: string
  category: ChecklistCategory
  title: string
  source: ChecklistSource
  remoteKey: string | null
  modeKey: string | null
  periodKey: string | null
  startsAt: string | null
  endsAt: string | null
  parentTitle: string | null
  mapNodeKind: MapNodeKind | null
  parentRemoteKey: string | null
  completed: boolean
  progressPercent: number | null
}

export interface SyncContractConditionalField {
  field: string
  when: string
  meaning: string
}

export interface SyncContractItemShape {
  name: string
  categories: ChecklistCategory[]
  requiredFields: string[]
  conditionalFields: SyncContractConditionalField[]
  forbiddenFields: string[]
}

export interface SyncSectionContract {
  target: Exclude<SyncTarget, 'all'>
  purpose: string
  inventoryScope: string
  itemShapes: SyncContractItemShape[]
  completionCriteria: string[]
}

export interface SyncRequestContext {
  outputLocale: string
  userTimeZone: string
}

export interface ActivityTagContractEntry {
  id: string
  dimension: 'gameplay' | 'format' | 'content' | 'reward'
  qualityRole: 'primary' | 'supporting' | 'fallback'
  label: string
  description: string
}

export interface PublicSyncContract {
  schemaVersion: 14
  jobKind: 'public_catalog'
  authority: 'interface_contract'
  decisionAuthority: 'codex'
  executorPolicy: 'mechanical_validation_only'
  allowedMutations: ['create', 'update', 'archive']
  target: SyncTarget
  requestContext: SyncRequestContext
  workflow: ['inventory', 'research_required_fields', 'verify', 'match_existing', 'submit']
  commonRequiredItemFields: string[]
  submissionRequiredFields: string[]
  fieldSemantics: Record<string, string>
  activityTagCatalog: ActivityTagContractEntry[]
  sections: SyncSectionContract[]
}

export interface AiScheduleJob {
  id: string
  jobKind: AiScheduleJobKind
  gameId: GameId
  scope: SyncScope
  target: SyncTarget
  userTimeZone: string
  outputLocale: string
  requestContext: SyncRequestContext
  status: AiScheduleJobStatus
  requestedAt: string
  claimedAt: string | null
  completedAt: string | null
  agentId: string | null
  agentName: string | null
  message: string | null
  progressPhase: SyncProgressPhase
  progressCurrent: number | null
  progressTotal: number | null
  progressUpdatedAt: string
  routingTier: number
  attemptCount: number
  assignedModel: CodexWorkerModel | null
  assignedReasoningEffort: CodexReasoningEffort | null
  lastFailureKind: string | null
  activityTagTargets: ActivityTagEnrichmentTarget[]
  matchCandidates: AiScheduleMatchCandidate[]
  contract: PublicSyncContract
}

export interface GameSummary {
  id: GameId
  name: string
  shortName: string
  accent: string
  sortOrder: number
  enabled: boolean
}

export interface GameVersionSummary {
  gameId: GameId
  endsAt: string | null
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
  activityTags: string[]
  completed: boolean
  progressPercent: number | null
  parentTitle: string | null
  mapNodeKind: MapNodeKind | null
  parentRemoteKey: string | null
  startsAt: string | null
  endsAt: string | null
  resetRule: string | null
  periodKey: string | null
  scheduleKind: ScheduleKind | null
  resetWeekday: number | null
  timeZone: string | null
  modeKey: string | null
  recurrenceRule: string | null
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
  activityTags?: string[]
  progressPercent?: number | null
  parentTitle?: string | null
  mapNodeKind?: MapNodeKind | null
  parentRemoteKey?: string | null
  startsAt?: string | null
  endsAt?: string | null
  resetRule?: string | null
  scheduleKind?: ScheduleKind | null
  resetWeekday?: number | null
  timeZone?: string | null
  modeKey?: string | null
  recurrenceRule?: string | null
}

export interface UpdateChecklistItemInput {
  id: string
  category?: ChecklistCategory
  title?: string
  activityTags?: string[]
  completed?: boolean
  progressPercent?: number | null
  parentTitle?: string | null
  mapNodeKind?: MapNodeKind | null
  parentRemoteKey?: string | null
  startsAt?: string | null
  endsAt?: string | null
  resetRule?: string | null
  scheduleKind?: ScheduleKind | null
  resetWeekday?: number | null
  timeZone?: string | null
  modeKey?: string | null
  recurrenceRule?: string | null
}

export interface ArchiveCompletedSectionInput {
  gameId: GameId
  section: ChecklistSection
}

export interface SyncSettings {
  gameId: GameId
  autoSyncEnabled: boolean
  status: SyncStatus
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  message: string | null
}

export interface SyncTargetState {
  gameId: GameId
  target: SyncIndicatorTarget
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  status: SyncStatus
  catalogCoverage: 'empty' | 'partial' | 'complete'
  catalogSource: 'public_schedule' | 'personal_data' | null
}

export interface SyncSourceResult {
  source: 'public_schedule' | 'personal_data'
  status: 'success' | 'error' | 'skipped' | 'verification_required' | 'cancelled'
  message: string
  added: number
  updated: number
  preserved: number
}

export interface SyncResult {
  gameId: GameId
  requestedScope: SyncRequestScope
  requestedTarget: SyncTarget
  status: 'success' | 'partial' | 'error' | 'cancelled'
  startedAt: string
  finishedAt: string
  sources: SyncSourceResult[]
  message: string
}

export interface GachaApi {
  getAppInfo: () => Promise<AppInfo>
  getRenderingModeState: () => Promise<RenderingModeState>
  updateRenderingMode: (mode: RenderingMode) => Promise<RenderingModeState>
  getSoftwareUpdateSettings: () => Promise<SoftwareUpdateSettings>
  updateSoftwareUpdateSettings: (
    settings: Pick<SoftwareUpdateSettings, 'autoCheckEnabled' | 'updateSource'>
  ) => Promise<SoftwareUpdateSettings>
  checkSoftwareUpdate: () => Promise<SoftwareUpdateCheckResult>
  getRemoteCatalogUpdateStatus: () => Promise<RemoteCatalogUpdateStatus>
  checkRemoteCatalogUpdate: () => Promise<RemoteCatalogCheckResult>
  restartApp: () => Promise<boolean>
  openDataDirectory: () => Promise<void>
  openExternalUrl: (url: string) => Promise<void>
  listBackups: () => Promise<BackupSummary[]>
  createBackup: () => Promise<BackupSummary>
  restoreBackup: (fileName: string) => Promise<boolean>
  listGames: () => Promise<GameSummary[]>
  listGameVersionSummaries: () => Promise<GameVersionSummary[]>
  listChecklistItems: (gameId: GameId) => Promise<ChecklistItem[]>
  listArchivedChecklistItems: (gameId: GameId) => Promise<ChecklistItem[]>
  createChecklistItem: (input: CreateChecklistItemInput) => Promise<ChecklistItem>
  updateChecklistItem: (input: UpdateChecklistItemInput) => Promise<ChecklistItem>
  setChecklistCompletion: (id: string, completed: boolean) => Promise<ChecklistItem[]>
  archiveChecklistItem: (id: string) => Promise<void>
  restoreChecklistItem: (id: string) => Promise<ChecklistItem>
  emptyRecycleBin: (gameId: GameId) => Promise<number>
  archiveCompletedSection: (input: ArchiveCompletedSectionInput) => Promise<number>
  getSyncSettings: (gameId: GameId) => Promise<SyncSettings>
  updateSyncSettings: (
    gameId: GameId,
    settings: Pick<SyncSettings, 'autoSyncEnabled'>
  ) => Promise<SyncSettings>
  getSyncTargetStates: (gameId: GameId) => Promise<SyncTargetState[]>
  getPersonalSyncTargets: (gameId: GameId) => Promise<PersonalSyncTarget[]>
  syncPersonalData: (
    gameId: GameId,
    target?: SyncTarget,
    requestContext?: SyncRequestContext
  ) => Promise<SyncResult>
  listCredentialStatuses: () => Promise<CredentialStatus[]>
  startMiyousheQrLogin: () => Promise<MiyousheQrLoginState>
  pollMiyousheQrLogin: (sessionId: string) => Promise<MiyousheQrLoginState>
  cancelMiyousheQrLogin: (sessionId: string) => Promise<boolean>
  sendKuroCommunitySms: (phone: string) => Promise<KuroCommunitySmsState>
  completeKuroCommunityLogin: (
    sessionId: string,
    code: string
  ) => Promise<KuroCommunityLoginResult>
  storeKuroCommunityLogin: (
    sessionId: string,
    roleId: string,
    serverId: string
  ) => Promise<CredentialStatus>
  cancelKuroCommunityLogin: (sessionId: string) => Promise<boolean>
  clearCredential: (provider: CredentialProvider) => Promise<boolean>
  onSyncCompleted: (callback: (result: SyncResult) => void) => () => void
  onSyncProgress: (callback: (progress: SyncProgressUpdate) => void) => () => void
  onChecklistChanged: (callback: () => void) => () => void
}
