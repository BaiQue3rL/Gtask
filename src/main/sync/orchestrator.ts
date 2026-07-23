import type {
  ChecklistCategory,
  GameId,
  SyncResult,
  SyncProgressUpdate,
  SyncScope,
  SyncTarget,
  SyncSourceResult,
  SyncStatus
} from '../../shared/contracts'
import type { AppDatabase } from '../database'
import {
  SyncVerificationRequiredError,
  type SyncAdapter,
  type SyncAdapterProgress,
  type SyncAdapterRegistry
} from './types'
import { normalizeSyncItems } from './normalization'

const PERSONAL_PLATFORM_NAMES: Record<GameId, string> = {
  genshin: '米游社',
  'star-rail': '米游社',
  zenless: '米游社',
  'wuthering-waves': '库街区'
}

export class SyncOrchestrator {
  private readonly inFlight = new Map<string, { scope: SyncScope; operation: Promise<SyncResult> }>()
  private readonly personalInFlight = new Map<string, Promise<SyncSourceResult>>()

  constructor(
    private readonly database: AppDatabase,
    private readonly adapters: SyncAdapterRegistry = { publicSchedule: {}, personalData: {} },
    private readonly onProgress?: (progress: SyncProgressUpdate) => void
  ) {}

  syncGame(gameId: GameId, scope: SyncScope, target: SyncTarget = 'all'): Promise<SyncResult> {
    const key = `${gameId}:${target}`
    const existing = this.inFlight.get(key)
    if (existing?.scope === scope) return existing.operation
    if (existing) return existing.operation.then(() => this.syncGame(gameId, scope, target))
    const operation = this.performSync(gameId, scope, target).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, { scope, operation })
    return operation
  }

  private async performSync(gameId: GameId, scope: SyncScope, target: SyncTarget): Promise<SyncResult> {
    const startedAt = new Date().toISOString()
    this.database.recordSyncAttempt(gameId, scope)

    const sources: SyncSourceResult[] = []
    sources.push(
      await this.runAdapter(
        gameId,
        'public_schedule',
        this.adapters.publicSchedule[gameId],
        '公开资料适配器尚未接入',
        target
      )
    )

    if (scope === 'public_and_personal') {
      sources.push(
        await this.runAdapter(
          gameId,
          'personal_data',
          this.adapters.personalData[gameId],
          `${PERSONAL_PLATFORM_NAMES[gameId]}个人数据适配器尚未接入`,
          target
        )
      )
    }

    const successCount = sources.filter((source) => source.status === 'success').length
    const hasPendingReview = sources.some((source) => (source.pendingReview ?? 0) > 0)
    const status: SyncResult['status'] =
      successCount === sources.length && !hasPendingReview
        ? 'success'
        : successCount > 0
          ? 'partial'
          : 'error'
    const message = sources.map((source) => source.message).join('；')
    const databaseStatus: SyncStatus = sources.some(
      (source) => source.status === 'verification_required'
    )
      ? 'verification_required'
      : status === 'success'
        ? 'success'
        : status === 'partial'
          ? 'stale'
          : 'error'
    this.database.recordSyncOutcome(gameId, databaseStatus, message, successCount > 0)
    if (sources[0]?.status === 'success' && !sources[0].pendingReview) {
      this.database.recordSyncTargetSuccess(gameId, target, new Date(), true)
    }

    return {
      gameId,
      requestedScope: scope,
      requestedTarget: target,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      message
    }
  }

  async syncPersonalOnly(gameId: GameId, target: SyncTarget = 'all'): Promise<SyncResult> {
    const startedAt = new Date().toISOString()
    this.database.recordPersonalSyncAttempt(gameId)
    const personal = await this.syncPersonalData(gameId, target)
    const hasPendingReview = (personal.pendingReview ?? 0) > 0
    const status: SyncResult['status'] = personal.status === 'success'
      ? hasPendingReview ? 'partial' : 'success'
      : 'error'
    const databaseStatus: SyncStatus = personal.status === 'verification_required'
      ? 'verification_required'
      : personal.status === 'success'
        ? hasPendingReview ? 'stale' : 'success'
        : 'error'
    this.database.recordSyncOutcome(
      gameId,
      databaseStatus,
      personal.message,
      personal.status === 'success' && (personal.added + personal.updated) > 0
    )
    if (personal.status === 'success' && !hasPendingReview) {
      this.database.recordSyncTargetSuccess(gameId, target)
    }
    return {
      gameId,
      requestedScope: 'personal_data',
      requestedTarget: target,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      sources: [personal],
      message: personal.message
    }
  }

  syncPersonalData(gameId: GameId, target: SyncTarget = 'all'): Promise<SyncSourceResult> {
    const key = `${gameId}:${target}`
    const existing = this.personalInFlight.get(key)
    if (existing) return existing
    const operation = this.runAdapter(
      gameId,
      'personal_data',
      this.adapters.personalData[gameId],
      `${PERSONAL_PLATFORM_NAMES[gameId]}个人数据适配器尚未接入`,
      target
    ).finally(() => {
      this.personalInFlight.delete(key)
    })
    this.personalInFlight.set(key, operation)
    return operation
  }

  private async runAdapter(
    gameId: GameId,
    source: SyncSourceResult['source'],
    adapter: SyncAdapter | undefined,
    unavailableMessage: string,
    target: SyncTarget = 'all'
  ): Promise<SyncSourceResult> {
    if (!adapter) {
      return {
        source,
        status: 'error',
        message: unavailableMessage,
        added: 0,
        updated: 0,
        preserved: 0
      }
    }

    try {
      const reportProgress = (progress: SyncAdapterProgress): void => {
        this.emitProgress(gameId, target, source, progress)
      }
      reportProgress({
        phase: 'fetching',
        message: source === 'personal_data' ? '正在连接个人数据服务' : '正在连接公开资料来源',
        current: 0,
        total: null
      })
      const result = await adapter.sync(gameId, target, reportProgress)
      reportProgress({
        phase: 'merging',
        message: '数据读取完成，正在安全合并清单',
        current: 1,
        total: 1
      })
      const checklistSource = source === 'public_schedule' ? 'public_schedule' : 'personal_sync'
      const targetCategories: Partial<Record<SyncTarget, ChecklistCategory[]>> = {
        tasks: ['main_quest', 'side_quest'],
        events: ['limited_event', 'permanent_event'],
        cycles: ['weekly', 'endgame'],
        exploration: ['exploration']
      }
      const categories = targetCategories[target]
      const normalizedItems = normalizeSyncItems(result.items).filter(
        (item) => !categories || categories.includes(item.category)
      )
      const merge = this.database.mergeSyncedItems(
        gameId,
        checklistSource,
        normalizedItems
      )
      const review = this.database.queueSemanticReviewCandidates(
        gameId,
        checklistSource,
        result.reviewCandidates ?? []
      )
      const changes = merge.added + merge.updated
      const changeMessage = changes > 0
        ? `新增 ${merge.added}，更新 ${merge.updated}`
        : '无清单变更'
      const preservedMessage = merge.preserved > 0 ? `，保护 ${merge.preserved}` : ''
      const reviewMessage = review.pending > 0
        ? `；${review.pending} 项待 Codex 核验`
        : ''
      reportProgress({
        phase: 'completed',
        status: review.pending > 0 ? 'waiting' : 'completed',
        message: review.pending > 0
          ? `${review.pending} 项数据等待 Codex 语义核验`
          : '同步完成',
        current: 1,
        total: 1
      })
      return {
        source,
        status: 'success',
        message: `${result.message}（${changeMessage}${preservedMessage}）${reviewMessage}`,
        pendingReview: review.pending,
        ...merge
      }
    } catch (error) {
      const verificationRequired = error instanceof SyncVerificationRequiredError
      this.emitProgress(gameId, target, source, {
        phase: verificationRequired ? 'verification' : 'failed',
        status: verificationRequired ? 'verification_required' : 'error',
        message: error instanceof Error ? error.message : '同步来源发生未知错误',
        current: null,
        total: null
      })
      return {
        source,
        status: verificationRequired ? 'verification_required' : 'error',
        message: error instanceof Error ? error.message : '同步来源发生未知错误',
        added: 0,
        updated: 0,
        preserved: 0
      }
    }
  }

  private emitProgress(
    gameId: GameId,
    target: SyncTarget,
    source: SyncSourceResult['source'],
    progress: SyncAdapterProgress
  ): void {
    this.onProgress?.({
      gameId,
      target,
      source,
      phase: progress.phase,
      status: progress.status ?? 'running',
      message: progress.message,
      current: progress.current ?? null,
      total: progress.total ?? null,
      updatedAt: new Date().toISOString()
    })
  }
}
