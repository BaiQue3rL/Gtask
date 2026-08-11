import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  SoftwareUpdateCheckResult,
  SoftwareUpdateSettings,
  SoftwareUpdateSource
} from '../shared/contracts'

export const DEFAULT_SOFTWARE_UPDATE_SETTINGS: SoftwareUpdateSettings = {
  autoCheckEnabled: true,
  updateSource: 'auto',
  lastSuccessfulCheckAt: null
}

export const DEFAULT_UPDATE_CHECK_TIMEOUT_MS = 5_000
export const DEFAULT_GITEE_UPDATE_FEED_URL =
  'https://gitee.com/l3rui/Gtask/raw/main/updates/latest.json'
export const DEFAULT_GITHUB_UPDATE_FEED_URL =
  'https://raw.githubusercontent.com/BaiQue3rL/Gtask/main/updates/latest.json'

export interface AvailableSoftwareUpdate {
  version: string
  releaseUrl: string | null
}

export interface UpdateProvider {
  readonly id: string
  readonly configured: boolean
  check(signal: AbortSignal): Promise<AvailableSoftwareUpdate | null>
}

type FetchLike = (
  input: string | Request,
  init?: RequestInit
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>

export interface DefaultSoftwareUpdateProviderOptions {
  feedOverride?: string
  mirrorFeedOverride?: string
  source?: SoftwareUpdateSource
  fetcher?: FetchLike
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toISOString()
}

export function parseSoftwareUpdateSettings(value: unknown): SoftwareUpdateSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SOFTWARE_UPDATE_SETTINGS }
  const record = value as Record<string, unknown>
  return {
    autoCheckEnabled: typeof record.autoCheckEnabled === 'boolean'
      ? record.autoCheckEnabled
      : DEFAULT_SOFTWARE_UPDATE_SETTINGS.autoCheckEnabled,
    updateSource: record.updateSource === 'gitee' || record.updateSource === 'github'
      ? record.updateSource
      : DEFAULT_SOFTWARE_UPDATE_SETTINGS.updateSource,
    lastSuccessfulCheckAt: parseTimestamp(record.lastSuccessfulCheckAt)
  }
}

export function readSoftwareUpdateSettings(filePath: string): SoftwareUpdateSettings {
  try {
    return parseSoftwareUpdateSettings(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch {
    return { ...DEFAULT_SOFTWARE_UPDATE_SETTINGS }
  }
}

export function writeSoftwareUpdateSettings(
  filePath: string,
  settings: SoftwareUpdateSettings
): SoftwareUpdateSettings {
  const normalized = parseSoftwareUpdateSettings(settings)
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

function numericVersionParts(value: string): number[] | null {
  const normalized = value.trim().replace(/^v/i, '').split('-', 1)[0]
  if (!/^\d+(?:\.\d+)*$/.test(normalized)) return null
  return normalized.split('.').map(Number)
}

export function compareSoftwareVersions(left: string, right: string): number {
  const leftParts = numericVersionParts(left)
  const rightParts = numericVersionParts(right)
  if (!leftParts || !rightParts) throw new Error('更新版本号格式不正确')
  const length = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

function parseReleaseUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string') throw new Error('更新地址格式不正确')
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('更新地址必须使用 HTTPS')
  return url.toString()
}

function parseProviderReleaseUrl(
  payload: Record<string, unknown>,
  providerId: string
): string | null {
  const releaseUrls = payload.releaseUrls
  if (releaseUrls && typeof releaseUrls === 'object' && !Array.isArray(releaseUrls)) {
    const providerUrl = (releaseUrls as Record<string, unknown>)[providerId]
    if (providerUrl !== undefined) return parseReleaseUrl(providerUrl)
  }
  return parseReleaseUrl(payload.releaseUrl)
}

/**
 * Generic JSON feed provider. A future release source only needs to expose
 * `{ "version": "1.2.3", "releaseUrl": "https://..." }`. A mirrored
 * feed may additionally expose `releaseUrls` keyed by provider id so the
 * same JSON file can open the matching repository's release page.
 */
export class JsonFeedUpdateProvider implements UpdateProvider {
  readonly id: string
  readonly configured: boolean

  constructor(
    id: string,
    private readonly endpoint: string,
    private readonly fetcher: FetchLike = globalThis.fetch
  ) {
    this.id = id
    this.configured = endpoint.trim().length > 0
  }

  async check(signal: AbortSignal): Promise<AvailableSoftwareUpdate | null> {
    if (!this.configured) return null
    const endpoint = new URL(this.endpoint)
    if (endpoint.protocol !== 'https:') throw new Error('更新源必须使用 HTTPS')
    const response = await this.fetcher(endpoint.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal
    })
    if (!response.ok) throw new Error(`更新源返回 HTTP ${response.status}`)
    const payload = await response.json() as Record<string, unknown>
    if (typeof payload.version !== 'string' || !numericVersionParts(payload.version)) {
      throw new Error('更新源未返回有效版本号')
    }
    return {
      version: payload.version.trim().replace(/^v/i, ''),
      releaseUrl: parseProviderReleaseUrl(payload, this.id)
    }
  }
}

export function createDefaultSoftwareUpdateProviders(
  options: DefaultSoftwareUpdateProviderOptions = {}
): UpdateProvider[] {
  const fetcher = options.fetcher ?? globalThis.fetch
  const override = new JsonFeedUpdateProvider(
    'override',
    options.feedOverride?.trim() ?? '',
    fetcher
  )
  const gitee = new JsonFeedUpdateProvider(
    'gitee',
    options.mirrorFeedOverride?.trim() || DEFAULT_GITEE_UPDATE_FEED_URL,
    fetcher
  )
  const github = new JsonFeedUpdateProvider(
    'github',
    DEFAULT_GITHUB_UPDATE_FEED_URL,
    fetcher
  )

  if (options.source === 'gitee') return [override, gitee]
  if (options.source === 'github') return [override, github]
  return [override, gitee, github]
}

export class SoftwareUpdateService {
  constructor(
    private readonly currentVersion: string,
    private readonly providers: UpdateProvider[],
    private readonly timeoutMs = DEFAULT_UPDATE_CHECK_TIMEOUT_MS
  ) {}

  async check(reference = new Date()): Promise<SoftwareUpdateCheckResult> {
    const providers = this.providers.filter((candidate) => candidate.configured)
    if (providers.length === 0) {
      return {
        outcome: 'unavailable',
        currentVersion: this.currentVersion,
        latestVersion: null,
        releaseUrl: null,
        checkedAt: null,
        message: '当前版本暂未提供在线更新'
      }
    }

    for (const provider of providers) {
      const controller = new AbortController()
      let timeout: ReturnType<typeof setTimeout> | null = null
      try {
        const update = await Promise.race([
          provider.check(controller.signal),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              controller.abort()
              reject(new Error('更新检查超时'))
            }, this.timeoutMs)
          })
        ])
        const checkedAt = reference.toISOString()
        if (!update || compareSoftwareVersions(update.version, this.currentVersion) <= 0) {
          return {
            outcome: 'up_to_date',
            currentVersion: this.currentVersion,
            latestVersion: update?.version ?? this.currentVersion,
            releaseUrl: update?.releaseUrl ?? null,
            checkedAt,
            message: '当前已是最新版本'
          }
        }
        return {
          outcome: 'update_available',
          currentVersion: this.currentVersion,
          latestVersion: update.version,
          releaseUrl: update.releaseUrl,
          checkedAt,
          message: `发现新版本 ${update.version}`
        }
      } catch {
        // A repository mirror is best-effort. Try the next configured source.
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }

    return {
      outcome: 'error',
      currentVersion: this.currentVersion,
      latestVersion: null,
      releaseUrl: null,
      checkedAt: null,
      message: '暂时无法检查更新，请稍后重试'
    }
  }
}
