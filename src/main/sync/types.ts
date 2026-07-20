import type {
  ChecklistCategory,
  GameId,
  ScheduleKind,
  SyncSourceResult
} from '../../shared/contracts'

export interface NormalizedSyncItem {
  remoteKey: string
  sourceUrl?: string | null
  category: ChecklistCategory
  title: string
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
}

export interface SyncMergeResult {
  added: number
  updated: number
  preserved: number
}

export interface SyncAdapterOutput {
  items: NormalizedSyncItem[]
  message: string
}

export interface SyncAdapter {
  sync: (gameId: GameId) => Promise<SyncAdapterOutput>
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
