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

  const items: NormalizedSyncItem[] = value.items.map((candidate): NormalizedSyncItem => {
    if (!isRecord(candidate)) throw new Error('公开排期事项格式不正确')
    const normalized = normalizeSyncItem({
      ...candidate,
      sourceUrl,
      completed: undefined,
      progressPercent: undefined
    })
    if (!['limited_event', 'endgame'].includes(normalized.category)) {
      throw new Error('公开排期只允许限时活动和周期挑战')
    }
    return {
      ...normalized,
      scheduleKind: normalized.category === 'limited_event' ? 'fixed_window' : 'remote_schedule'
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
  constructor(private readonly loadDocument: (gameId: GameId) => Promise<unknown>) {}

  async sync(gameId: GameId): Promise<SyncAdapterOutput> {
    const document = parsePublicScheduleDocument(await this.loadDocument(gameId), gameId)
    return {
      items: document.items,
      message: `公开排期已同步，来源抓取于 ${document.fetchedAt}`
    }
  }
}
