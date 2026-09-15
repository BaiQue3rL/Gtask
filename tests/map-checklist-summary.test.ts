import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { extractZenlessExplorationProgressCandidates } from '../src/main/sync/zenless-personal-parser'
import { extractGenshinExplorationProgressCandidates } from '../src/main/sync/genshin-personal-parser'
import { personalMapsFromCandidates } from '../src/main/sync/personal-snapshot'
import { parseRemoteCatalogFeed } from '../src/main/remote-catalog-update'
import { buildMapTreeRows, filterIncompleteMapTreeRows, isChecklistRowComplete } from '../src/renderer/src/map-tree'

describe('map checklist progress through sync and catalog updates', () => {
  it('projects a same-name leaf from the original map across sync, missing responses, manual changes and a real child publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'gtask-map-self-'))
    const path = join(root, 'test.sqlite')
    let db = new AppDatabase(path)
    const maps = () => db.listChecklistItems('genshin', { category: 'exploration' })
    const original = maps().find(item => item.title === '空之神殿')!
    const count = maps().length
    const rows = () => buildMapTreeRows(maps(), new Set()).filter(row => row.item.id === original.id)
    const sync = (raw: number | null) => db.replacePersonalSnapshot('genshin', 'exploration', `test:${'c'.repeat(64)}`,
      personalMapsFromCandidates('miyoushe', extractGenshinExplorationProgressCandidates({ world_explorations: raw === null ? [] : [
        { id: 19, parent_id: 0, name: '空之神殿', type: 'Offering', exploration_percentage: raw, area_exploration_list: [] }
      ] })), 'map-self-test')
    try {
      sync(600)
      expect(rows().map(row => [row.depth, row.displayProgressPercent])).toEqual([[0, null], [1, 60]])
      expect(rows()[0].mapSummary).toEqual({ completed: 0, total: 1, unknown: 0 })
      expect(maps()).toHaveLength(count)
      sync(null)
      db.close()
      db = new AppDatabase(path)
      expect(rows()[1].displayProgressPercent).toBe(60)
      expect(rows()[1].item.reportedProgressPercent).toBe(60)
      db.setChecklistCompletion(rows()[1].item.id, true)
      expect(rows()[0].mapSummary?.completed).toBe(1)
      expect(filterIncompleteMapTreeRows(rows())).toEqual([])
      sync(600)
      expect(rows()[1].displayProgressPercent).toBe(100)
      db.setChecklistCompletion(rows()[1].item.id, false)
      expect(rows()[0].mapSummary?.completed).toBe(0)
      sync(1000)
      expect(filterIncompleteMapTreeRows(rows())).toEqual([])
      db.applyRemoteCatalogFeed(parseRemoteCatalogFeed({ schemaVersion: 1, revision: 'map-self-real-child',
        publishedAt: new Date().toISOString(), games: [{ gameId: 'genshin', archives: [], upserts: [{
          remoteKey: 'map:test-real-child', category: 'exploration', title: '测试真实子区域', mapNodeKind: 'subregion',
          parentRemoteKey: original.remoteKey, sourceUrl: 'https://www.miyoushe.com/ys/'
        }] }] }))
      const current = buildMapTreeRows(maps(), new Set())
      const parent = current.find(row => row.item.id === original.id)!
      expect(rows()).toHaveLength(1)
      expect(parent.mapSummary).toEqual({ completed: 0, total: 1, unknown: 1 })
      expect(parent.item.progressPercent).toBe(100)
      expect(maps()).toHaveLength(count + 1)
      expect(current.find(row => row.item.title === '测试真实子区域')).toMatchObject({ depth: 1, displayProgressPercent: null })
    } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps official totals separate from counts across restart, missing evidence and a newly published child', () => {
    const root = mkdtempSync(join(tmpdir(), 'gtask-map-summary-'))
    const path = join(root, 'test.sqlite')
    let db = new AppDatabase(path, { seedBundledBaselines: false })
    const reference = new Date('2026-09-15T12:00:00Z')
    const title = '莱姆尼安空洞'
    const childNames = Array.from({ length: 13 }, (_, i) => `测试子地图 ${i + 1}`)
    const sourceUrl = 'https://www.miyoushe.com/zzz/'
    const publish = (count: number, minute: number) => db.applyRemoteCatalogFeed(parseRemoteCatalogFeed({
      schemaVersion: 1, revision: `map-summary-${minute}`,
      publishedAt: new Date(reference.getTime() + minute * 60000).toISOString(),
      games: [{ gameId: 'zenless', archives: [], upserts: [
        { remoteKey: 'map:parent', category: 'exploration', title, mapNodeKind: 'region', sourceUrl },
        ...childNames.slice(0, count).map((name, i) => ({ remoteKey: `map:child:${i}`, title: name,
          category: 'exploration', mapNodeKind: 'subregion', parentRemoteKey: 'map:parent', sourceUrl }))
      ] }]
    }), new Date(reference.getTime() + minute * 60000))
    const sync = (parentProgress: number, childProgress: number[], omitParent = false) => {
      const observations = extractZenlessExplorationProgressCandidates({ area_collections: [{
        urban_area_group_id: 101, name: title, collection_progress: parentProgress,
        map_collections: childProgress.map((progress, i) => ({
          urban_area_id: i + 1, name: childNames[i], collection_progress: progress
        }))
      }] })
      const items = personalMapsFromCandidates('miyoushe', observations)
      return db.replacePersonalSnapshot('zenless', 'exploration', `test:${'a'.repeat(64)}`,
        omitParent ? items.filter(item => item.mapNodeKind !== 'region') : items, 'summary-test', reference)
    }
    const maps = () => db.listChecklistItems('zenless', { category: 'exploration' })
    const rows = () => buildMapTreeRows(maps(), new Set())
    const parent = () => rows().find(row => row.item.title === title)!
    try {
      publish(12, 0)
      sync(100, [...Array(7).fill(100), 15, 22, 32, 62, 48])
      expect(parent()).toMatchObject({ mapSummary: { completed: 7, total: 12, unknown: 0 },
        displayProgressPercent: null, item: { completed: true, progressPercent: 100, reportedProgressPercent: 100 } })
      expect(isChecklistRowComplete(parent())).toBe(false)
      expect(filterIncompleteMapTreeRows(rows())).toHaveLength(6)
      const identities = maps().map(item => [item.id, item.remoteKey])

      db.close()
      db = new AppDatabase(path, { seedBundledBaselines: false })
      expect(parent().mapSummary).toEqual({ completed: 7, total: 12, unknown: 0 })
      expect(parent().item.reportedProgressPercent).toBe(100)
      expect(maps().map(item => [item.id, item.remoteKey])).toEqual(identities)

      // Missing a leaf in a later response keeps its earlier evidence.
      sync(100, Array(7).fill(100))
      expect(parent().mapSummary).toEqual({ completed: 7, total: 12, unknown: 0 })
      sync(52, Array(12).fill(100))
      expect(parent().mapSummary).toEqual({ completed: 12, total: 12, unknown: 0 })
      expect(parent().item.reportedProgressPercent).toBe(52)
      expect(filterIncompleteMapTreeRows(rows())).toEqual([])
      const completedLeaves = maps().filter(item => item.mapNodeKind === 'subregion')

      publish(13, 1)
      expect(parent().mapSummary).toEqual({ completed: 12, total: 13, unknown: 1 })
      expect(filterIncompleteMapTreeRows(rows()).map(row => row.depth)).toEqual([0, 1])
      expect(maps().filter(item => completedLeaves.some(old => old.id === item.id)))
        .toEqual(expect.arrayContaining(completedLeaves))
      expect(parent().item.reportedProgressPercent).toBe(52)

      // An inferred average must never be labelled as an official total.
      sync(52, Array(13).fill(100), true)
      expect(parent().item.reportedProgressPercent).toBeNull()
      expect(parent().mapSummary).toEqual({ completed: 13, total: 13, unknown: 0 })
      db.close()
      db = new AppDatabase(path, { seedBundledBaselines: false })
      expect(parent().item.reportedProgressPercent).toBeNull()
      expect(filterIncompleteMapTreeRows(rows())).toEqual([])
      const leaf = maps().find(item => item.remoteKey === 'map:child:12')!
      db.setChecklistCompletion(leaf.id, false)
      expect(parent().mapSummary).toEqual({ completed: 12, total: 13, unknown: 0 })
      expect(db.getChecklistItem(leaf.id)).toMatchObject({ completed: false, progressPercent: 0 })
    } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
