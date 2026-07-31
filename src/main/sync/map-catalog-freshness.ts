import type { ChecklistItem } from '../../shared/contracts'

export const MAP_CATALOG_MAX_UNVERIFIED_AGE_MS = 30 * 24 * 60 * 60 * 1000

export interface MapCatalogVersionWindow {
  periodKey: string | null
  startsAt: string
  endsAt: string
}

export type MapCatalogAuditReason =
  | 'version_started'
  | 'version_boundary_reached'
  | 'catalog_age_limit'
  | 'catalog_current'

export interface MapCatalogFreshnessDecision {
  shouldAudit: boolean
  reason: MapCatalogAuditReason
  verifiedAt: string
  nextCheckAt: string | null
}

function validTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

export function selectRelevantVersionWindow(
  items: Array<Pick<ChecklistItem, 'category' | 'periodKey' | 'startsAt' | 'endsAt'>>,
  reference = new Date()
): MapCatalogVersionWindow | null {
  const referenceTime = reference.getTime()
  const windows = items.flatMap((item): MapCatalogVersionWindow[] => {
    if (item.category !== 'main_quest' && item.category !== 'side_quest') return []
    const startsAt = validTimestamp(item.startsAt)
    const endsAt = validTimestamp(item.endsAt)
    if (startsAt === null || endsAt === null || startsAt >= endsAt) return []
    return [{
      periodKey: item.periodKey,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(endsAt).toISOString()
    }]
  })
  const unique = [...new Map(windows.map((window) => [
    `${window.periodKey ?? ''}\0${window.startsAt}\0${window.endsAt}`,
    window
  ])).values()]

  const active = unique
    .filter((window) =>
      Date.parse(window.startsAt) <= referenceTime &&
      referenceTime < Date.parse(window.endsAt)
    )
    .sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt))[0]
  if (active) return active

  const latestStarted = unique
    .filter((window) => Date.parse(window.startsAt) <= referenceTime)
    .sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt))[0]
  if (latestStarted) return latestStarted

  return unique.sort(
    (left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt)
  )[0] ?? null
}

export function evaluateMapCatalogFreshness(input: {
  bundledVerifiedAt: string
  lastCodexAuditAt: string | null
  versionWindow: MapCatalogVersionWindow | null
  reference?: Date
  maximumAgeMs?: number
}): MapCatalogFreshnessDecision {
  const reference = input.reference ?? new Date()
  const referenceTime = reference.getTime()
  const bundledVerifiedAt = validTimestamp(input.bundledVerifiedAt)
  if (bundledVerifiedAt === null) throw new Error('内置地图目录缺少有效核验时间')
  const lastCodexAuditAt = validTimestamp(input.lastCodexAuditAt)
  const verifiedTime = Math.max(bundledVerifiedAt, lastCodexAuditAt ?? 0)
  const maximumAgeMs = input.maximumAgeMs ?? MAP_CATALOG_MAX_UNVERIFIED_AGE_MS

  if (input.versionWindow) {
    const versionStartsAt = Date.parse(input.versionWindow.startsAt)
    const versionEndsAt = Date.parse(input.versionWindow.endsAt)
    if (referenceTime >= versionEndsAt && verifiedTime < versionEndsAt) {
      return {
        shouldAudit: true,
        reason: 'version_boundary_reached',
        verifiedAt: new Date(verifiedTime).toISOString(),
        nextCheckAt: null
      }
    }
    if (
      referenceTime >= versionStartsAt &&
      referenceTime < versionEndsAt &&
      verifiedTime < versionStartsAt
    ) {
      return {
        shouldAudit: true,
        reason: 'version_started',
        verifiedAt: new Date(verifiedTime).toISOString(),
        nextCheckAt: null
      }
    }
  }

  const ageDeadline = verifiedTime + maximumAgeMs
  if (referenceTime >= ageDeadline) {
    return {
      shouldAudit: true,
      reason: 'catalog_age_limit',
      verifiedAt: new Date(verifiedTime).toISOString(),
      nextCheckAt: null
    }
  }

  const versionBoundary = input.versionWindow
    ? Date.parse(input.versionWindow.endsAt)
    : Number.POSITIVE_INFINITY
  const nextCheckTime = Math.min(ageDeadline, versionBoundary)
  return {
    shouldAudit: false,
    reason: 'catalog_current',
    verifiedAt: new Date(verifiedTime).toISOString(),
    nextCheckAt: Number.isFinite(nextCheckTime)
      ? new Date(nextCheckTime).toISOString()
      : null
  }
}
