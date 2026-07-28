function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '0:0:0:0:0:0:0:1' ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

export function resolveLoopbackHttpProxy(proxyResolution: string): string | null {
  for (const candidate of proxyResolution.split(';').map((value) => value.trim())) {
    const match = candidate.match(/^(?:PROXY|HTTP|HTTPS)\s+(.+)$/i)
    if (!match) continue
    try {
      const url = new URL(`http://${match[1]}`)
      if (!isLoopbackHost(url.hostname) || !url.port || url.username || url.password) continue
      const hostname = url.hostname.replace(/^\[|\]$/g, '')
      return `http://${hostname.includes(':') ? `[${hostname}]` : hostname}:${url.port}`
    } catch {
      continue
    }
  }
  return null
}
