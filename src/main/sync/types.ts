import type {
  ChecklistCategory,
  GameId,
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

export interface SyncMergeResult {
  added: number
  updated: number
  preserved: number
}

export interface SemanticReviewDraft {
  target: Exclude<SyncTarget, 'all' | 'tasks'>
  kind: string
  payload: Record<string, unknown>
}

export interface SyncAdapterOutput {
  items: NormalizedSyncItem[]
  reviewCandidates?: SemanticReviewDraft[]
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
    reportProgress?: SyncProgressReporter
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

export type CompletedSourceResult = SyncSourceResult
