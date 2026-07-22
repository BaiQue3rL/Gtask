import type { GameId } from '../../shared/contracts'
import { parseExternalUrl, parseGameId } from '../validation'
import { normalizeSyncItem } from './normalization'
import type { NormalizedSyncItem, SyncAdapter, SyncAdapterOutput } from './types'

export interface ParsedPublicScheduleDocument {
  gameId: GameId
  sourceUrl: string
  fetchedAt: string
  items: NormalizedSyncItem[]
}

export interface PublicScheduleDocumentAdapterOptions {
  now?: () => Date
  maximumAgeMs?: number
  maximumFutureSkewMs?: number
}

const DEFAULT_MAXIMUM_AGE_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAXIMUM_FUTURE_SKEW_MS = 5 * 60 * 1000
const MAXIMUM_DOCUMENT_ITEMS = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parsePublicScheduleDocument(
  value: unknown,
  expectedGameId: GameId
): ParsedPublicScheduleDocument {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new Error('公开排期文档版本不受支持')
  const gameId = parseGameId(value.gameId)
  if (gameId !== expectedGameId) throw new Error('公开排期文档与请求游戏不匹配')
  const sourceUrl = parseExternalUrl(value.sourceUrl)
  if (typeof value.fetchedAt !== 'string' || Number.isNaN(Date.parse(value.fetchedAt))) {
    throw new Error('公开排期抓取时间格式不正确')
  }
  if (!Array.isArray(value.items)) throw new Error('公开排期事项列表格式不正确')
  if (value.items.length > MAXIMUM_DOCUMENT_ITEMS) {
    throw new Error(`公开排期事项不能超过 ${MAXIMUM_DOCUMENT_ITEMS} 条`)
  }

  const items: NormalizedSyncItem[] = value.items.map((candidate): NormalizedSyncItem => {
    if (!isRecord(candidate)) throw new Error('公开排期事项格式不正确')
    const normalized = normalizeSyncItem({
      ...candidate,
      sourceUrl,
      completed: undefined,
      progressPercent: undefined
    })
    if (!/\p{Script=Han}/u.test(normalized.title)) {
      throw new Error('公开排期名称必须使用经中文来源核对的中文正式名称')
    }
    if (!['limited_event', 'endgame', 'exploration'].includes(normalized.category)) {
      throw new Error('公开资料同步只允许限时活动、周期挑战和地图区域')
    }
    return {
      ...normalized,
      scheduleKind: normalized.category === 'limited_event'
        ? 'fixed_window'
        : normalized.category === 'endgame'
          ? 'remote_schedule'
          : null
    }
  })

  return {
    gameId,
    sourceUrl,
    fetchedAt: new Date(value.fetchedAt).toISOString(),
    items
  }
}

export class PublicScheduleDocumentAdapter implements SyncAdapter {
  private readonly now: () => Date
  private readonly maximumAgeMs: number
  private readonly maximumFutureSkewMs: number

  constructor(
    private readonly loadDocument: (gameId: GameId) => Promise<unknown>,
    options: PublicScheduleDocumentAdapterOptions = {}
  ) {
    this.now = options.now ?? (() => new Date())
    this.maximumAgeMs = options.maximumAgeMs ?? DEFAULT_MAXIMUM_AGE_MS
    this.maximumFutureSkewMs = options.maximumFutureSkewMs ?? DEFAULT_MAXIMUM_FUTURE_SKEW_MS
    if (!Number.isFinite(this.maximumAgeMs) || this.maximumAgeMs <= 0) {
      throw new Error('公开排期文档有效期配置不正确')
    }
    if (!Number.isFinite(this.maximumFutureSkewMs) || this.maximumFutureSkewMs < 0) {
      throw new Error('公开排期未来时间容差配置不正确')
    }
  }

  async sync(gameId: GameId): Promise<SyncAdapterOutput> {
    const document = parsePublicScheduleDocument(await this.loadDocument(gameId), gameId)
    const ageMs = this.now().getTime() - Date.parse(document.fetchedAt)
    if (ageMs > this.maximumAgeMs) throw new Error('公开排期文档已过期')
    if (ageMs < -this.maximumFutureSkewMs) throw new Error('公开排期抓取时间异常地来自未来')
    return {
      items: document.items,
      message: `公开排期已同步，来源抓取于 ${document.fetchedAt}`
    }
  }
}
