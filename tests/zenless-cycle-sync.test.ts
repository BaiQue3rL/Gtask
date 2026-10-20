import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { createMiyousheZenlessPersonalAdapter } from '../src/main/sync/miyoushe-chronicle-client'
import { SyncOrchestrator } from '../src/main/sync/orchestrator'
import type { NormalizedSyncItem } from '../src/main/sync/types'
import fixtures from './fixtures/zenless-deadly-assault.json'

let database: AppDatabase | undefined
afterEach(() => { database?.close(); database = undefined; vi.useRealTimers() })

describe('危局强袭战从当前官方接口到本期完成状态', () => {
  it.each(['recorded', 'empty', 'unknown', 'request-failed'] as const)('%s', async state => {
    vi.useFakeTimers()
    const reference = new Date('2026-10-20T14:00:00Z')
    vi.setSystemTime(reference)
    database = new AppDatabase(':memory:', { seedBundledBaselines: false })
    const scope = `test:${'a'.repeat(64)}`
    const baseline: NormalizedSyncItem = {
      remoteKey: 'endgame:deadly-assault', category: 'endgame', title: '危局强袭战',
      modeKey: 'deadly-assault', startsAt: '2026-10-08T20:00:00Z', endsAt: '2026-10-22T20:00:00Z',
      periodKey: 'predicted:zenless:deadly-assault:2026-10-08T20:00:00.000Z'
    }
    database.mergeSyncedItems('zenless', 'public_schedule', [baseline], reference.toISOString())
    database.replacePersonalSnapshot('zenless', 'cycles', scope, [{
      ...baseline, completed: state !== 'recorded',
      sourceIdentity: { provider: 'test', endpoint: 'previous-observation', externalId: 'previous' }
    }], 'previous', reference)
    const before = database.listChecklistItems('zenless')[0]
    expect(before.manualCompletionLocked).toBe(false)

    const requests: string[] = []
    const fetcher: typeof fetch = vi.fn(async input => {
      const url = new URL(String(input))
      requests.push(url.pathname)
      let data: unknown
      if (url.pathname.endsWith('/getUserGameRolesByCookie')) {
        data = { list: [{ game_biz: 'nap_cn', game_uid: '1001', region: 'prod_gf_cn' }] }
      } else if (url.pathname.endsWith('/hadal_info_v2')) {
        data = { hadal_ver: 'v2', hadal_info_v2: { zone_id: 62059,
          hadal_begin_time: baseline.startsAt, hadal_end_time: baseline.endsAt,
          pass_fifth_floor: false, brief: { score: 0 } } }
      } else if (url.pathname.endsWith('/hadal_mem_detail_v2')) {
        expect(Object.fromEntries(url.searchParams)).toEqual({
          uid: '1001', region: 'prod_gf_cn', schedule_type: '1'
        })
        if (state === 'request-failed') return new Response('unavailable', { status: 503 })
        data = state === 'unknown'
          ? { zone_id: fixtures.recorded.zone_id, start_time: fixtures.recorded.start_time,
            end_time: fixtures.recorded.end_time }
          : fixtures[state]
      } else if (url.pathname.endsWith('/mem_detail')) {
        // This retired endpoint still returns success, but loses real records.
        data = fixtures.empty
      } else {
        throw new Error(`不应请求 ${url.pathname}`)
      }
      return new Response(JSON.stringify({ retcode: 0, data }), {
        headers: { 'content-type': 'application/json' }
      })
    })
    const adapter = createMiyousheZenlessPersonalAdapter({ kind: 'cookie', value: 'fixture-cookie' }, fetcher)
    const orchestrator = new SyncOrchestrator(database, { publicSchedule: {}, personalData: {
      zenless: { sync: async (gameId, target, reportProgress) => ({
        ...await adapter.sync(gameId, target, reportProgress), accountScope: scope
      }) }
    } })
    const result = await orchestrator.syncPersonalOnly('zenless', 'cycles')
    expect(requests).toEqual([
      '/binding/api/getUserGameRolesByCookie',
      '/event/game_record_zzz/api/zzz/hadal_info_v2',
      '/event/game_record_zzz/api/zzz/hadal_mem_detail_v2'
    ])
    expect(result.status).toBe(state === 'request-failed' ? 'error' : 'success')
    const after = database.getChecklistItem(before.id)
    expect(after.completed).toBe(state !== 'empty')
    expect(after).toMatchObject({ id: before.id, title: before.title, source: 'public_schedule',
      remoteKey: before.remoteKey, modeKey: before.modeKey, startsAt: before.startsAt,
      endsAt: before.endsAt, periodKey: before.periodKey, manualCompletionLocked: false })
    if (state === 'unknown') expect(result.sources[0].progress?.unknown).toBe(1)
    if (state === 'recorded') expect(result.sources[0].progress?.complete).toBe(1)
  })
})
