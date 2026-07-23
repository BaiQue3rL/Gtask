import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { getBundledExplorationCatalog } from '../src/main/sync/bundled-exploration-catalog'
import type { GameId } from '../src/shared/contracts'

const games: GameId[] = ['genshin', 'star-rail', 'zenless', 'wuthering-waves']
const databases: AppDatabase[] = []

afterEach(() => {
  while (databases.length > 0) databases.pop()?.close()
})

describe('bundled exploration catalog', () => {
  it('provides a verified non-empty 0% baseline for every supported game', () => {
    for (const gameId of games) {
      const items = getBundledExplorationCatalog(gameId)
      expect(items.length).toBeGreaterThan(0)
      expect(items.every((item) => item.category === 'exploration')).toBe(true)
      expect(items.every((item) => item.progressPercent === 0)).toBe(true)
      expect(items.every((item) => item.modeKey && item.sourceUrl?.startsWith('https://'))).toBe(true)
      expect(new Set(items.map((item) => item.remoteKey)).size).toBe(items.length)
    }
  })

  it('原神基础目录覆盖官方互动地图当前独立地图层', () => {
    const titles = getBundledExplorationCatalog('genshin').map((item) => item.title)
    expect(titles).toEqual(expect.arrayContaining([
      '渊下宫',
      '层岩巨渊·地下矿区',
      '旧日之海',
      '远古圣山',
      '空之神殿',
      '霜月'
    ]))
  })

  it('initializes regions once and remains append/update safe on repeated refresh', () => {
    const database = new AppDatabase(':memory:')
    databases.push(database)
    const catalog = getBundledExplorationCatalog('genshin')

    expect(database.mergeSyncedItems('genshin', 'public_schedule', catalog)).toMatchObject({
      added: catalog.length,
      updated: 0
    })
    expect(database.mergeSyncedItems('genshin', 'public_schedule', catalog)).toMatchObject({
      added: 0,
      updated: catalog.length
    })
    expect(database.listChecklistItems('genshin').filter((item) => item.category === 'exploration'))
      .toHaveLength(catalog.length)
    expect(database.listChecklistItems('genshin').filter((item) => item.category === 'exploration'))
      .toSatisfy((items: Array<{ progressPercent: number | null; completed: boolean }>) =>
        items.every((item) => item.progressPercent === 0 && item.completed === false)
      )

    database.mergeSyncedItems('genshin', 'personal_sync', [{
      remoteKey: 'exploration:world:1',
      category: 'exploration',
      title: '蒙德',
      modeKey: 'world-exploration-1',
      progressPercent: 65
    }])
    database.mergeSyncedItems('genshin', 'public_schedule', catalog)
    expect(database.listChecklistItems('genshin').find((item) => item.title === '蒙德'))
      .toMatchObject({ progressPercent: 65, completed: false })

    database.mergeSyncedItems('genshin', 'personal_sync', [{
      remoteKey: 'exploration:world:14',
      category: 'exploration',
      title: '旧日之海',
      modeKey: 'world-exploration-14',
      progressPercent: 100
    }])
    database.mergeSyncedItems('genshin', 'public_schedule', catalog)
    expect(database.listChecklistItems('genshin').filter((item) => item.title === '旧日之海'))
      .toEqual([expect.objectContaining({ progressPercent: 100, completed: true })])
  })
})
