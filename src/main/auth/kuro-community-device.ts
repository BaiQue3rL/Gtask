const KURO_IP_URL = 'https://event.kurobbs.com/event/ip'
const FALLBACK_IP = '127.127.127.127'

export const KURO_IOS_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko)  KuroGameBox/3.1.3'

const identityCache = new WeakMap<object, Promise<string>>()

export function resolveKuroIosDevCode(fetcher: typeof fetch): Promise<string> {
  const cached = identityCache.get(fetcher)
  if (cached) return cached

  const pending = resolvePublicIp(fetcher)
    .then((ip) => `${ip}, ${KURO_IOS_USER_AGENT}`)
  identityCache.set(fetcher, pending)
  return pending
}

async function resolvePublicIp(fetcher: typeof fetch): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5_000)
  try {
    const response = await fetcher(KURO_IP_URL, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal
    })
    if (!response.ok) return FALLBACK_IP
    const value = (await response.text()).trim()
    return value && value.length <= 128 ? value : FALLBACK_IP
  } catch {
    return FALLBACK_IP
  } finally {
    clearTimeout(timeout)
  }
}
