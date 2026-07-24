export function extractKuroBatToken(value: unknown): string | null {
  if (typeof value === 'string') return normalizeToken(value, 24)
  if (!isRecord(value)) return null
  return normalizeToken(value.accessToken, 1)
}

function normalizeToken(value: unknown, minimumLength: number): string | null {
  if (typeof value !== 'string') return null
  const token = value.trim()
  if (token.length < minimumLength || token.length > 16_384) return null
  return /^[\x21-\x7e]+$/.test(token) ? token : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
