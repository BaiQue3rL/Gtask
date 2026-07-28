import type {
  ChecklistCategory,
  GameId,
  MapNodeKind,
  ScheduleKind,
  SyncProgressPhase,
  SyncProgressStatus,
  SyncSourceResult,
  SyncTarget
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
  relatedRegionRemoteKey?: string | null
  startsAt?: string | null
  endsAt?: string | null
  resetRule?: string | null
  periodKey?: string | null
  scheduleKind?: ScheduleKind | null
  resetWeekday?: number | null
  timeZone?: string | null
  modeKey?: string | null
  recurrenceRule?: string | null
}

export interface CodexScheduleItem extends NormalizedSyncItem {
  matchItemId?: string
}

export interface CodexArchiveDecision {
  itemId: string
  reason: string
}

export interface SyncMergeResult {
  added: number
  updated: number
  preserved: number
}

export interface ActivityTagUpdate {
  itemId: string
  title: string
  activityTags: string[]
  sourceUrl: string
  confidence: number
  unresolvedReason?: string | null
}

export interface SemanticReviewDraft {
  target: Exclude<SyncTarget, 'all' | 'tasks'>
  kind: string
  payload: Record<string, unknown>
}

export interface SyncAdapterOutput {
  items: NormalizedSyncItem[]
  reviewCandidates?: SemanticReviewDraft[]
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
