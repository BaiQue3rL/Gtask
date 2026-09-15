import { readFileSync } from 'node:fs'
import { writeFileAtomically } from './atomic-file'
import { readBoundedJson, type BoundedResponse } from './bounded-response'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { activityTagsMeetQualityContract } from './activity-tags'
import type { SoftwareUpdateSource } from '../shared/contracts'
import { findCycleMode } from './sync/cycle-catalog'
import { deadlineReviewSchema, publishedScheduleSchema, scheduleArchiveSchema } from './published-schedules'

export const REMOTE_CATALOG_SCHEMA_VERSION = 1
export const DEFAULT_REMOTE_CATALOG_TIMEOUT_MS = 5_000
export const MAX_REMOTE_CATALOG_BYTES = 1_000_000
export const DEFAULT_GITEE_CATALOG_FEED_URL =
  'https://gitee.com/l3rui/Gtask/raw/main/updates/catalog.json'
export const DEFAULT_GITHUB_CATALOG_FEED_URL =
  'https://raw.githubusercontent.com/BaiQue3rL/Gtask/main/updates/catalog.json'

const timestampSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value),
  '时间必须是带时区的 ISO-8601 时间'
)
const httpsUrlSchema = z.string().url().refine(
  (value) => new URL(value).protocol === 'https:',
  '来源地址必须使用 HTTPS'
)
const stableKeySchema = z.string().trim().min(1).max(200)
const titleSchema = z.string().trim().min(1).max(120)

const commonItemFields = {
  remoteKey: stableKeySchema,
  title: titleSchema,
  startsAt: timestampSchema.optional(),
  endsAt: timestampSchema.optional(),
  sourceUrl: httpsUrlSchema
}

const eventItemSchema = z.object({
  ...commonItemFields,
  category: z.literal('limited_event'),
  startsAt: timestampSchema.nullable().optional(),
  endsAt: timestampSchema.nullable().optional(),
  deadlineReview: deadlineReviewSchema.optional(),
  activityTags: z.array(z.string().trim().min(1)).min(1).max(5),
  scheduleKind: z.literal('fixed_window').optional(),
  timeZone: z.string().trim().min(1).max(100).optional()
}).strict()

const cycleItemSchema = z.object({
  ...commonItemFields,
  category: z.literal('endgame'),
  startsAt: timestampSchema,
  endsAt: timestampSchema,
  modeKey: z.string().trim().min(1).max(120),
  periodKey: z.string().trim().min(1).max(160),
  scheduleKind: z.enum(['fixed_window', 'remote_schedule']).optional(),
  resetRule: z.string().trim().min(1).max(200).optional(),
  resetWeekday: z.number().int().min(0).max(6).optional(),
  timeZone: z.string().trim().min(1).max(100).optional()
}).strict()

const explorationItemSchema = z.object({
  ...commonItemFields,
  category: z.literal('exploration'),
  mapNodeKind: z.enum(['region', 'subregion']),
  parentRemoteKey: stableKeySchema.optional(),
  parentTitle: titleSchema.optional(),
  timeZone: z.string().trim().min(1).max(100).optional()
}).strict().superRefine((item, context) => {
  if (item.mapNodeKind === 'region' && item.parentRemoteKey) {
    context.addIssue({ code: 'custom', message: '一级地图不能指定父级' })
  }
  if (item.mapNodeKind === 'subregion' && !item.parentRemoteKey) {
    context.addIssue({ code: 'custom', message: '二级地图必须指定父级稳定键' })
  }
})

const remoteCatalogItemSchema = z.discriminatedUnion('category', [
  eventItemSchema,
  cycleItemSchema,
  explorationItemSchema
]).superRefine((item, context) => {
  if (Date.parse(item.startsAt ?? '') >= Date.parse(item.endsAt ?? '')) {
    context.addIssue({ code: 'custom', message: '事项开始时间必须早于结束时间' })
  }
  if (
    item.category === 'limited_event' &&
    !activityTagsMeetQualityContract(item.activityTags, 'zh-CN')
  ) {
    context.addIssue({ code: 'custom', message: '活动必须包含有效玩法标签' })
  }
})

const versionWindowSchema = z.object({
  periodKey: z.string().trim().min(1).max(160),
  startsAt: timestampSchema,
  endsAt: timestampSchema,
  timeZone: z.string().trim().min(1).max(100),
  sourceUrl: httpsUrlSchema,
  confidence: z.number().min(0).max(1)
}).strict().superRefine((window, context) => {
  if (Date.parse(window.startsAt) >= Date.parse(window.endsAt)) {
    context.addIssue({ code: 'custom', message: '版本开始时间必须早于结束时间' })
  }
})

const gameUpdateSchema = z.object({
  gameId: z.enum(['genshin', 'star-rail', 'zenless', 'wuthering-waves']),
  versionWindow: versionWindowSchema.optional(),
  upserts: z.array(remoteCatalogItemSchema).max(2_000).default([]),
  archives: z.array(stableKeySchema).max(2_000).default([]),
  scheduleUpdates: z.array(publishedScheduleSchema).max(200).optional(),
  scheduleArchives: z.array(scheduleArchiveSchema).max(200).optional()
}).strict().superRefine((game, context) => {
  const timeKeys = new Set<string>()
  for (const record of [...(game.scheduleUpdates ?? []), ...(game.scheduleArchives ?? [])]) {
    const identity = `${record.kind}:${record.key}`
    if (timeKeys.has(identity)) context.addIssue({ code: 'custom', message: `排期记录重复：${identity}` })
    timeKeys.add(identity)
  }
  for (const record of game.scheduleUpdates ?? []) {
    if ('effectiveFrom' in record) {
      const identity = `${record.kind}:${'modeKey' in record ? record.modeKey : ''}:${Date.parse(record.effectiveFrom)}`
      if (timeKeys.has(identity)) context.addIssue({ code: 'custom', message: '相同生效边界不能发布多个相互竞争的规则' })
      timeKeys.add(identity)
    }
    if ('remoteKey' in record) {
      const definition = findCycleMode(game.gameId, { ...record, title: 'title' in record ? record.title : '' })
      if (definition && (definition.remoteKey !== record.remoteKey || definition.modeKey !== record.modeKey)) {
        context.addIssue({ code: 'custom', message: '排期必须沿用模式的稳定身份' })
      }
    }
  }
  const windows = (game.scheduleUpdates ?? []).filter((record) => record.kind === 'cycle_window' || record.kind === 'version_window')
  for (let index = 0; index < windows.length; index++) {
    for (const other of windows.slice(index + 1)) {
      const window = windows[index]
      if (window.kind === other.kind && ('remoteKey' in window ? window.remoteKey : '') === ('remoteKey' in other ? other.remoteKey : '') &&
        Date.parse(window.startsAt) < Date.parse(other.endsAt) && Date.parse(other.startsAt) < Date.parse(window.endsAt)) {
        context.addIssue({ code: 'custom', message: '同一玩法或版本的例外窗口不能重叠' })
      }
    }
  }
  const seen = new Set<string>()
  const seenCycleModes = new Set<string>()
  for (const item of game.upserts) {
    if (seen.has(item.remoteKey)) {
      context.addIssue({ code: 'custom', message: `重复稳定键：${item.remoteKey}` })
    }
    seen.add(item.remoteKey)
    if (item.category === 'endgame') {
      if (seenCycleModes.has(item.modeKey)) {
        context.addIssue({ code: 'custom', message: `周期模式重复出现：${item.modeKey}` })
      }
      seenCycleModes.add(item.modeKey)
      const definition = findCycleMode(game.gameId, item)
      if (definition && item.remoteKey !== definition.remoteKey) {
        context.addIssue({
          code: 'custom',
          message: `周期模式 ${item.modeKey} 必须使用稳定键 ${definition.remoteKey}`
        })
      }
    }
  }
  for (const remoteKey of game.archives) {
    if (seen.has(remoteKey)) {
      context.addIssue({ code: 'custom', message: `同一稳定键不能同时更新和归档：${remoteKey}` })
    }
    seen.add(remoteKey)
  }
})

const remoteCatalogFeedSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  revision: z.string().trim().regex(/^[A-Za-z0-9._:-]{1,100}$/),
  publishedAt: timestampSchema,
  games: z.array(gameUpdateSchema).min(1).max(4)
}).strict().superRefine((feed, context) => {
  const gameIds = new Set<string>()
  for (const game of feed.games) {
    if (feed.schemaVersion === 1 && (game.scheduleUpdates || game.scheduleArchives)) {
      context.addIssue({ code: 'custom', message: '排期规则和例外需要清单协议 v2' })
    }
    for (const item of game.upserts) {
      if (item.category !== 'limited_event') continue
      if (item.deadlineReview) {
        if (feed.schemaVersion !== 2 || item.endsAt || (item.startsAt && Date.parse(item.startsAt) > Date.parse(item.deadlineReview.checkedAt)) ||
          Date.parse(item.deadlineReview.checkedAt) > Date.parse(feed.publishedAt)) {
          context.addIssue({ code: 'custom', message: '缺截止时间例外必须使用 v2，并提供限时、当前开放和已完成核查证据' })
        }
      } else if (!item.startsAt || !item.endsAt) {
        context.addIssue({ code: 'custom', message: '限时活动必须提供完整时间或经核验的缺截止时间例外' })
      }
    }
    if (gameIds.has(game.gameId)) {
      context.addIssue({ code: 'custom', message: `游戏重复出现：${game.gameId}` })
    }
    gameIds.add(game.gameId)
  }
})

export type RemoteCatalogFeed = z.infer<typeof remoteCatalogFeedSchema>
export type RemoteCatalogGameUpdate = RemoteCatalogFeed['games'][number]
export type RemoteCatalogItem = RemoteCatalogGameUpdate['upserts'][number]

export interface RemoteCatalogUpdateState {
  contentHash?: string | null
  revision: string | null
  publishedAt: string | null
  providerId: string | null
  lastAutomaticCheckAt: string | null
  lastSuccessfulManualCheckAt: string | null
}

export const EMPTY_REMOTE_CATALOG_UPDATE_STATE: RemoteCatalogUpdateState = {
  revision: null,
  publishedAt: null,
  providerId: null,
  lastAutomaticCheckAt: null,
  lastSuccessfulManualCheckAt: null
}

export function parseRemoteCatalogFeed(value: unknown): RemoteCatalogFeed {
  return remoteCatalogFeedSchema.parse(value)
}

export function readRemoteCatalogUpdateState(filePath: string): RemoteCatalogUpdateState {
  try {
    const value = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    return {
      revision: typeof value.revision === 'string' ? value.revision : null,
      ...(typeof value.contentHash === 'string' ? { contentHash: value.contentHash } : {}),
      publishedAt: typeof value.publishedAt === 'string' && Number.isFinite(Date.parse(value.publishedAt))
        ? new Date(value.publishedAt).toISOString()
        : null,
      providerId: typeof value.providerId === 'string' ? value.providerId : null,
      lastAutomaticCheckAt: typeof value.lastAutomaticCheckAt === 'string'
        && Number.isFinite(Date.parse(value.lastAutomaticCheckAt))
        ? new Date(value.lastAutomaticCheckAt).toISOString()
        : null,
      lastSuccessfulManualCheckAt: typeof value.lastSuccessfulManualCheckAt === 'string'
        && Number.isFinite(Date.parse(value.lastSuccessfulManualCheckAt))
        ? new Date(value.lastSuccessfulManualCheckAt).toISOString()
        : null
    }
  } catch {
    return { ...EMPTY_REMOTE_CATALOG_UPDATE_STATE }
  }
}

export function writeRemoteCatalogUpdateState(
  filePath: string,
  state: RemoteCatalogUpdateState
): RemoteCatalogUpdateState {
  const normalized: RemoteCatalogUpdateState = {
    ...(state.contentHash ? { contentHash: state.contentHash } : {}),
    revision: state.revision?.trim() || null,
    publishedAt: state.publishedAt && Number.isFinite(Date.parse(state.publishedAt))
      ? new Date(state.publishedAt).toISOString()
      : null,
    providerId: state.providerId?.trim() || null,
    lastAutomaticCheckAt: state.lastAutomaticCheckAt
      && Number.isFinite(Date.parse(state.lastAutomaticCheckAt))
      ? new Date(state.lastAutomaticCheckAt).toISOString()
      : null,
    lastSuccessfulManualCheckAt: state.lastSuccessfulManualCheckAt
      && Number.isFinite(Date.parse(state.lastSuccessfulManualCheckAt))
      ? new Date(state.lastSuccessfulManualCheckAt).toISOString()
      : null
  }
  writeFileAtomically(filePath, `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}

type CatalogFetchLike = (
  input: string | Request,
  init?: RequestInit
) => Promise<BoundedResponse>

export interface RemoteCatalogProvider {
  readonly id: string
  readonly configured: boolean
  load(signal: AbortSignal): Promise<RemoteCatalogFeed>
}

export class JsonRemoteCatalogProvider implements RemoteCatalogProvider {
  readonly configured: boolean

  constructor(
    readonly id: string,
    private readonly endpoint: string,
    private readonly fetcher: CatalogFetchLike = globalThis.fetch
  ) {
    this.configured = endpoint.trim().length > 0
  }

  async load(signal: AbortSignal): Promise<RemoteCatalogFeed> {
    if (!this.configured) throw new Error('远程清单源未配置')
    const endpoint = new URL(this.endpoint)
    if (endpoint.protocol !== 'https:') throw new Error('远程清单源必须使用 HTTPS')
    const response = await this.fetcher(endpoint.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    })
    if (!response.ok) throw new Error(`远程清单源返回 HTTP ${response.status}`)
    return parseRemoteCatalogFeed(await readBoundedJson(response, MAX_REMOTE_CATALOG_BYTES, signal))
  }
}

export interface DefaultRemoteCatalogProviderOptions {
  feedOverride?: string
  mirrorFeedOverride?: string
  source?: SoftwareUpdateSource
  fetcher?: CatalogFetchLike
}

export function createDefaultRemoteCatalogProviders(
  options: DefaultRemoteCatalogProviderOptions = {}
): RemoteCatalogProvider[] {
  const fetcher = options.fetcher ?? globalThis.fetch
  const override = new JsonRemoteCatalogProvider(
    'override',
    options.feedOverride?.trim() ?? '',
    fetcher
  )
  const gitee = new JsonRemoteCatalogProvider(
    'gitee',
    options.mirrorFeedOverride?.trim() || DEFAULT_GITEE_CATALOG_FEED_URL,
    fetcher
  )
  const github = new JsonRemoteCatalogProvider(
    'github',
    DEFAULT_GITHUB_CATALOG_FEED_URL,
    fetcher
  )
  if (options.source === 'gitee') return [override, gitee]
  if (options.source === 'github') return [override, github]
  return [override, gitee, github]
}

export interface RemoteCatalogCheckResult {
  feed: RemoteCatalogFeed
  providerId: string
  checkedAt: string
}

export class RemoteCatalogUpdateService {
  constructor(
    private readonly providers: RemoteCatalogProvider[],
    private readonly timeoutMs = DEFAULT_REMOTE_CATALOG_TIMEOUT_MS
  ) {}

  async check(
    state: RemoteCatalogUpdateState = EMPTY_REMOTE_CATALOG_UPDATE_STATE,
    reference = new Date()
  ): Promise<RemoteCatalogCheckResult | null> {
    const candidates = await Promise.all(
      this.providers.filter((provider) => provider.configured).map(async (provider) => {
        const controller = new AbortController()
        let timeout: ReturnType<typeof setTimeout> | null = null
        try {
          const feed = await Promise.race([
            provider.load(controller.signal),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                controller.abort()
                reject(new Error('远程清单检查超时'))
              }, this.timeoutMs)
            })
          ])
          if (Date.parse(feed.publishedAt) > reference.getTime() + 24 * 60 * 60 * 1000) {
            throw new Error('远程清单发布时间异常')
          }
          return { feed, providerId: provider.id }
        } catch {
          return null
        } finally {
          if (timeout) clearTimeout(timeout)
        }
      })
    )
    const valid = candidates.filter((candidate): candidate is NonNullable<typeof candidate> =>
      candidate !== null
    )
    if (valid.length === 0) throw new Error('暂时连不上活动和任务更新服务')
    valid.sort((left, right) => Date.parse(right.feed.publishedAt) - Date.parse(left.feed.publishedAt))
    const github = valid.find((candidate) => candidate.providerId === 'github')
    const mirrorConflict = github && valid.some((candidate) =>
      candidate.providerId !== 'override' && JSON.stringify(candidate.feed) !== JSON.stringify(github.feed)
    )
    // GitHub is the authority. Gitee is preferred only when it mirrors the
    // same revision or GitHub is unreachable; a divergent mirror must never
    // supersede the authoritative feed merely by claiming a later timestamp.
    const selected = mirrorConflict ? github : valid[0]
    if (
      state.publishedAt &&
      Date.parse(selected.feed.publishedAt) < Date.parse(state.publishedAt)
    ) {
      return null
    }
    if (
      state.revision === selected.feed.revision &&
      state.publishedAt === new Date(selected.feed.publishedAt).toISOString() &&
      (!state.contentHash || state.contentHash === createHash('sha256')
        .update(JSON.stringify(selected.feed)).digest('hex'))
    ) {
      return null
    }
    return {
      ...selected,
      checkedAt: reference.toISOString()
    }
  }
}
