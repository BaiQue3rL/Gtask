import type {
  GameId,
  PersonalSyncTarget,
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
  type SyncAdapter,
  type SyncAdapterProgress,
  type SyncAdapterRegistry
} from './types'
import { normalizeSyncItems } from './normalization'
import { getPersonalSyncTargets } from './personal-sync-capabilities'

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
    // Kept temporarily for binary/source compatibility with older callers.
    // Personal snapshots no longer invoke public-catalog preparation.
    _obsoletePreparePersonalCatalog?: (gameId: GameId, target: SyncTarget) => void | Promise<void>
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
      reportProgress({
        phase: 'structuring',
        message: '数据读取完成，正在整理可写入内容',
        current: null,
        total: null
      })
      const targetCategories = {
        tasks: ['main_quest', 'side_quest'],
        events: ['limited_event'],
        cycles: ['weekly', 'endgame'],
        exploration: ['exploration']
      } as const
      const categories = target === 'all' ? undefined : targetCategories[target]
      const normalizedItems = normalizeSyncItems(result.items).filter(
        (item) => !categories || (categories as readonly string[]).includes(item.category)
      )
      throwIfSyncCancelled(signal)
      reportProgress({
        phase: 'merging',
        message: source === 'personal_data'
          ? '内容整理完成，正在切换为官方个人清单'
          : '内容整理完成，正在写入公开清单',
        current: 1,
        total: 1
      })
      const merge = { added: 0, updated: 0, preserved: 0 }
      if (source === 'personal_data') {
        if (result.snapshotCompleteness === 'partial') {
          throw new Error('个人接口只返回了部分数据，已保留上次个人清单，请稍后重试')
        }
        if (!result.accountScope) throw new Error('个人数据缺少安全账号作用域，请重新登录')
        if ((result.reviewCandidates?.length ?? 0) > 0) {
          throw new Error('个人数据适配器未能形成完整快照，已保留上次个人清单')
        }
        const personalTargets: PersonalSyncTarget[] = target === 'all'
          ? getPersonalSyncTargets(gameId)
          : target === 'events' || target === 'cycles' || target === 'exploration'
            ? [target]
            : []
        if (personalTargets.length === 0) throw new Error('当前版块不支持同步个人进度')
        const byTarget: Record<PersonalSyncTarget, typeof normalizedItems> = {
          events: normalizedItems.filter((item) => item.category === 'limited_event'),
          cycles: normalizedItems.filter((item) => item.category === 'endgame'),
          exploration: normalizedItems.filter((item) => item.category === 'exploration')
        }
        for (const personalTarget of personalTargets) {
          throwIfSyncCancelled(signal)
          const replaced = this.database.replacePersonalSnapshot(
            gameId,
            personalTarget,
            result.accountScope,
            byTarget[personalTarget],
            result.adapterVersion ?? 'legacy-personal-adapter-v1'
          )
          merge.added += replaced.added
          merge.updated += replaced.updated
          merge.preserved += replaced.preserved
        }
      } else {
        const merged = this.database.replacePublicCatalog(gameId, target, normalizedItems)
        merge.added += merged.added
        merge.updated += merged.updated
        merge.preserved += merged.preserved
        this.database.recordCatalogCoverage(gameId, target, 'public_schedule', 'complete')
      }
      throwIfSyncCancelled(signal)
      const changes = merge.added + merge.updated
      const changeMessage = changes > 0
        ? `新增 ${merge.added}，更新 ${merge.updated}`
        : '无清单变更'
      const preservedMessage = merge.preserved > 0 ? `，保护 ${merge.preserved}` : ''
      reportProgress({
        phase: 'completed',
        status: 'completed',
        message: '同步完成',
        current: 1,
        total: 1
      })
      return {
        source,
        status: 'success',
        message: `${result.message}（${changeMessage}${preservedMessage}）`,
        pendingReview: 0,
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
