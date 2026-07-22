import type { GameId } from '../../shared/contracts'

export interface PublicScheduleHttpOptions {
  urls: Partial<Record<GameId, string>>
  allowedHosts: readonly string[]
  fetcher?: typeof fetch
  timeoutMs?: number
  maximumBytes?: number
  maximumRedirects?: number
}

const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAXIMUM_BYTES = 1024 * 1024
const DEFAULT_MAXIMUM_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

function validateSourceUrl(value: string, allowedHosts: ReadonlySet<string>): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('公开资料地址格式不正确')
  }
  if (url.protocol !== 'https:') throw new Error('公开资料自动同步只允许 HTTPS 地址')
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`公开资料来源域名不在白名单：${url.hostname}`)
  }
  return url
}

async function readLimitedResponse(response: Response, maximumBytes: number): Promise<ArrayBuffer> {
  if (!response.body) {
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > maximumBytes) throw new Error('公开资料响应超过大小限制')
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maximumBytes) {
        await reader.cancel()
        throw new Error('公开资料响应超过大小限制')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  const combined = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return combined.buffer
}

export function createPublicScheduleHttpLoader(options: PublicScheduleHttpOptions) {
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maximumBytes = options.maximumBytes ?? DEFAULT_MAXIMUM_BYTES
  const maximumRedirects = options.maximumRedirects ?? DEFAULT_MAXIMUM_REDIRECTS
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('公开资料超时时间不正确')
  if (!Number.isInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error('公开资料响应大小上限不正确')
  }
  if (!Number.isInteger(maximumRedirects) || maximumRedirects < 0 || maximumRedirects > 10) {
    throw new Error('公开资料跳转次数上限不正确')
  }
  const allowedHosts = new Set(options.allowedHosts.map((host) => host.trim().toLowerCase()))
  if (allowedHosts.size === 0 || allowedHosts.has('')) throw new Error('公开资料域名白名单不能为空')

  return async (gameId: GameId): Promise<unknown> => {
    const configuredUrl = options.urls[gameId]
    if (!configuredUrl) throw new Error('该游戏尚未配置公开资料来源')
    let url = validateSourceUrl(configuredUrl, allowedHosts)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      let response: Response | undefined
      for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
        response = await fetcher(url, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'application/json' }
        })
        if (!REDIRECT_STATUSES.has(response.status)) break
        if (redirectCount === maximumRedirects) throw new Error('公开资料跳转次数过多')
        const location = response.headers.get('location')
        if (!location) throw new Error('公开资料跳转缺少 Location')
        url = validateSourceUrl(new URL(location, url).toString(), allowedHosts)
      }
      if (!response) throw new Error('公开资料请求未返回响应')
      if (!response.ok) throw new Error(`公开资料请求失败：HTTP ${response.status}`)

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
      if (!contentType.includes('application/json') && !contentType.includes('+json')) {
        throw new Error('公开资料响应不是 JSON')
      }
      const declaredLength = Number(response.headers.get('content-length'))
      if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
        throw new Error('公开资料响应超过大小限制')
      }

      const bytes = await readLimitedResponse(response, maximumBytes)
      try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
      } catch {
        throw new Error('公开资料 JSON 解析失败')
      }
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`公开资料请求超时（${timeoutMs}ms）`)
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}
