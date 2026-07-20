import type { GameId } from '../../shared/contracts'

export interface PublicScheduleHttpOptions {
  urls: Partial<Record<GameId, string>>
  allowedHosts: readonly string[]
  fetcher?: typeof fetch
  timeoutMs?: number
  maximumBytes?: number
}

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAXIMUM_BYTES = 1024 * 1024

function validateSourceUrl(value: string, allowedHosts: ReadonlySet<string>): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('公开排期地址格式不正确')
  }
  if (url.protocol !== 'https:') throw new Error('公开排期自动同步只允许 HTTPS 地址')
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`公开排期来源域名不在白名单：${url.hostname}`)
  }
  return url
}

export function createPublicScheduleHttpLoader(options: PublicScheduleHttpOptions) {
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('公开排期超时时间不正确')
  if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error('公开排期响应大小上限不正确')
  }
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.trim().toLowerCase()))
  if (allowedHosts.size === 0 || allowedHosts.has('')) throw new Error('公开排期域名白名单不能为空')

  return async (gameId: GameId): Promise<unknown> => {
    const configuredUrl = options.urls[gameId]
    if (!configuredUrl) throw new Error('该游戏尚未配置公开排期来源')
    const url = validateSourceUrl(configuredUrl, allowedHosts)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetcher(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: { accept: 'application/json' }
      })
      if (!response.ok) throw new Error(`公开排期请求失败：HTTP ${response.status}`)
      if (response.url) validateSourceUrl(response.url, allowedHosts)

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.includes('application/json') && !contentType.includes('+json')) {
        throw new Error('公开排期响应不是 JSON')
      }
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error('公开排期响应超过大小限制')
      }

      const bytes = await response.arrayBuffer()
      if (bytes.byteLength > maximumBytes) throw new Error('公开排期响应超过大小限制')
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
      } catch {
        throw new Error('公开排期 JSON 解析失败')
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`公开排期请求超时（${timeoutMs}ms）`)
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
