import type {
  ChecklistCategory,
  GameId,
  SyncResult,
  SyncScope,
  SyncTarget,
  SyncSourceResult,
  SyncStatus
} from '../../shared/contracts'
import type { AppDatabase } from '../database'
import { SyncVerificationRequiredError, type SyncAdapter, type SyncAdapterRegistry } from './types'
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
    private readonly adapters: SyncAdapterRegistry = { publicSchedule: {}, personalData: {} }
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
        '公开排期适配器尚未接入',
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
    const status: SyncResult['status'] =
      successCount === sources.length ? 'success' : successCount > 0 ? 'partial' : 'error'
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

  async runStartupSync(): Promise<SyncResult[]> {
    const results: SyncResult[] = []
    for (const settings of this.database.listAutomaticSyncSettings()) {
      results.push(await this.syncGame(settings.gameId, settings.autoScope))
    }
    return results
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
      const result = await adapter.sync(gameId, target)
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
      const changes = merge.added + merge.updated
      const changeMessage = changes > 0
        ? `新增 ${merge.added}，更新 ${merge.updated}`
        : '无清单变更'
      const preservedMessage = merge.preserved > 0 ? `，保护 ${merge.preserved}` : ''
      return {
        source,
        status: 'success',
        message: `${result.message}（${changeMessage}${preservedMessage}）`,
        ...merge
      }
    } catch (error) {
      const verificationRequired = error instanceof SyncVerificationRequiredError
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
}
