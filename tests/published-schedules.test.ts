import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppDatabase } from '../src/main/database'
import { parseRemoteCatalogFeed } from '../src/main/remote-catalog-update'

const sourceUrl = 'https://example.com/official-fixture'
const instant = (day: number) => `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`
function publication(day: number, game: Record<string, unknown>) {
  return parseRemoteCatalogFeed({ schemaVersion: 2, revision: `test.${day}`, publishedAt: instant(day), games: [{ gameId: 'genshin', ...game }] })
}
const rule = { kind: 'cycle_rule', key: 'sample-rule', remoteKey: 'endgame:audit', modeKey: 'audit', title: '合成周期',
  effectiveFrom: instant(1), policy: { kind: 'interval', anchorStartsAt: instant(1), cadenceDays: 7, durationDays: 4 }, sourceUrl }
const cycle = { remoteKey: 'endgame:audit', modeKey: 'audit', title: '合成周期', category: 'endgame',
  periodKey: 'p0', startsAt: instant(1), endsAt: instant(5), sourceUrl }

afterEach(() => vi.useRealTimers())
describe('published timing and missing deadline exceptions', () => {
  it('queues a future exception without touching the current completion; calibrates one period and keeps subsequent gaps anchored', () => {
    vi.useFakeTimers(); vi.setSystemTime(instant(2))
    const db = new AppDatabase(':memory:', { seedBundledBaselines: false })
    try {
      db.applyRemoteCatalogFeed(publication(2, { upserts: [cycle], scheduleUpdates: [rule] }))
      const id = db.listChecklistItems('genshin')[0].id
      db.setChecklistCompletion(id, true)
      const exception = { kind: 'cycle_window', key: 'p1-exception', remoteKey: cycle.remoteKey, modeKey: cycle.modeKey,
        periodKey: 'p1', nominalStartsAt: instant(8), startsAt: instant(10), endsAt: instant(13), sourceUrl }
      vi.setSystemTime(instant(3))
      db.applyRemoteCatalogFeed(publication(3, { scheduleUpdates: [exception, { ...rule, key: 'future-rule', effectiveFrom: instant(15),
        policy: { kind: 'interval', anchorStartsAt: instant(15), cadenceDays: 8, durationDays: 3 } }] }))
      expect(db.getChecklistItem(id)).toMatchObject({ completed: true, periodKey: 'p0', endsAt: instant(5) })
      db.rolloverDueCycleItems(new Date(instant(5)))
      expect(db.getChecklistItem(id)).toMatchObject({ completed: false, manualCompletionLocked: false, periodKey: 'p1', startsAt: instant(10), endsAt: instant(13) })
      vi.setSystemTime(instant(11)); db.setChecklistCompletion(id, true)
      db.applyRemoteCatalogFeed(publication(11, { scheduleUpdates: [{ ...exception, endsAt: instant(14) }] }))
      expect(db.getChecklistItem(id)).toMatchObject({ completed: true, manualCompletionLocked: true, periodKey: 'p1', endsAt: instant(14) })
      db.rolloverDueCycleItems(new Date(instant(14)))
      expect(db.getChecklistItem(id)).toMatchObject({ completed: false, startsAt: instant(15), endsAt: instant(18) })
      db.rolloverDueCycleItems(new Date(instant(18)))
      expect(db.getChecklistItem(id)).toMatchObject({ startsAt: instant(23), endsAt: instant(26) })
    } finally { db.close() }
  })

  it('retains a verified limited/open event without inventing a deadline and exposes its review obligation', () => {
    vi.useFakeTimers(); vi.setSystemTime(instant(2))
    const db = new AppDatabase(':memory:', { seedBundledBaselines: false })
    try {
      const event = { remoteKey: 'event:uncertain-end', title: '合成限时活动', category: 'limited_event', activityTags: ['combat'], sourceUrl,
        deadlineReview: { eligibility: 'confirmed_limited', openState: 'confirmed_open', limitedSourceUrl: sourceUrl,
          openSourceUrl: sourceUrl, checkedSources: [sourceUrl], checkedAt: instant(2), reviewAt: instant(7), missingReason: '公告明确限时，规则未列出截止时刻' } }
      db.applyRemoteCatalogFeed(publication(2, { upserts: [event] }))
      const id = db.listChecklistItems('genshin')[0].id
      db.setChecklistCompletion(id, true)
      db.pruneExpiredSystemItems(new Date(instant(9)))
      expect(db.getChecklistItem(id)).toMatchObject({ completed: true, endsAt: null })
      expect(db.listDeadlineReviews('genshin')).toHaveLength(1)
      db.applyRemoteCatalogFeed(publication(3, { upserts: [{ ...event, deadlineReview: undefined, startsAt: instant(1), endsAt: instant(20) }] }))
      expect(db.listDeadlineReviews('genshin')).toHaveLength(0)
      expect(db.getChecklistItem(id).completed).toBe(true)
      expect(() => publication(2, { upserts: [{ ...event, deadlineReview: undefined }] })).toThrow()
      expect(() => parseRemoteCatalogFeed({ ...publication(2, { upserts: [event] }), schemaVersion: 1 })).toThrow()
    } finally { db.close() }
  })

  it('persists future version exceptions and activates a cadence change at its published boundary', () => {
    vi.useFakeTimers(); vi.setSystemTime(instant(2))
    const db = new AppDatabase(':memory:', { seedBundledBaselines: false })
    try {
      db.applyRemoteCatalogFeed(publication(2, { versionWindow: { periodKey: 'version0', startsAt: instant(1), endsAt: instant(10),
        timeZone: 'UTC', confidence: 1, sourceUrl }, scheduleUpdates: [
        { kind: 'version_window', key: 'version1', periodKey: 'version1', nominalStartsAt: instant(10), startsAt: instant(10), endsAt: instant(20), timeZone: 'UTC', confidence: 1, sourceUrl },
        { kind: 'version_rule', key: 'six-days', effectiveFrom: instant(20), cadenceDays: 6, sourceUrl }
      ] }))
      expect(db.getRelevantGameVersionWindow('genshin')?.endsAt).toBe(instant(10))
      expect(db.getRelevantGameVersionWindow('genshin', new Date(instant(10)))).toMatchObject({ periodKey: 'version1', endsAt: instant(20) })
      expect(db.getRelevantGameVersionWindow('genshin', new Date(instant(21)))).toMatchObject({ startsAt: instant(20), endsAt: instant(26) })
    } finally { db.close() }
  })

  it('rejects conflicting accumulated exceptions atomically and keeps the previous receipt', () => {
    vi.useFakeTimers(); vi.setSystemTime(instant(2))
    const db = new AppDatabase(':memory:', { seedBundledBaselines: false })
    try {
      const exception = { kind: 'cycle_window', key: 'a', modeKey: 'audit', remoteKey: 'endgame:audit',
        periodKey: 'a', nominalStartsAt: instant(8), startsAt: instant(8), endsAt: instant(12), sourceUrl }
      db.applyRemoteCatalogFeed(publication(2, { upserts: [cycle], scheduleUpdates: [rule, exception] }))
      const receipt = db.getRemoteCatalogReceipt()
      expect(() => db.applyRemoteCatalogFeed(publication(3, { scheduleUpdates: [{ ...exception, key: 'b', periodKey: 'b', startsAt: instant(10) }] }))).toThrow('不能重叠')
      expect(db.getRemoteCatalogReceipt()).toEqual(receipt)
      expect(db.listPublishedSchedules('genshin')).toHaveLength(2)
    } finally { db.close() }
  })

  it('does not let an older predicted version span a future rule boundary or fill a published downtime', () => {
    vi.useFakeTimers(); vi.setSystemTime(instant(2))
    const db = new AppDatabase(':memory:', { seedBundledBaselines: false })
    try {
      db.applyRemoteCatalogFeed(publication(2, { versionWindow: { periodKey: 'v0', startsAt: instant(1), endsAt: instant(10), timeZone: 'UTC', confidence: 1, sourceUrl },
        scheduleUpdates: [{ kind: 'version_rule', key: 'new-cadence', effectiveFrom: instant(20), cadenceDays: 6, sourceUrl }] }))
      expect(db.getRelevantGameVersionWindow('genshin', new Date(instant(11)))?.endsAt).toBe(instant(20))
      expect(db.getRelevantGameVersionWindow('genshin', new Date(instant(21)))).toMatchObject({ startsAt: instant(20), endsAt: instant(26) })
    } finally { db.close() }
    const gapDb = new AppDatabase(':memory:', { seedBundledBaselines: false })
    try {
      gapDb.applyRemoteCatalogFeed(publication(2, { versionWindow: { periodKey: 'v0', startsAt: instant(1), endsAt: instant(10), timeZone: 'UTC', confidence: 1, sourceUrl },
        scheduleUpdates: [{ kind: 'version_window', key: 'after-gap', periodKey: 'v1', nominalStartsAt: instant(10), startsAt: instant(12), endsAt: instant(20), timeZone: 'UTC', confidence: 1, sourceUrl }] }))
      expect(gapDb.listGameVersionSummaries(new Date(instant(11))).find((game) => game.gameId === 'genshin')?.endsAt).toBeNull()
      expect(gapDb.getRelevantGameVersionWindow('genshin', new Date(instant(12)))?.endsAt).toBe(instant(20))
    } finally { gapDb.close() }
  })

  it('retains published rules, future windows and current manual state across reopening', () => {
    vi.useFakeTimers(); vi.setSystemTime(instant(2))
    const root = mkdtempSync(join(tmpdir(), 'gtask-public-time-'))
    const path = join(root, 'test.sqlite')
    let db = new AppDatabase(path, { seedBundledBaselines: false })
    try {
      db.applyRemoteCatalogFeed(publication(2, { upserts: [cycle], scheduleUpdates: [rule,
        { kind: 'cycle_window', key: 'reopen-window', remoteKey: cycle.remoteKey, modeKey: cycle.modeKey,
          nominalStartsAt: instant(8), startsAt: instant(10), endsAt: instant(13), periodKey: 'p1', sourceUrl }] }))
      const id = db.listChecklistItems('genshin')[0].id
      db.setChecklistCompletion(id, true)
      const receipt = db.getRemoteCatalogReceipt()
      db.close()
      db = new AppDatabase(path, { seedBundledBaselines: false })
      expect(db.listPublishedSchedules('genshin')).toHaveLength(2)
      expect(db.getRemoteCatalogReceipt()).toEqual(receipt)
      expect(db.getChecklistItem(id)).toMatchObject({ completed: true, manualCompletionLocked: true, periodKey: 'p0' })
      db.rolloverDueCycleItems(new Date(instant(5)))
      expect(db.getChecklistItem(id)).toMatchObject({ completed: false, startsAt: instant(10), periodKey: 'p1' })
    } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
