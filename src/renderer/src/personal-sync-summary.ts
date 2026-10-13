import { SUPPORTED_GAME_IDS, type PersonalProgressSummary, type SyncResult, type SyncTargetState } from '../../shared/contracts'

interface PersonalSyncReceipt {
  startedAt: string
  finishedAt: string
  progress: PersonalProgressSummary
}

export type PersonalSyncReceipts = Record<string, PersonalSyncReceipt>
const STORAGE_KEY = 'gtask.personal-sync-summaries.v1'
const FIELDS = ['complete', 'incomplete', 'unknown', 'notReturned', 'unmatched', 'manualProtected'] as const

export function readPersonalSyncReceipts(storage: Pick<Storage, 'getItem'>): PersonalSyncReceipts {
  try {
    const json = storage.getItem(STORAGE_KEY)
    if (!json || json.length > 16_384) return {}
    const value = JSON.parse(json)
    const receipts: PersonalSyncReceipts = {}
    for (const game of SUPPORTED_GAME_IDS) for (const target of ['events', 'cycles', 'exploration']) {
      const key = `${game}:${target}`
      const receipt = value?.[key]
      if (!receipt || typeof receipt.startedAt !== 'string' || typeof receipt.finishedAt !== 'string' ||
        !Number.isFinite(Date.parse(receipt.startedAt)) || !Number.isFinite(Date.parse(receipt.finishedAt)) ||
        Date.parse(receipt.startedAt) > Date.parse(receipt.finishedAt) ||
        !FIELDS.every(field => Number.isSafeInteger(receipt.progress?.[field]) && receipt.progress[field] >= 0)) continue
      receipts[key] = { startedAt: receipt.startedAt, finishedAt: receipt.finishedAt,
        progress: Object.fromEntries(FIELDS.map(field => [field, receipt.progress[field]])) as unknown as PersonalProgressSummary }
    }
    return receipts
  } catch { return {} }
}

export function recordPersonalSyncReceipt(current: PersonalSyncReceipts, result: SyncResult): PersonalSyncReceipts {
  const source = result.sources.find(source => source.source === 'personal_data' && source.status === 'success')
  if (!source?.progress || result.requestedTarget === 'all' || result.requestedTarget === 'tasks') return current
  return { ...current, [`${result.gameId}:${result.requestedTarget}`]: {
    startedAt: result.startedAt, finishedAt: result.finishedAt, progress: source.progress
  } }
}

export function writePersonalSyncReceipts(storage: Pick<Storage, 'setItem'>, receipts: PersonalSyncReceipts): void {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(receipts)) } catch { /* Display cache cannot fail a committed sync. */ }
}

export function personalSummaryForState(receipts: PersonalSyncReceipts, state: SyncTargetState | undefined): PersonalProgressSummary | undefined {
  if (!state?.lastSuccessAt || state.status !== 'success') return undefined
  const receipt = receipts[`${state.gameId}:${state.target}`]
  const success = Date.parse(state.lastSuccessAt)
  // Restores, another client or a newer sync invalidate this presentation cache.
  if (!receipt || !Number.isFinite(success) || success < Date.parse(receipt.startedAt) || success > Date.parse(receipt.finishedAt)) return undefined
  return receipt.progress
}

export function hasUnconfirmedProgress(progress: PersonalProgressSummary | undefined): boolean {
  return Boolean(progress && (progress.unknown > 0 || progress.notReturned > 0))
}

export function formatPersonalProgressSummary(progress: PersonalProgressSummary): string {
  return [
    `接口确认完成 ${progress.complete}，未完成 ${progress.incomplete}`,
    ...(progress.unknown ? [`无法判断 ${progress.unknown}（保留原状态）`] : []),
    ...(progress.notReturned ? [`接口未返回 ${progress.notReturned}（保留原状态）`] : []),
    ...(progress.unmatched ? [`未匹配 ${progress.unmatched}`] : []),
    ...(progress.manualProtected ? [`手动保护 ${progress.manualProtected}`] : [])
  ].join('；')
}
