export function isMissingGiteeRelease(status, payload) {
  return status === 404 || payload === null || payload === undefined
}

export function giteeResourceId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  return BigInt(value) > 0n ? value : null
}
