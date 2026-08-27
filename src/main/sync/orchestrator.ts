import type {
  GameId,
  PersonalSyncTarget,
  SyncResult,
  SyncProgressUpdate,
  SyncSourceResult,
  SyncStatus,
  SyncRequestContext
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
import { completeCycleCatalog } from './cycle-catalog'

const PERSONAL_PLATFORM_NAMES: Record<GameId, string> = {
  genshin: '米游社',
  'star-rail': '米游社',
  zenless: '米游社',
  'wuthering-waves': '库街区'
}

export class SyncOrchestrator {
  private readonly personalInFlight = new Map<
    string,
    { controller: AbortController; operation: Promise<SyncSourceResult> }
  >()
  private shuttingDown = false

  constructor(
    private readonly database: AppDatabase,
    private readonly adapters: SyncAdapterRegistry = { publicSchedule: {}, personalData: {} },
    private readonly onProgress?: (progress: SyncProgressUpdate) => void
  ) {}

  async syncPersonalOnly(
    gameId: GameId,
    target: PersonalSyncTarget,
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
    const status: SyncResult['status'] = personal.status === 'cancelled'
      ? 'cancelled'
      : personal.status === 'success'
      ? 'success'
      : 'error'
    const databaseStatus: SyncStatus = personal.status === 'verification_required'
      ? 'verification_required'
      : personal.status === 'cancelled'
        ? 'stale'
        : personal.status === 'success'
        ? 'success'
        : 'error'
    this.database.recordSyncOutcome(
      gameId,
      databaseStatus,
      personal.message,
      personal.status === 'success' && (personal.added + personal.updated) > 0
    )
    if (personal.status === 'success') {
      this.database.recordSyncTargetSuccess(gameId, target)
    } else {
      this.database.recordSyncTargetAttempt(
        gameId,
        target,
        personal.status === 'verification_required'
          ? 'verification_required'
          : personal.status === 'cancelled'
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
    target: PersonalSyncTarget,
    requestContext: SyncRequestContext = {
      outputLocale: 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    }
  ): Promise<SyncSourceResult> {
    const key = `${gameId}:${target}:${requestContext.outputLocale}:${requestContext.userTimeZone}`
    const existing = this.personalInFlight.get(key)
    if (existing) return existing.operation
    const controller = new AbortController()
    const operation = this.runPersonalAdapter(
      gameId,
      this.adapters.personalData[gameId],
      `暂时还不能同步${PERSONAL_PLATFORM_NAMES[gameId]}进度`,
      target,
      requestContext,
      controller.signal
    ).finally(() => {
      this.personalInFlight.delete(key)
    })
    this.personalInFlight.set(key, { controller, operation })
    return operation
  }

  isPersonalSyncActive(gameId: GameId, target?: PersonalSyncTarget): boolean {
    const prefix = target ? `${gameId}:${target}:` : `${gameId}:`
    return [...this.personalInFlight.keys()].some((key) => key.startsWith(prefix))
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

  private async runPersonalAdapter(
    gameId: GameId,
    adapter: SyncAdapter | undefined,
    unavailableMessage: string,
    target: PersonalSyncTarget,
    requestContext: SyncRequestContext = {
      outputLocale: 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    },
    signal?: AbortSignal
  ): Promise<SyncSourceResult> {
    if (!adapter) {
      return {
        source: 'personal_data',
        status: 'error',
        message: unavailableMessage,
        added: 0,
        updated: 0,
        preserved: 0
      }
    }

    try {
      const reportProgress = (progress: SyncAdapterProgress): void => {
        this.emitProgress(gameId, target, progress)
      }
      reportProgress({
        phase: 'fetching',
        message: '正在连接个人进度服务',
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
        events: ['limited_event'],
        cycles: ['endgame'],
        exploration: ['exploration']
      } as const
      const categories = targetCategories[target]
      let normalizedItems = normalizeSyncItems(result.items).filter(
        (item) => (categories as readonly string[]).includes(item.category)
      )
      if (target === 'cycles') {
        normalizedItems = completeCycleCatalog(
          gameId,
          normalizedItems,
          this.database.listChecklistItems(gameId),
          'personal_sync',
          new Date(),
          this.database.getRelevantGameVersionWindow(gameId)
        )
      }
      throwIfSyncCancelled(signal)
      reportProgress({
        phase: 'merging',
        message: '内容整理完成，正在更新个人进度',
        current: 1,
        total: 1
      })
      const merge = { added: 0, updated: 0, preserved: 0, expiredRemoved: 0 }
      if (result.snapshotCompleteness === 'partial') {
        throw new Error('个人接口只返回了部分进度，已保留上次结果，请稍后重试')
      }
      if (!result.accountScope) throw new Error('个人进度缺少安全账号作用域，请重新登录')
      throwIfSyncCancelled(signal)
      const replaced = this.database.replacePersonalSnapshot(
        gameId,
        target,
        result.accountScope,
        normalizedItems,
        result.adapterVersion ?? 'personal-adapter-v1',
        new Date(),
        requestContext
      )
      this.database.replaceScheduleObservations(
        gameId,
        target,
        result.scheduleObservations ?? [],
        new Date()
      )
      merge.added += replaced.added
      merge.updated += replaced.updated
      merge.preserved += replaced.preserved
      merge.expiredRemoved += replaced.expiredRemoved ?? 0
      throwIfSyncCancelled(signal)
      const changes = merge.added + merge.updated
      const changeMessage = changes > 0
        ? `新增 ${merge.added}，更新 ${merge.updated}`
        : '无清单变更'
      const preservedMessage = merge.preserved > 0 ? `，保护 ${merge.preserved}` : ''
      const expiredMessage = (merge.expiredRemoved ?? 0) > 0
        ? `，淘汰到期 ${merge.expiredRemoved}`
        : ''
      reportProgress({
        phase: 'completed',
        status: 'completed',
        message: '同步完成',
        current: 1,
        total: 1
      })
      return {
        source: 'personal_data',
        status: 'success',
        message: `${result.message}（${changeMessage}${preservedMessage}${expiredMessage}）`,
        ...merge
      }
    } catch (error) {
      const cancelled = isSyncCancelledError(error) || signal?.aborted === true
      if (cancelled) {
        this.emitProgress(gameId, target, {
          phase: 'cancelled',
          status: 'cancelled',
          message: '已取消',
          current: null,
          total: null
        })
        return {
          source: 'personal_data',
          status: 'cancelled',
          message: '已取消',
          added: 0,
          updated: 0,
          preserved: 0
        }
      }
      const verificationRequired = error instanceof SyncVerificationRequiredError
      this.emitProgress(gameId, target, {
        phase: verificationRequired ? 'verification' : 'failed',
        status: verificationRequired ? 'verification_required' : 'error',
        message: error instanceof Error ? error.message : '同步来源发生未知错误',
        current: null,
        total: null
      })
      return {
        source: 'personal_data',
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
    target: PersonalSyncTarget,
    progress: SyncAdapterProgress
  ): void {
    this.onProgress?.({
      gameId,
      target,
      source: 'personal_data',
      phase: progress.phase,
      status: progress.status ?? 'running',
      retryKind: progress.phase === 'retrying' ? 'source_request' : null,
      // Adapter diagnostics are deliberately not transported to the product
      // UI. User-facing copy is derived from source/target/phase/count.
      message: '',
      current: progress.current ?? null,
      total: progress.total ?? null,
      updatedAt: new Date().toISOString()
    })
  }
}
