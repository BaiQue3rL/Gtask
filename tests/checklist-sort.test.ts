import { describe, expect, it } from 'vitest'
import type { ChecklistItem } from '../src/shared/contracts'
import { compareChecklistItems, compareMapTreeItems } from '../src/renderer/src/checklist-sort'

const now = Date.parse('2026-07-26T08:00:00.000Z')

function item(
  id: string,
  overrides: Partial<ChecklistItem> = {}
): ChecklistItem {
  return {
    id,
    gameId: 'genshin',
    category: 'limited_event',
    title: id,
    activityTags: [],
    completed: false,
    progressPercent: null,
    parentTitle: null,
    mapNodeKind: null,
    parentRemoteKey: null,
    relatedRegionRemoteKey: null,
    startsAt: null,
    endsAt: null,
    resetRule: null,
    periodKey: null,
    scheduleKind: null,
    resetWeekday: null,
    timeZone: null,
    modeKey: null,
    recurrenceRule: null,
    source: 'manual',
    remoteKey: null,
    sourceUrl: null,
    manualCompletionLocked: false,
    lastSyncedAt: null,
    completedAt: null,
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...overrides
  }
}

describe('compareChecklistItems', () => {
  it('所有版块都把已完成事项排在未完成事项之后', () => {
    const values = [
      item('completed-map', {
        category: 'exploration',
        completed: true,
        progressPercent: 100
      }),
      item('unfinished-map', {
        category: 'exploration',
        progressPercent: 50
      })
    ]

    expect(values.sort((left, right) => compareChecklistItems(left, right, now))
      .map((value) => value.id)).toEqual(['unfinished-map', 'completed-map'])
  })

  it('未完成事项中最后一天优先于普通进行中和尚未开始', () => {
    const values = [
      item('upcoming', { startsAt: '2026-07-28T08:00:00.000Z' }),
      item('normal', { endsAt: '2026-08-10T08:00:00.000Z' }),
      item('urgent', { endsAt: '2026-07-26T12:00:00.000Z' })
    ]

    expect(values.sort((left, right) => compareChecklistItems(left, right, now))
      .map((value) => value.id)).toEqual(['urgent', 'normal', 'upcoming'])
  })

  it('地图同级排序仍保持完成项沉底', () => {
    const values = [
      item('done-child', {
        category: 'exploration',
        completed: true,
        parentRemoteKey: 'region:liyue'
      }),
      item('open-child', {
        category: 'exploration',
        parentRemoteKey: 'region:liyue'
      })
    ]

    expect(values.sort((left, right) => compareChecklistItems(left, right, now))
      .map((value) => value.id)).toEqual(['open-child', 'done-child'])
  })

  it('地图同级目录按分组、地区、独立地图、子地区稳定排列', () => {
    const values = [
      item('child', { category: 'exploration', mapNodeKind: 'subregion', title: '子地区' }),
      item('independent', { category: 'exploration', mapNodeKind: 'independent', title: '独立地图' }),
      item('region', { category: 'exploration', mapNodeKind: 'region', title: '主地区' }),
      item('group', { category: 'exploration', mapNodeKind: 'group', title: '地图分组' })
    ]

    expect(values.sort(compareMapTreeItems).map((value) => value.id))
      .toEqual(['group', 'region', 'independent', 'child'])
  })
})
