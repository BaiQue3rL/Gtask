import type {
  ChecklistCategory,
  CredentialProvider,
  GameId,
  MapNodeKind,
  ScheduleKind,
  SyncProgressPhase,
  SyncProgressStatus,
  SyncSourceResult,
  SyncTarget,
  ScheduleObservationTarget
} from '../../shared/contracts'

export interface NormalizedSyncItem {
  remoteKey: string
  sourceUrl?: string | null
  category: ChecklistCategory
  title: string
  activityTags?: string[]
  completed?: boolean
  progressPercent?: number | null
  parentTitle?: string | null
  mapNodeKind?: MapNodeKind | null
  parentRemoteKey?: string | null
  startsAt?: string | null
  endsAt?: string | null
  resetRule?: string | null
  periodKey?: string | null
  scheduleKind?: ScheduleKind | null
  resetWeekday?: number | null
  timeZone?: string | null
  modeKey?: string | null
  recurrenceRule?: string | null
  /** Stable identity supplied by an authenticated official endpoint. */
  sourceIdentity?: {
    provider: 'miyoushe' | 'kuro-community' | string
    endpoint: string
    externalId: string
  }
}

export interface CodexScheduleItem extends NormalizedSyncItem {
  matchItemId?: string
  sourceObservationId?: string
}

export interface CodexVersionWindow {
  periodKey: string
  startsAt: string
  endsAt: string
  timeZone: string
  sourceUrl: string
  confidence: number
}

export interface CodexArchiveDecision {
  itemId: string
  reason: string
}

export interface SyncMergeResult {
  added: number
  updated: number
  preserved: number
  expiredRemoved?: number
}

export interface ActivityTagUpdate {
  itemId: string
  title: string
  activityTags: string[]
  activityTagEvidence?: ActivityTagEvidenceInput[]
  sourceUrl: string
  confidence: number
  unresolvedReason?: string | null
}

export interface ActivityTagEvidenceInput {
  tagId: string
  sourceUrl: string
  note: string
}

export interface PersonalProgressCandidate {
  target: Exclude<SyncTarget, 'all' | 'tasks'>
  kind: string
  payload: Record<string, unknown>
}

export interface ScheduleObservationInput {
  target: ScheduleObservationTarget
  provider: CredentialProvider
  endpoint: string
  remoteKey: string
  title: string
  modeKey: string | null
  periodKey: string | null
  startsAt: string | null
  endsAt: string | null
}

export interface SyncAdapterOutput {
  items: NormalizedSyncItem[]
  /**
   * Account-free official schedule facts observed while syncing personal progress.
   * Completion, scores, progress, account identifiers and credentials are forbidden.
   */
  scheduleObservations?: ScheduleObservationInput[]
  /** A partial personal response must never replace the active snapshot. */
  snapshotCompleteness?: 'complete' | 'partial'
  adapterVersion?: string
  /**
   * Opaque, one-way account/role scope used to keep personal states isolated.
   * It must never contain a raw UID, role id, Cookie or token.
   */
  accountScope?: string
  message: string
}

export interface SyncAdapterProgress {
  phase: SyncProgressPhase
  status?: SyncProgressStatus
  message: string
  current?: number | null
  total?: number | null
}

export type SyncProgressReporter = (progress: SyncAdapterProgress) => void

export interface SyncAdapter {
  sync: (
    gameId: GameId,
    target?: SyncTarget,
    reportProgress?: SyncProgressReporter,
    signal?: AbortSignal
  ) => Promise<SyncAdapterOutput>
}

export interface SyncAdapterRegistry {
  publicSchedule: Partial<Record<GameId, SyncAdapter>>
  personalData: Partial<Record<GameId, SyncAdapter>>
}

export class SyncVerificationRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SyncVerificationRequiredError'
  }
}

export class SyncCancelledError extends Error {
  constructor(message = '同步已取消') {
    super(message)
    this.name = 'SyncCancelledError'
  }
}

export function throwIfSyncCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  if (signal.reason instanceof SyncCancelledError) throw signal.reason
  throw new SyncCancelledError()
}

export function isSyncCancelledError(error: unknown): boolean {
  return error instanceof SyncCancelledError ||
    (error instanceof Error && error.name === 'SyncCancelledError')
}

export type CompletedSourceResult = SyncSourceResult
