import type { SyncResult } from '../../shared/contracts'

interface PersonalCatalogBootstrapOptions {
  catalogComplete: boolean
  isCatalogComplete?: () => boolean
  syncPersonal: () => Promise<SyncResult>
  queueCatalog: () => Promise<SyncResult>
}

/**
 * Personal progress is the operation the user explicitly requested, so its
 * credentials must be checked before an optional public-catalog bootstrap can
 * create a Codex job.
 */
export async function syncPersonalBeforeCatalogBootstrap(
  options: PersonalCatalogBootstrapOptions
): Promise<SyncResult> {
  const personalResult = await options.syncPersonal()
  const personalSource = personalResult.sources.find(
    (source) => source.source === 'personal_data'
  )

  if (
    options.catalogComplete ||
    options.isCatalogComplete?.() === true ||
    personalResult.status === 'cancelled' ||
    personalSource?.status !== 'success'
  ) {
    return personalResult
  }

  const catalogResult = await options.queueCatalog()
  const sources = [...personalResult.sources, ...catalogResult.sources]
  const successfulSources = sources.filter((source) => source.status === 'success').length
  const hasPendingWork = sources.some(
    (source) => source.status === 'skipped' || (source.pendingReview ?? 0) > 0
  )
  const status: SyncResult['status'] =
    sources.some((source) => source.status === 'cancelled')
      ? 'cancelled'
      : successfulSources === sources.length && !hasPendingWork
        ? 'success'
        : successfulSources > 0
          ? 'partial'
          : 'error'

  return {
    gameId: personalResult.gameId,
    requestedScope: 'personal_data',
    requestedTarget: personalResult.requestedTarget,
    status,
    startedAt: personalResult.startedAt,
    finishedAt: catalogResult.finishedAt,
    sources,
    message: sources.map((source) => source.message).join('；')
  }
}
