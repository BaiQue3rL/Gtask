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
  it('独立地图同时带父节点和关联地区时只显示一次并优先真实父节点', () => {
    const rows = buildMapTreeRows([
      mapItem('region:root', '瑝珑'),
      mapItem('region:related', '今州'),
      mapItem('map:independent', '乘霄山', {
        mapNodeKind: 'independent',
        parentRemoteKey: 'region:root',
        relatedRegionRemoteKey: 'region:related'
      })
    ], new Set())

    expect(rows.map((row) => row.item.id)).toEqual([
      'region:root',
      'map:independent',
      'region:related'
    ])
    expect(rows.filter((row) => row.item.id === 'map:independent')).toHaveLength(1)
    expect(rows.find((row) => row.item.id === 'map:independent')?.depth).toBe(1)
  })

  it('只有关联地区的独立地图归入该地区且不保留根级副本', () => {
    const rows = buildMapTreeRows([
      mapItem('region:nod-krai', '挪德卡莱'),
      mapItem('map:frostmoon', '霜月', {
        mapNodeKind: 'independent',
        relatedRegionRemoteKey: 'region:nod-krai'
      })
    ], new Set())

    expect(rows.map((row) => [row.item.id, row.depth])).toEqual([
      ['region:nod-krai', 0],
      ['map:frostmoon', 1]
    ])
  })

  it('折叠父目录后隐藏整条分支，不把未渲染的子地图提升成一级目录', () => {
    const rows = buildMapTreeRows([
      mapItem('world:penacony', '匹诺康尼', { mapNodeKind: 'group' }),
      mapItem('map:penacony:dreamscape', '「白日梦」酒店-梦境', {
        mapNodeKind: 'subregion',
        parentRemoteKey: 'world:penacony'
      }),
      mapItem('map:penacony:reality', '「白日梦」酒店-现实', {
        mapNodeKind: 'subregion',
        parentRemoteKey: 'world:penacony'
      })
    ], new Set(['world:penacony']))

    expect(rows.map((row) => [row.item.id, row.depth])).toEqual([
      ['world:penacony', 0]
    ])
  })

  it('首次载入时收起所有层级的目录，展开一级后不会自动展开二级', () => {
    const items = [
      mapItem('map:root', '一级目录', { mapNodeKind: 'group', progressPercent: null }),
      mapItem('map:second', '二级目录', {
        mapNodeKind: 'group',
        progressPercent: null,
        parentRemoteKey: 'map:root'
      }),
      mapItem('map:leaf', '三级探索区域', {
        mapNodeKind: 'subregion',
        parentRemoteKey: 'map:second'
      })
    ]
    const collapsed = collectMapBranchKeys(items)

    expect([...collapsed].sort()).toEqual(['map:root', 'map:second'])
    expect(buildMapTreeRows(items, collapsed).map((row) => row.item.id)).toEqual(['map:root'])

    collapsed.delete('map:root')
    expect(buildMapTreeRows(items, collapsed).map((row) => row.item.id)).toEqual([
      'map:root',
      'map:second'
    ])
  })

  it('父节点循环也不会造成重复渲染', () => {
    const rows = buildMapTreeRows([
      mapItem('map:a', '区域 A', { parentRemoteKey: 'map:b' }),
      mapItem('map:b', '区域 B', { parentRemoteKey: 'map:a' })
    ], new Set())

    expect(rows.map((row) => row.item.id).sort()).toEqual(['map:a', 'map:b'])
    expect(new Set(rows.map((row) => row.item.id)).size).toBe(2)
  })

  it('地图目录按直属子节点递归汇总探索度', () => {
    const rows = buildMapTreeRows([
      mapItem('world:penacony', '匹诺康尼', {
        mapNodeKind: 'group',
        progressPercent: null
      }),
      mapItem('map:dreamscape', '梦境', {
        mapNodeKind: 'group',
        progressPercent: null,
        parentRemoteKey: 'world:penacony'
      }),
      mapItem('map:dreamscape:a', '黄金的时刻', {
        mapNodeKind: 'subregion',
        progressPercent: 100,
        parentRemoteKey: 'map:dreamscape'
      }),
      mapItem('map:dreamscape:b', '筑梦边境', {
        mapNodeKind: 'subregion',
        progressPercent: 50,
        parentRemoteKey: 'map:dreamscape'
      }),
      mapItem('map:reality', '现实', {
        mapNodeKind: 'subregion',
        progressPercent: 25,
        parentRemoteKey: 'world:penacony'
      })
    ], new Set())

    expect(rows.find((row) => row.item.id === 'map:dreamscape')?.displayProgressPercent).toBe(75)
    expect(rows.find((row) => row.item.id === 'world:penacony')?.displayProgressPercent).toBe(50)
  })

  it('目录汇总不受已完成筛选隐藏子节点影响', () => {
    const allItems = [
      mapItem('map:root', '主地区', { mapNodeKind: 'group', progressPercent: null }),
      mapItem('map:done', '已完成地区', {
        mapNodeKind: 'subregion',
        completed: true,
        progressPercent: 100,
        parentRemoteKey: 'map:root'
      }),
      mapItem('map:active', '进行中地区', {
        mapNodeKind: 'subregion',
        progressPercent: 50,
        parentRemoteKey: 'map:root'
      })
    ]
    const visibleItems = allItems.filter((item) => !item.completed)
    const rows = buildMapTreeRows(visibleItems, new Set(), allItems)

    expect(rows.find((row) => row.item.id === 'map:root')?.displayProgressPercent).toBe(75)
    expect(rows.some((row) => row.item.id === 'map:done')).toBe(false)
  })

  it('横向地图布局保持每个一级目录和其子目录在同一列', () => {
    const rows = buildMapTreeRows([
      mapItem('map:a', '一级 A', { mapNodeKind: 'group', progressPercent: null }),
      mapItem('map:a:1', '二级 A1', { parentRemoteKey: 'map:a' }),
      mapItem('map:a:2', '二级 A2', { parentRemoteKey: 'map:a' }),
      mapItem('map:b', '一级 B', { mapNodeKind: 'group', progressPercent: null }),
      mapItem('map:b:1', '二级 B1', { parentRemoteKey: 'map:b' })
    ], new Set())
    const columns = distributeMapTreeRows(rows, 2)

    expect(columns[0].map((row) => row.item.id)).toEqual(['map:a', 'map:a:1', 'map:a:2'])
    expect(columns[1].map((row) => row.item.id)).toEqual(['map:b', 'map:b:1'])
  })
})
