import type { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { SUPPORTED_GAME_IDS } from '../src/shared/contracts'
import { GenshinPersonalAdapter } from '../src/main/sync/genshin-personal-adapter'
import { StarRailPersonalAdapter } from '../src/main/sync/star-rail-personal-adapter'
import { ZenlessPersonalAdapter } from '../src/main/sync/zenless-personal-adapter'
import { SyncOrchestrator } from '../src/main/sync/orchestrator'
import { scheduleObservationsFromItems } from '../src/main/sync/schedule-observations'
import type { NormalizedSyncItem, SyncAdapter } from '../src/main/sync/types'
import calendars from './fixtures/personal-event-calendars.json'

let database: AppDatabase | undefined
const accountScope = `test:${'a'.repeat(64)}`
const reference = new Date('2026-10-13T14:00:00Z')
const unused = async (): Promise<unknown> => { throw new Error('不应请求其他版块') }

afterEach(() => { database?.close(); database = undefined; vi.useRealTimers() })

function eventAdapters(zenless: unknown = calendars.zenless) {
  return {
    genshin: new GenshinPersonalAdapter({ getEventCalendar: async () => calendars.genshin,
      getProfile: unused, getSpiralAbyss: unused, getImaginariumTheater: unused, getStygianOnslaught: unused }),
    'star-rail': new StarRailPersonalAdapter({ getEventCalendar: async () => calendars['star-rail'],
      getMemoryOfChaos: unused, getPureFiction: unused, getApocalypticShadow: unused, getAnomalyArbitration: unused }),
    zenless: new ZenlessPersonalAdapter({ getZenlessEventCalendar: async () => zenless,
      getShiyuDefense: unused, getDeadlyAssault: unused, getZenlessExploration: unused })
  }
}

function withScope(adapter: SyncAdapter): SyncAdapter {
  return { sync: async (...args) => ({ ...await adapter.sync(...args), accountScope }) }
}

describe('personal completion from endpoint to persisted baseline', () => {
  it.each(['genshin', 'star-rail', 'zenless'] as const)('%s applies real calendar shapes through the complete adapter and coordinator path', async game => {
    vi.useFakeTimers()
    vi.setSystemTime(reference)
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const adapter = eventAdapters()[game]
    const output = await adapter.sync(game, 'events')
    const publicItems = output.items.map(item => ({
      remoteKey: `baseline:${item.sourceIdentity!.externalId}`, category: item.category,
      title: item.title, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-11-30T00:00:00Z'
    }))
    database.mergeSyncedItems(game, 'public_schedule', publicItems, reference.toISOString())
    const before = database.listChecklistItems(game)
    const orchestrator = new SyncOrchestrator(database, { publicSchedule: {}, personalData: {
      [game]: withScope(adapter)
    } })
    const result = await orchestrator.syncPersonalOnly(game, 'events')
    expect(result.status).toBe('success')
    expect(result.sources[0].progress).toMatchObject({ complete: 1, incomplete: game === 'genshin' ? 1 : 2,
      unknown: 0, notReturned: 0, unmatched: 0 })
    const after = database.listChecklistItems(game)
    for (const baseline of before) {
      const item = after.find(candidate => candidate.id === baseline.id)!
      expect(item).toMatchObject({ id: baseline.id, title: baseline.title, source: baseline.source,
        remoteKey: baseline.remoteKey, startsAt: baseline.startsAt, endsAt: baseline.endsAt,
        completed: output.items.find(candidate => candidate.title === baseline.title)!.completed })
    }
    // Schedule observations must stay account-free even after adding evidence.
    expect(JSON.stringify(scheduleObservationsFromItems(output.items))).not.toMatch(/completion|completed|800|accountScope/)
  })

  it('reports unknown, absent, protected and unmatched records separately, preserving reliable evidence', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(reference)
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const adapter = eventAdapters().zenless
    const output = await adapter.sync('zenless', 'events')
    database.mergeSyncedItems('zenless', 'public_schedule', [
      ...output.items.map(item => ({ remoteKey: `baseline:${item.sourceIdentity!.externalId}`, category: item.category,
        title: item.title, startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-11-30T00:00:00Z' })),
      { remoteKey: 'baseline:absent', category: 'limited_event', title: '接口未覆盖活动' },
      { remoteKey: 'baseline:future', category: 'limited_event', title: '未来活动', startsAt: '2026-12-01T00:00:00Z' }
    ], reference.toISOString())
    database.replacePersonalSnapshot('zenless', 'events', accountScope, output.items, 'fixture-v2', reference)
    const pinball = database.listChecklistItems('zenless').find(item => item.title.includes('弹球勇者'))!
    const diary = database.listChecklistItems('zenless').find(item => item.title.includes('成长日记'))!
    database.updateChecklistItem({ id: diary.id, completed: true })
    const storage = (database as unknown as { database: DatabaseSync }).database
    const evidenceBefore = storage.prepare('SELECT source_snapshot_id FROM checklist_items WHERE id = ?').get(pinball.id)
    const unknownPayload = { activity_list: [
      { ...calendars.zenless.activity_list[0], state: 'STATE_NEW_UNVERIFIED' },
      calendars.zenless.activity_list[1],
      { activity_id: 'unmatched', name: '新接口条目', state: 'STATE_COMPLETED' }
    ] }
    const nextAdapter = eventAdapters(unknownPayload).zenless
    const orchestrator = new SyncOrchestrator(database, { publicSchedule: {}, personalData: {
      zenless: withScope(nextAdapter)
    } })
    vi.setSystemTime(new Date(reference.getTime() + 1000))
    const result = await orchestrator.syncPersonalOnly('zenless', 'events')
    expect(result.sources[0].progress).toEqual({ complete: 0, incomplete: 1, unknown: 1,
      notReturned: 2, unmatched: 1, manualProtected: 1 })
    expect(result.message).toContain('无法判断 1（保留原状态）')
    expect(result.message).toContain('接口未返回 2（保留原状态）')
    expect(result.message).toContain('手动保护 1')
    expect(database.getChecklistItem(pinball.id).completed).toBe(true)
    expect(database.getChecklistItem(diary.id).completed).toBe(true)
    expect(storage.prepare('SELECT source_snapshot_id FROM checklist_items WHERE id = ?').get(pinball.id)).toEqual(evidenceBefore)
  })

  it.each(SUPPORTED_GAME_IDS)('%s cycles preserve unknown and can still apply explicit negative evidence', game => {
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const item: NormalizedSyncItem = { remoteKey: `endgame:${game}:contract`, category: 'endgame',
      title: '周期证据测试', modeKey: 'contract-cycle', startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-11-01T00:00:00Z',
      sourceIdentity: { provider: 'test', endpoint: 'challenge-record', externalId: '1' } }
    database.mergeSyncedItems(game, 'public_schedule', [{ ...item, sourceIdentity: undefined }], reference.toISOString())
    const apply = (completed: boolean | undefined) => database!.replacePersonalSnapshot(game, 'cycles', accountScope,
      [{ ...item, completed }], 'fixture', reference)
    expect(apply(true).progress.complete).toBe(1)
    expect(apply(undefined).progress.unknown).toBe(1)
    expect(database.listChecklistItems(game)[0].completed).toBe(true)
    expect(apply(false).progress.incomplete).toBe(1)
    expect(database.listChecklistItems(game)[0].completed).toBe(false)
  })
})
