import { describe, expect, it } from 'vitest'
import type { ChecklistItem } from '../src/shared/contracts'
import {
  buildMapTreeRows,
  collectMapBranchKeys,
  distributeMapTreeRows
} from '../src/renderer/src/map-tree'

function mapItem(
  id: string,
  title: string,
  overrides: Partial<ChecklistItem> = {}
): ChecklistItem {
  return {
    id,
    gameId: 'wuthering-waves',
    category: 'exploration',
    title,
    activityTags: [],
    completed: false,
    progressPercent: 0,
    parentTitle: null,
    mapNodeKind: 'region',
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
    source: 'public_schedule',
    remoteKey: id,
    sourceUrl: null,
    manualCompletionLocked: false,
    lastSyncedAt: null,
    completedAt: null,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides
  }
}

describe('buildMapTreeRows', () => {
  it('只按一级主地区和二级地区渲染，每个二级地区只出现一次', () => {
    const rows = buildMapTreeRows([
      mapItem('region:huanglong', '瑝珑'),
      mapItem('region:black-shores', '黑海岸'),
      mapItem('map:jinzhou', '今州城', {
        mapNodeKind: 'subregion',
        parentTitle: '瑝珑',
        parentRemoteKey: 'region:huanglong'
      }),
      mapItem('map:tethys', '泰缇斯之底', {
        mapNodeKind: 'subregion',
        parentTitle: '黑海岸',
        parentRemoteKey: 'region:black-shores'
      })
    ], new Set())

    expect(rows.map((row) => [row.item.id, row.depth])).toEqual([
      ['region:black-shores', 0],
      ['map:tethys', 1],
      ['region:huanglong', 0],
      ['map:jinzhou', 1]
    ])
    expect(new Set(rows.map((row) => row.item.id)).size).toBe(rows.length)
  })

  it('首次载入时收起全部一级目录', () => {
    const items = [
      mapItem('region:liyue', '璃月'),
      mapItem('map:chasm', '层岩巨渊', {
        mapNodeKind: 'subregion',
        parentRemoteKey: 'region:liyue'
      })
    ]
    const collapsed = collectMapBranchKeys(items)

    expect([...collapsed]).toEqual(['region:liyue'])
    expect(buildMapTreeRows(items, collapsed).map((row) => row.item.id))
      .toEqual(['region:liyue'])
  })

  it('父目录收起时不会把子地区提升到根目录', () => {
    const rows = buildMapTreeRows([
      mapItem('region:penacony', '匹诺康尼'),
      mapItem('map:dreamscape', '「白日梦」酒店-梦境', {
        mapNodeKind: 'subregion',
        parentRemoteKey: 'region:penacony'
      })
    ], new Set(['region:penacony']))

    expect(rows.map((row) => row.item.id)).toEqual(['region:penacony'])
  })

  it('一级目录没有直接进度时按二级地区平均进度显示', () => {
    const rows = buildMapTreeRows([
      mapItem('region:liyue', '璃月', { progressPercent: null }),
      mapItem('map:a', '碧水原', {
        mapNodeKind: 'subregion',
        progressPercent: 100,
        parentRemoteKey: 'region:liyue'
      }),
      mapItem('map:b', '珉林', {
        mapNodeKind: 'subregion',
        progressPercent: 50,
        parentRemoteKey: 'region:liyue'
      })
    ], new Set())

    expect(rows.find((row) => row.item.id === 'region:liyue')?.displayProgressPercent).toBe(75)
  })

  it('目录汇总不受已完成筛选隐藏子节点影响', () => {
    const allItems = [
      mapItem('region:liyue', '璃月', { progressPercent: null }),
      mapItem('map:done', '碧水原', {
        mapNodeKind: 'subregion',
        completed: true,
        progressPercent: 100,
        parentRemoteKey: 'region:liyue'
      }),
      mapItem('map:active', '珉林', {
        mapNodeKind: 'subregion',
        progressPercent: 50,
        parentRemoteKey: 'region:liyue'
      })
    ]
    const rows = buildMapTreeRows(
      allItems.filter((item) => !item.completed),
      new Set(),
      allItems
    )

    expect(rows.find((row) => row.item.id === 'region:liyue')?.displayProgressPercent).toBe(75)
    expect(rows.some((row) => row.item.id === 'map:done')).toBe(false)
  })

  it('横向布局保持每个一级目录和其二级地区在同一列', () => {
    const rows = buildMapTreeRows([
      mapItem('region:a', '一级 A'),
      mapItem('map:a:1', '二级 A1', {
        mapNodeKind: 'subregion',
        parentRemoteKey: 'region:a'
      }),
      mapItem('map:a:2', '二级 A2', {
        mapNodeKind: 'subregion',
        parentRemoteKey: 'region:a'
      }),
      mapItem('region:b', '一级 B'),
      mapItem('map:b:1', '二级 B1', {
        mapNodeKind: 'subregion',
        parentRemoteKey: 'region:b'
      })
    ], new Set())
    const columns = distributeMapTreeRows(rows, 2)

    expect(columns[0].map((row) => row.item.id)).toEqual([
      'region:a',
      'map:a:1',
      'map:a:2'
    ])
    expect(columns[1].map((row) => row.item.id)).toEqual(['region:b', 'map:b:1'])
  })
})
