import type { EventCompletionEvidence } from './types'

type EventEndpoint =
  | 'miyoushe-genshin-event-calendar'
  | 'miyoushe-star-rail-event-calendar'
  | 'miyoushe-zenless-event-calendar'

// Each field has endpoint-specific account semantics. In particular, ZZZ's
// STATE_COMPLETED is a player completion state, not the event's end date.
// Verified with the official calendars on 2026-10-13; see sync-adapters.md.
const COMPLETION_RULES: Record<EventEndpoint, {
  field: string
  states?: Readonly<Record<string, boolean>>
}> = {
  'miyoushe-genshin-event-calendar': { field: 'is_finished' },
  'miyoushe-star-rail-event-calendar': { field: 'all_finished' },
  'miyoushe-zenless-event-calendar': {
    field: 'state',
    states: { STATE_COMPLETED: true, STATE_IN_PROGRESS: false }
  }
}

export function readEventCalendarRecords(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some(item =>
    !item || typeof item !== 'object' || Array.isArray(item)
  )) throw new Error(`${label}活动列表不完整，已保留上次结果`)
  return value as Record<string, unknown>[]
}

export function readEventCompletionEvidence(
  endpoint: EventEndpoint,
  event: Record<string, unknown>
): EventCompletionEvidence {
  const { field, states } = COMPLETION_RULES[endpoint]
  const basis = { rule: `${endpoint}:${field}`, field }
  const value = event[field]
  if (value === undefined || value === null) {
    return { ...basis, status: 'unknown', reason: 'missing-field' }
  }
  if (states) {
    if (typeof value !== 'string') {
      return { ...basis, status: 'unknown', reason: 'invalid-field' }
    }
    if (!Object.hasOwn(states, value)) {
      return { ...basis, status: 'unknown', reason: 'unrecognized-value' }
    }
    return { ...basis, status: states[value] ? 'complete' : 'incomplete' }
  }
  if (typeof value !== 'boolean') {
    return { ...basis, status: 'unknown', reason: 'invalid-field' }
  }
  return { ...basis, status: value ? 'complete' : 'incomplete' }
}
