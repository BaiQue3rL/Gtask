import type { NormalizedSyncItem, ScheduleObservationInput } from './types'

export function scheduleObservationsFromItems(
  items: NormalizedSyncItem[]
): ScheduleObservationInput[] {
  return items.flatMap((item) => {
    const target = item.category === 'limited_event'
      ? 'events' as const
      : item.category === 'endgame'
        ? 'cycles' as const
        : null
    const identity = item.sourceIdentity
    if (!target || !identity || (identity.provider !== 'miyoushe' &&
      identity.provider !== 'kuro-community')) return []
    if (!item.startsAt && !item.endsAt) return []
    return [{
      target,
      provider: identity.provider,
      endpoint: identity.endpoint,
      remoteKey: item.remoteKey,
      title: item.title,
      modeKey: item.modeKey ?? null,
      periodKey: item.periodKey ?? null,
      startsAt: normalizedIso(item.startsAt),
      endsAt: normalizedIso(item.endsAt)
    }]
  })
}

function normalizedIso(value: string | null | undefined): string | null {
  if (!value) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null
}
