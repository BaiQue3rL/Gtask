import { z } from 'zod'
import type { ChecklistItem, GameId } from '../shared/contracts'
import { findCycleMode, predictCycleWindow, type CycleModeDefinition, type CycleVersionWindow } from './sync/cycle-catalog'

export const publicTimestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value), '时间必须带时区')
const https = z.string().url().refine((value) => new URL(value).protocol === 'https:')
const key = z.string().trim().min(1).max(160)
const intervalPolicy = z.object({ kind: z.literal('interval'), anchorStartsAt: publicTimestamp,
  cadenceDays: z.number().positive().max(366), durationDays: z.number().positive().max(366) }).strict()
const monthlyPolicy = z.object({ kind: z.literal('monthly'), startDay: z.number().int().min(1).max(28),
  hour: z.number().int().min(0).max(23), timeZoneOffsetHours: z.number().min(-12).max(14) }).strict()
export const cyclePolicySchema = z.discriminatedUnion('kind', [intervalPolicy, monthlyPolicy,
  z.object({ kind: z.literal('version-relative'), startDayOffset: z.number().int().min(0).max(60),
    hour: z.number().int().min(0).max(23), timeZoneOffsetHours: z.number().min(-12).max(14),
    fallback: intervalPolicy }).strict()
]).superRefine((policy, context) => {
  const interval = policy.kind === 'interval' ? policy : policy.kind === 'version-relative' ? policy.fallback : null
  if (interval && interval.durationDays > interval.cadenceDays) context.addIssue({ code: 'custom', message: '开放时长不能大于开启间隔' })
})

export const deadlineReviewSchema = z.object({
  eligibility: z.literal('confirmed_limited'), openState: z.literal('confirmed_open'),
  limitedSourceUrl: https, openSourceUrl: https,
  checkedSources: z.array(https).min(1).max(20),
  checkedAt: publicTimestamp, reviewAt: publicTimestamp,
  missingReason: z.string().trim().min(1).max(500)
}).strict().superRefine((review, context) => {
  if (Date.parse(review.reviewAt) <= Date.parse(review.checkedAt)) context.addIssue({ code: 'custom', message: '复核节点必须晚于本次核查' })
})
export type DeadlineReview = z.infer<typeof deadlineReviewSchema>

const common = { key, sourceUrl: https }
export const publishedScheduleSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('cycle_rule'), remoteKey: key, modeKey: key,
    title: z.string().trim().min(1).max(120), effectiveFrom: publicTimestamp, policy: cyclePolicySchema }).strict(),
  z.object({ ...common, kind: z.literal('cycle_window'), remoteKey: key, modeKey: key,
    periodKey: key, nominalStartsAt: publicTimestamp, startsAt: publicTimestamp, endsAt: publicTimestamp }).strict(),
  z.object({ ...common, kind: z.literal('version_window'), periodKey: key,
    nominalStartsAt: publicTimestamp, startsAt: publicTimestamp, endsAt: publicTimestamp,
    timeZone: z.string().min(1).max(100), confidence: z.number().min(0).max(1) }).strict(),
  z.object({ ...common, kind: z.literal('version_rule'), effectiveFrom: publicTimestamp,
    cadenceDays: z.number().positive().max(366) }).strict()
]).superRefine((record, context) => {
  if ('startsAt' in record && Date.parse(record.startsAt) >= Date.parse(record.endsAt)) {
    context.addIssue({ code: 'custom', message: '开始必须早于结束' })
  }
})
export type PublishedSchedule = z.infer<typeof publishedScheduleSchema>
export const scheduleArchiveSchema = z.object({ kind: z.enum(['cycle_rule', 'cycle_window', 'version_window', 'version_rule']), key }).strict()

/** Apply only published definitions. Personal observations cannot call this path. */
export function resolvePublishedCycle(
  gameId: GameId,
  item: Pick<ChecklistItem, 'modeKey' | 'remoteKey' | 'title' | 'startsAt' | 'endsAt' | 'periodKey'>,
  records: PublishedSchedule[],
  reference: Date,
  versionWindow?: CycleVersionWindow | null
): { definition: CycleModeDefinition; startsAt: string; endsAt: string; periodKey: string; sourceUrl: string | null; calibration: boolean } | null {
  const now = reference.getTime()
  const rules = records.filter((record): record is Extract<PublishedSchedule, { kind: 'cycle_rule' }> =>
    record.kind === 'cycle_rule' && record.remoteKey === item.remoteKey
  ).sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom))
  let rule = rules.find((record) => Date.parse(record.effectiveFrom) <= now)
  let definition: CycleModeDefinition | null = rule ? { gameId, modeKey: rule.modeKey, remoteKey: rule.remoteKey,
    title: rule.title, aliases: [], prediction: rule.policy } : findCycleMode(gameId, { ...item, remoteKey: item.remoteKey ?? '' })
  if (!definition) return null
  const exceptions = records.filter((record): record is Extract<PublishedSchedule, { kind: 'cycle_window' }> =>
    record.kind === 'cycle_window' && record.remoteKey === item.remoteKey
  )
  // An exception for the current identity can correct its boundary without a reset.
  const currentException = exceptions.find((record) => Date.parse(record.endsAt) > now &&
    (record.periodKey === item.periodKey || Date.parse(record.nominalStartsAt) === Date.parse(item.startsAt ?? '')))
  if (currentException) return { ...currentException, definition, calibration: true }
  if (item.endsAt && Date.parse(item.endsAt) > now) return null
  let window = predictCycleWindow(definition, reference, undefined, versionWindow)
  if (!window || Date.parse(window.endsAt) <= now) return null
  const nextRule = rules.find((record) => Date.parse(record.effectiveFrom) > now && Date.parse(record.effectiveFrom) <= Date.parse(window!.startsAt))
  if (nextRule) {
    rule = nextRule
    definition = { gameId, modeKey: rule.modeKey, remoteKey: rule.remoteKey, title: rule.title, aliases: [], prediction: rule.policy }
    window = predictCycleWindow(definition, new Date(rule.effectiveFrom), undefined, versionWindow)
    if (!window) return null
  }
  // A published extension may still be active after its nominal interval ended.
  const exception = exceptions.find((record) => Date.parse(record.endsAt) > now && (
    Date.parse(record.nominalStartsAt) === Date.parse(window.startsAt) ||
    (Date.parse(record.nominalStartsAt) <= now && Date.parse(record.startsAt) <= now)
  ))
  return exception ? { ...exception, definition, calibration: false }
    : { ...window, definition, periodKey: `predicted:${gameId}:${definition.modeKey}:${window.startsAt}`, sourceUrl: rule?.sourceUrl ?? null, calibration: false }
}

export const PUBLIC_TIME_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS public_time_records (
    game_id TEXT NOT NULL REFERENCES games(id), kind TEXT NOT NULL, record_key TEXT NOT NULL,
    payload_json TEXT NOT NULL, verified_at TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(game_id, kind, record_key)
  );
`
