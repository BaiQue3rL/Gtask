import { describe, expect, it } from 'vitest'
import { readEventCompletionEvidence } from '../src/main/sync/event-completion-evidence'
import { extractGenshinEventProgressCandidates } from '../src/main/sync/genshin-personal-parser'
import { extractStarRailEventProgressCandidates } from '../src/main/sync/star-rail-personal-parser'
import { extractZenlessEventProgressCandidates } from '../src/main/sync/zenless-personal-parser'
import { personalEventsFromCandidates } from '../src/main/sync/personal-snapshot'
import { normalizeSyncItem, normalizeSyncItems } from '../src/main/sync/normalization'
import calendars from './fixtures/personal-event-calendars.json'

const reference = new Date('2026-10-13T14:00:00Z')
const sources = [
  ['genshin', 'miyoushe-genshin-event-calendar', extractGenshinEventProgressCandidates, 'act_list', 'is_finished'],
  ['star-rail', 'miyoushe-star-rail-event-calendar', extractStarRailEventProgressCandidates, 'act_list', 'all_finished'],
  ['zenless', 'miyoushe-zenless-event-calendar', extractZenlessEventProgressCandidates, 'activity_list', 'state']
] as const

describe('official event completion contracts', () => {
  it.each(sources)('%s transmits verified complete and incomplete evidence through normalization', (game, _endpoint, extract) => {
    const items = normalizeSyncItems(personalEventsFromCandidates(game, 'miyoushe', extract(calendars[game]), reference))
    const expected = game === 'genshin' ? [false, true] : [true, false, false]
    expect(items.map(item => item.completed)).toEqual(expected)
    expect(items.map(item => item.completionEvidence?.status)).toEqual(expected.map(done => done ? 'complete' : 'incomplete'))
  })

  it.each(sources)('%s preserves unknown instead of casting missing, invalid or arbitrary status fields', (game, endpoint, extract, listKey, field) => {
    for (const value of [undefined, null, 1, 'true', 'false', 'STATE_END', 'STATE_NOT_START', 'STATE_FUTURE', {}, []]) {
      const event = { id: 'missing', name: '新活动', [field]: value, is_complete: true,
        monochrome_got_cnt: 800, monochrome_cnt: 800, current_progress: 10, total_progress: 10 }
      const candidates = extract({ [listKey]: [event] })
      const item = normalizeSyncItems(personalEventsFromCandidates(game, 'miyoushe', candidates, reference))[0]
      expect(item.completed).toBeUndefined()
      expect(item.completionEvidence).toMatchObject({ status: 'unknown', rule: `${endpoint}:${field}` })
    }
  })

  it('ZZZ completion depends on its player state regardless of title or reward counters', () => {
    const candidates = extractZenlessEventProgressCandidates({ activity_list: [
      { activity_id: 'new-complete', name: '未来新增玩法甲', state: 'STATE_COMPLETED', monochrome_got_cnt: 0, monochrome_cnt: 800 },
      { activity_id: 'new-incomplete', name: '未来新增玩法乙', state: 'STATE_IN_PROGRESS', monochrome_got_cnt: 800, monochrome_cnt: 800 }
    ] })
    expect(personalEventsFromCandidates('zenless', 'miyoushe', candidates, reference).map(item => item.completed))
      .toEqual([true, false])
  })

  it.each(sources)('%s rejects incomplete calendar structures while accepting an explicit empty list', (_game, _endpoint, extract, listKey) => {
    expect(extract({ [listKey]: [] })).toEqual([])
    for (const value of [undefined, {}, null, [null], [{ id: 1, name: '有效条目' }, false]]) {
      expect(() => extract({ [listKey]: value })).toThrow('活动列表不完整')
    }
  })

  it('rejects conflicting completion evidence and duplicate official identities', () => {
    const candidates = extractZenlessEventProgressCandidates(calendars.zenless)
    const items = personalEventsFromCandidates('zenless', 'miyoushe', candidates, reference)
    expect(() => normalizeSyncItem({ ...items[0], completed: false })).toThrow('冲突')
    expect(() => normalizeSyncItem({ ...items[0], completionEvidence: readEventCompletionEvidence('miyoushe-zenless-event-calendar', {}) }))
      .toThrow('未知完成证据')
    expect(() => normalizeSyncItem({ ...items[0], completed: false,
      completionEvidence: { rule: 'invalid', field: 'state', status: ['incomplete'] } })).toThrow('证据格式')
    expect(() => normalizeSyncItem({ ...items[0], completed: undefined,
      completionEvidence: { rule: 'invalid', field: 'state', status: 'unknown', reason: ['missing-field'] } })).toThrow('未知完成证据')
    expect(() => personalEventsFromCandidates('zenless', 'miyoushe', [candidates[0], candidates[0]], reference)).toThrow('重复标识')
  })
})
