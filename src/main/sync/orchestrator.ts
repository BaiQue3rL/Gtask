import type {
  ChecklistCategory,
  GameId,
  SyncResult,
  SyncProgressUpdate,
  SyncScope,
  SyncTarget,
  SyncSourceResult,
  SyncStatus
  , SyncRequestContext
} from '../../shared/contracts'
import type { AppDatabase } from '../database'
import {
  isSyncCancelledError,
  SyncCancelledError,
  SyncVerificationRequiredError,
  throwIfSyncCancelled,
  type SemanticReviewDraft,
  type SyncAdapter,
  type SyncAdapterProgress,
  type SyncAdapterRegistry
} from './types'
import { normalizeSyncItems } from './normalization'
import { filterRelevantSemanticReviewDrafts } from './personal-review-filter'

const PERSONAL_PLATFORM_NAMES: Record<GameId, string> = {
  genshin: '米游社',
  'star-rail': '米游社',
  zenless: '米游社',
  'wuthering-waves': '库街区'
}

export class SyncOrchestrator {
  private readonly inFlight = new Map<string, { scope: SyncScope; operation: Promise<SyncResult> }>()
  private readonly personalInFlight = new Map<
    string,
    { controller: AbortController; operation: Promise<SyncSourceResult> }
  >()
  private shuttingDown = false

  constructor(
    private readonly database: AppDatabase,
    private readonly adapters: SyncAdapterRegistry = { publicSchedule: {}, personalData: {} },
    private readonly onProgress?: (progress: SyncProgressUpdate) => void,
    private readonly preparePersonalCatalog?: (
      gameId: GameId,
      target: SyncTarget
    ) => void | Promise<void>
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

  async syncPersonalOnly(
    gameId: GameId,
    target: SyncTarget = 'all',
    requestContext: SyncRequestContext = {
      outputLocale: 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    }
  ): Promise<SyncResult> {
    const startedAt = new Date().toISOString()
    this.database.recordPersonalSyncAttempt(gameId)
    this.database.recordSyncTargetAttempt(gameId, target)
    const personal = await this.syncPersonalData(gameId, target, requestContext)
    if (this.shuttingDown) {
      return {
        gameId,
        requestedScope: 'personal_data',
        requestedTarget: target,
        status: 'cancelled',
        startedAt,
        finishedAt: new Date().toISOString(),
        sources: [personal],
        message: '应用已退出，任务已取消'
      }
    }
    const hasPendingReview = (personal.pendingReview ?? 0) > 0
    const status: SyncResult['status'] = personal.status === 'cancelled'
      ? 'cancelled'
      : personal.status === 'success'
      ? hasPendingReview ? 'partial' : 'success'
      : 'error'
    const databaseStatus: SyncStatus = personal.status === 'verification_required'
      ? 'verification_required'
      : personal.status === 'cancelled'
        ? 'stale'
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
    } else {
      this.database.recordSyncTargetAttempt(
        gameId,
        target,
        personal.status === 'verification_required'
          ? 'verification_required'
          : personal.status === 'cancelled'
            ? 'stale'
          : hasPendingReview
            ? 'stale'
            : 'error'
      )
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

  syncPersonalData(
    gameId: GameId,
    target: SyncTarget = 'all',
    requestContext: SyncRequestContext = {
      outputLocale: 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    }
  ): Promise<SyncSourceResult> {
    const key = `${gameId}:${target}:${requestContext.outputLocale}:${requestContext.userTimeZone}`
    const existing = this.personalInFlight.get(key)
    if (existing) return existing.operation
    const controller = new AbortController()
    const operation = this.runAdapter(
      gameId,
      'personal_data',
      this.adapters.personalData[gameId],
      `${PERSONAL_PLATFORM_NAMES[gameId]}个人数据适配器尚未接入`,
      target,
      requestContext,
      controller.signal
    ).finally(() => {
      this.personalInFlight.delete(key)
    })
    this.personalInFlight.set(key, { controller, operation })
    return operation
  }

  cancelPersonalSync(gameId: GameId, target: SyncTarget): boolean {
    let cancelled = false
    const prefix = `${gameId}:${target}:`
    for (const [key, active] of this.personalInFlight) {
      if (!key.startsWith(prefix)) continue
      active.controller.abort(new SyncCancelledError())
      cancelled = true
    }
    return cancelled
  }

  cancelAllPersonalSync(): number {
    let cancelled = 0
    for (const active of this.personalInFlight.values()) {
      if (active.controller.signal.aborted) continue
      active.controller.abort(new SyncCancelledError())
      cancelled += 1
    }
    return cancelled
  }

  shutdown(): number {
    this.shuttingDown = true
    return this.cancelAllPersonalSync()
  }

  private async runAdapter(
    gameId: GameId,
    source: SyncSourceResult['source'],
    adapter: SyncAdapter | undefined,
    unavailableMessage: string,
    target: SyncTarget = 'all',
    requestContext: SyncRequestContext = {
      outputLocale: 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    },
    signal?: AbortSignal
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
      throwIfSyncCancelled(signal)
      const result = await adapter.sync(gameId, target, reportProgress, signal)
      throwIfSyncCancelled(signal)
      if (source === 'personal_data') {
        await this.preparePersonalCatalog?.(gameId, target)
        throwIfSyncCancelled(signal)
      }
      reportProgress({
        phase: 'structuring',
        message: '数据读取完成，正在整理可写入内容',
        current: null,
        total: null
      })
      const checklistSource = source === 'public_schedule' ? 'public_schedule' : 'personal_sync'
      const targetCategories: Partial<Record<SyncTarget, ChecklistCategory[]>> = {
        tasks: ['main_quest', 'side_quest'],
        events: ['limited_event'],
        cycles: ['weekly', 'endgame'],
        exploration: ['exploration']
      }
      const categories = targetCategories[target]
      const normalizedItems = normalizeSyncItems(result.items).filter(
        (item) => !categories || categories.includes(item.category)
      )
      const personalTargetByCategory: Partial<Record<ChecklistCategory, Exclude<SyncTarget, 'all' | 'tasks'>>> = {
        limited_event: 'events',
        weekly: 'cycles',
        endgame: 'cycles',
        exploration: 'exploration'
      }
      const explicitReviewTargets = new Set(
        (result.reviewCandidates ?? []).map((candidate) => candidate.target)
      )
      const directlyMergeableItems = source === 'personal_data'
        ? normalizedItems.filter((item) => {
            // Personal map payloads are observations, not catalog definitions.
            // Their progress is applied through a source binding below.
            if (item.category === 'exploration') return false
            const itemTarget = personalTargetByCategory[item.category]
            return !itemTarget || this.database.isCatalogComplete(gameId, itemTarget)
          })
        : normalizedItems
      const deferredPersonalItems = source === 'personal_data'
        ? normalizedItems.filter((item) => {
            if (directlyMergeableItems.includes(item)) return false
            const itemTarget = personalTargetByCategory[item.category]
            return Boolean(itemTarget && !explicitReviewTargets.has(itemTarget))
          })
        : []
      throwIfSyncCancelled(signal)
      reportProgress({
        phase: 'merging',
        message: '内容整理完成，正在安全合并清单',
        current: 1,
        total: 1
      })
      const merge = this.database.mergeSyncedItems(
        gameId,
        checklistSource,
        directlyMergeableItems
      )
      let reviewCandidates = [
        ...(result.reviewCandidates ?? []),
        ...deferredPersonalItems.flatMap((item): SemanticReviewDraft[] => {
          const itemTarget = personalTargetByCategory[item.category]
          return itemTarget
            ? [{
                target: itemTarget,
                kind: 'normalized-personal-item',
                payload: { normalizedItem: item }
              }]
            : []
          })
      ]
      reviewCandidates = filterRelevantSemanticReviewDrafts(reviewCandidates)
      if (
        source === 'personal_data' &&
        result.accountScope &&
        reviewCandidates.length > 0
      ) {
        const resolution = this.database.resolveKnownPersonalDrafts(
          gameId,
          result.accountScope,
          reviewCandidates
        )
        reviewCandidates = resolution.reviewCandidates
        merge.added += resolution.added
        merge.updated += resolution.applied
        merge.preserved += resolution.preserved
      }
      throwIfSyncCancelled(signal)
      const review = this.database.queueSemanticReviewCandidates(
        gameId,
        checklistSource,
        reviewCandidates,
        new Date(),
        requestContext,
        source === 'personal_data' ? result.accountScope ?? null : null
      )
      const changes = merge.added + merge.updated
      if (source === 'personal_data' && (changes > 0 || review.pending > 0)) {
        this.database.recordCatalogCoverage(gameId, target, 'personal_data', 'partial')
      } else if (source === 'public_schedule') {
        this.database.recordCatalogCoverage(gameId, target, 'public_schedule', 'complete')
      }
      const changeMessage = changes > 0
        ? `新增 ${merge.added}，更新 ${merge.updated}`
        : '无清单变更'
      const preservedMessage = merge.preserved > 0 ? `，保护 ${merge.preserved}` : ''
      const reviewMessage = review.pending > 0
        ? `；${review.pending} 条状态正在由 Codex 核验，核验前保留原清单`
        : ''
      reportProgress({
        phase: review.pending > 0 ? 'verifying' : 'completed',
        status: review.pending > 0 ? 'running' : 'completed',
        message: review.pending > 0
          ? `个人数据已读取，Codex 正在核验 ${review.pending} 条状态`
          : '同步完成',
        current: review.pending > 0 ? 0 : 1,
        total: review.pending > 0 ? review.pending : 1
      })
      return {
        source,
        status: 'success',
        message: `${result.message}（${changeMessage}${preservedMessage}）${reviewMessage}`,
        pendingReview: review.pending,
        ...merge
      }
    } catch (error) {
      const cancelled = isSyncCancelledError(error) || signal?.aborted === true
      if (cancelled) {
        this.emitProgress(gameId, target, source, {
          phase: 'cancelled',
          status: 'cancelled',
          message: '已取消',
          current: null,
          total: null
        })
        return {
          source,
          status: 'cancelled',
          message: '已取消',
          added: 0,
          updated: 0,
          preserved: 0
        }
      }
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
