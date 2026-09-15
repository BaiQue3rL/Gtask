import { describe, expect, it } from 'vitest'
import type { ChecklistItem } from '../src/shared/contracts'
import {
  buildMapTreeRows,
  collectMapBranchKeys,
  checklistRowKey,
  distributeMapTreeRows,
  filterIncompleteMapTreeRows,
  isChecklistRowComplete
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

  it('一级目录汇总子区域完成数，不把平均值显示为探索度', () => {
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

    expect(rows.find((row) => row.item.id === 'region:liyue')).toMatchObject({
      displayProgressPercent: null, mapSummary: { completed: 1, total: 2, unknown: 0 }
    })
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

    expect(rows.find((row) => row.item.id === 'region:liyue')?.mapSummary).toEqual({ completed: 1, total: 2, unknown: 0 })
    expect(rows.some((row) => row.item.id === 'map:done')).toBe(false)
  })

  it('只看未完成时保留已完成父目录作为结构，不把子地区提升为一级目录', () => {
    const allItems = [
      mapItem('region:liyue', '璃月', { completed: true, progressPercent: 100 }),
      mapItem('map:active', '沉玉谷', {
        mapNodeKind: 'subregion',
        completed: false,
        progressPercent: 80,
        parentRemoteKey: 'region:liyue'
      })
    ]
    const rows = buildMapTreeRows(
      allItems.filter((item) => !item.completed),
      new Set(),
      allItems
    )

    expect(rows.map((row) => [row.item.id, row.depth])).toEqual([
      ['region:liyue', 0],
      ['map:active', 1]
    ])
  })

  it('父级接口满探索也保留未完成分组和二级层次，100% 叶子按完成过滤', () => {
    const allItems = [
      mapItem('region:liyue', '璃月', { completed: true, progressPercent: 100 }),
      mapItem('map:active', '沉玉谷', {
        mapNodeKind: 'subregion',
        completed: false,
        progressPercent: 80,
        parentRemoteKey: 'region:liyue'
      }),
      mapItem('map:stale', '层岩巨渊', {
        mapNodeKind: 'subregion',
        completed: false,
        progressPercent: 100,
        parentRemoteKey: 'region:liyue'
      })
    ]
    const visibleItems = allItems.filter((item) => !item.completed && item.progressPercent !== 100)
    const rows = filterIncompleteMapTreeRows(buildMapTreeRows(
      visibleItems,
      new Set(),
      allItems
    ))

    expect(rows.map((row) => [row.item.id, row.depth])).toEqual([
      ['region:liyue', 0], ['map:active', 1]
    ])
    expect(isChecklistRowComplete(rows[0])).toBe(false)
    expect(rows[0].mapSummary).toEqual({ completed: 1, total: 2, unknown: 0 })
  })

  it.each(['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const)('%s：父级低进度但开放子区全部完成时整组隐藏', gameId => {
    const items = [mapItem('parent', '主地区', { gameId, progressPercent: 52 }),
      ...['a', 'b'].map(id => mapItem(id, id, { gameId, mapNodeKind: 'subregion', parentRemoteKey: 'parent', progressPercent: 100 }))]
    const rows = buildMapTreeRows(items, new Set())
    expect(rows[0].mapSummary).toEqual({ completed: 2, total: 2, unknown: 0 })
    expect(isChecklistRowComplete(rows[0])).toBe(true)
    expect(filterIncompleteMapTreeRows(rows)).toEqual([])
    expect(filterIncompleteMapTreeRows(buildMapTreeRows(items, new Set(['parent'])))).toEqual([])
  })

  it.each(['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const)('%s：父级满进度不隐藏未完成子区，收起展开都保留分组', gameId => {
    const items = [mapItem('parent', '主地区', { gameId, completed: true, progressPercent: 100 }),
      mapItem('done', '完成子区', { gameId, mapNodeKind: 'subregion', parentRemoteKey: 'parent', progressPercent: 100 }),
      mapItem('todo', '未完子区', { gameId, mapNodeKind: 'subregion', parentRemoteKey: 'parent', progressPercent: 25 })]
    const rows = filterIncompleteMapTreeRows(buildMapTreeRows(items, new Set()))
    expect(rows.map(row => [row.item.id, row.depth])).toEqual([['parent', 0], ['todo', 1]])
    expect(rows[0].mapSummary).toEqual({ completed: 1, total: 2, unknown: 0 })
    expect(filterIncompleteMapTreeRows(buildMapTreeRows(items, new Set(['parent']))).map(row => row.item.id)).toEqual(['parent'])
  })

  it('新开放或未知子区阻止全组完成，未开放子区暂不计数', () => {
    const now = Date.parse('2026-09-15T12:00:00Z')
    const items = [mapItem('parent', '测试地区', { completed: true, progressPercent: 100 }),
      mapItem('done', '完成子区', { mapNodeKind: 'subregion', parentRemoteKey: 'parent', progressPercent: 100 }),
      mapItem('new', '新子区', { mapNodeKind: 'subregion', parentRemoteKey: 'parent',
        startsAt: '2026-09-16T12:00:00Z', progressPercent: 0, reportedProgressPercent: null })]
    expect(buildMapTreeRows(items, new Set(), items, now)[0].mapSummary).toEqual({ completed: 1, total: 1, unknown: 0 })
    const later = buildMapTreeRows(items, new Set(), items, now + 86400000)
    expect(later[0].mapSummary).toEqual({ completed: 1, total: 2, unknown: 1 })
    expect(filterIncompleteMapTreeRows(later).map(row => [row.item.id, row.depth])).toEqual([['parent', 0], ['new', 1]])
    expect(later.find(row => row.item.id === 'new')?.displayProgressPercent).toBeNull()
  })

  it('无二级目录的地区继续使用已确认个人进度或手动完成状态', () => {
    const rows = buildMapTreeRows([
      mapItem('official', '官方', { progressPercent: 100, reportedProgressPercent: 100 }),
      mapItem('derived', '旧派生值', { completed: true, progressPercent: 100, reportedProgressPercent: null }),
      mapItem('manual', '手动', { completed: true, progressPercent: 100, reportedProgressPercent: null, manualCompletionLocked: true })
    ], new Set())
    expect(rows.filter(row => row.depth === 0).every(row => row.mapSummary?.total === 1)).toBe(true)
    expect(rows.filter(row => row.depth === 1).every(row => !row.mapSummary)).toBe(true)
    expect(filterIncompleteMapTreeRows(rows).map(row => [row.item.id, row.depth])).toEqual([['derived', 0], ['derived', 1]])
  })

  it.each(['genshin', 'star-rail', 'zenless', 'wuthering-waves'] as const)('%s：无子区一级展开同名二级，共用进度但显示标识独立', gameId => {
    const item = mapItem('single', '同名地图', { gameId, progressPercent: 60, reportedProgressPercent: 60 })
    const rows = buildMapTreeRows([item], new Set())
    expect(rows.map(row => [row.item.title, row.depth, row.hasChildren, row.displayProgressPercent]))
      .toEqual([['同名地图', 0, true, null], ['同名地图', 1, false, 60]])
    expect(rows[0].mapSummary).toEqual({ completed: 0, total: 1, unknown: 0 })
    expect(rows[0].item).toBe(item)
    expect(rows[1].item).toBe(item)
    expect(new Set(rows.map(checklistRowKey)).size).toBe(2)
    expect(collectMapBranchKeys([item])).toEqual(new Set(['single']))
    expect(buildMapTreeRows([item], new Set(['single']))).toHaveLength(1)
    const completed = { ...item, completed: true, progressPercent: 100, reportedProgressPercent: 100 }
    expect(filterIncompleteMapTreeRows(buildMapTreeRows([completed], new Set()))).toEqual([])
    const child = mapItem('child', '真实子区', { gameId, mapNodeKind: 'subregion', parentRemoteKey: 'single',
      progressPercent: null, reportedProgressPercent: null })
    const published = buildMapTreeRows([completed, child], new Set())
    expect(published.map(row => row.item.id)).toEqual(['single', 'child'])
    expect(published[0].mapSummary).toEqual({ completed: 0, total: 1, unknown: 1 })
    expect(completed.progressPercent).toBe(100)
  })

  it('仅有未来子区时不虚构同名可操作地图，开放后自动使用真实子区', () => {
    const now = Date.parse('2026-09-15T12:00:00Z')
    const items = [mapItem('parent', '地区', { completed: true, progressPercent: 100 }),
      mapItem('future', '未来子区', { mapNodeKind: 'subregion', parentRemoteKey: 'parent', startsAt: '2026-09-16T12:00:00Z' })]
    const rows = buildMapTreeRows(items, new Set(), items, now)
    expect(rows).toHaveLength(1)
    expect(rows[0].mapSummary).toEqual({ completed: 0, total: 0, unknown: 0 })
    expect(isChecklistRowComplete(rows[0])).toBe(false)
    expect(buildMapTreeRows(items, new Set(), items, now + 86400000).map(row => row.item.id)).toEqual(['parent', 'future'])
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
