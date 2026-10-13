import { describe, expect, it } from 'vitest'
import {
  personalEventsFromCandidates,
  personalMapsFromCandidates
} from '../src/main/sync/personal-snapshot'
import { readEventCompletionEvidence } from '../src/main/sync/event-completion-evidence'
import { extractStarRailEventProgressCandidates } from '../src/main/sync/star-rail-personal-parser'
import type { PersonalEventProgressCandidate } from '../src/main/sync/types'

const unknownEvidence = readEventCompletionEvidence('miyoushe-genshin-event-calendar', {})

describe('personal snapshot normalization', () => {
  it.each([
    ['genshin', '幽境危战·本期'],
    ['star-rail', '虚构叙事'],
    ['zenless', '式舆防卫战'],
    ['wuthering-waves', '千道门扉的异想']
  ] as const)('过滤 %s 个人活动接口中的周期挑战 %s', (gameId, title) => {
    const items = personalEventsFromCandidates(gameId, 'miyoushe', [{
      target: 'events',
      kind: 'personal-event-progress',
      payload: {
        sourceContext: 'official-event-api',
        officialEventId: 'cycle-noise',
        title,
        normalizedStartAt: '2026-07-01T00:00:00.000Z',
        normalizedEndAt: '2026-09-01T00:00:00.000Z',
        completionEvidence: unknownEvidence
      }
    }], new Date('2026-07-31T00:00:00.000Z'))
    expect(items).toEqual([])
  })

  it('过滤已经结束的个人活动，但保留尚未开始和正在进行的活动', () => {
    const candidate = (id: string, title: string, start: string, end: string): PersonalEventProgressCandidate => ({
      target: 'events' as const,
      kind: 'personal-event-progress',
      payload: {
        sourceContext: 'official-event-api', officialEventId: id, title,
        normalizedStartAt: start, normalizedEndAt: end, completionEvidence: unknownEvidence
      }
    })
    const items = personalEventsFromCandidates('genshin', 'miyoushe', [
      candidate('old', '旧活动', '2026-06-01T00:00:00.000Z', '2026-06-30T00:00:00.000Z'),
      candidate('current', '当前活动', '2026-07-20T00:00:00.000Z', '2026-08-10T00:00:00.000Z'),
      candidate('future', '未来活动', '2026-08-20T00:00:00.000Z', '2026-09-10T00:00:00.000Z')
    ], new Date('2026-07-31T00:00:00.000Z'))
    expect(items.map((item) => item.title)).toEqual(['当前活动', '未来活动'])
    expect(items.every((item) => item.completed === undefined)).toBe(true)
  })

  it.each([
    ['genshin', 'miyoushe-genshin-event-calendar', 'is_finished'],
    ['star-rail', 'miyoushe-star-rail-event-calendar', 'all_finished'],
    ['zenless', 'miyoushe-zenless-event-calendar', 'state']
  ] as const)('传递 %s 适配器的完成证据，不再按接口名丢弃', (gameId, sourceContext, field) => {
    const candidate = (id: string, completed: boolean): PersonalEventProgressCandidate => ({
      target: 'events' as const,
      kind: 'personal-event-progress',
      payload: {
        sourceContext,
        officialEventId: id,
        title: `${gameId} 活动 ${id}`,
        normalizedStartAt: '2026-07-20T00:00:00.000Z',
        normalizedEndAt: '2026-09-10T00:00:00.000Z',
        completionEvidence: readEventCompletionEvidence(sourceContext, {
          [field]: field === 'state' ? (completed ? 'STATE_COMPLETED' : 'STATE_IN_PROGRESS') : completed
        })
      }
    })
    const items = personalEventsFromCandidates(gameId, 'miyoushe', [
      candidate('complete', true),
      candidate('incomplete', false)
    ], new Date('2026-08-09T00:00:00.000Z'))

    expect(items.map((item) => item.completed)).toEqual([true, false])
  })

  it('不把活动生命周期状态或进度数字猜成完成', () => {
    const items = personalEventsFromCandidates('star-rail', 'miyoushe', extractStarRailEventProgressCandidates({
      act_list: [{
        id: 'ambiguous', name: '状态含糊的活动',
        act_status: 'OtherActStatusFinish', current_progress: 10, total_progress: 10
      }]
    }), new Date('2026-08-09T00:00:00.000Z'))

    expect(items[0].completed).toBeUndefined()
    expect(items[0].completionEvidence).toMatchObject({ status: 'unknown', reason: 'missing-field' })
  })

  it('只接受同一官方快照中父级完整的两级地图结构', () => {
    const candidates = [{
      target: 'exploration' as const,
      kind: 'personal-map-progress',
      payload: {
        officialId: 'root', officialTitle: '一级地区', observedProgress: 50,
        observedNodeKind: 'region', observedParentId: null
      }
    }, {
      target: 'exploration' as const,
      kind: 'personal-map-progress',
      payload: {
        officialId: 'child', officialTitle: '二级地区', observedProgress: 100,
        observedNodeKind: 'subregion', observedParentId: 'root', observedParentTitle: '一级地区'
      }
    }]
    expect(personalMapsFromCandidates('miyoushe', candidates)).toEqual([
      expect.objectContaining({ title: '一级地区', mapNodeKind: 'region', parentRemoteKey: null }),
      expect.objectContaining({
        title: '二级地区', mapNodeKind: 'subregion',
        parentRemoteKey: 'personal-map:miyoushe:root', progressPercent: 100
      })
    ])
    expect(personalMapsFromCandidates('miyoushe', [candidates[1]])).toEqual([
      expect.objectContaining({
        title: '二级地区',
        mapNodeKind: 'subregion',
        parentRemoteKey: null,
        progressPercent: 100
      })
    ])
  })
})
