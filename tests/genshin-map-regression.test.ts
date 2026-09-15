import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { parseGenshinPersonalData, extractGenshinExplorationProgressCandidates } from '../src/main/sync/genshin-personal-parser'
import { personalMapsFromCandidates } from '../src/main/sync/personal-snapshot'
import { buildMapTreeRows, filterIncompleteMapTreeRows } from '../src/renderer/src/map-tree'
import { isChecklistItemComplete } from '../src/renderer/src/checklist-completion'

// Only map fields, from the endpoint shape observed on 2026-09-15.
const profile = () => ({ world_explorations: [
  { id: 2, parent_id: 0, name: '璃月', type: 'Reputation', exploration_percentage: 1000 },
  { id: 10, parent_id: 0, name: '沉玉谷', type: 'Offering', exploration_percentage: 0 },
  { id: 11, parent_id: 10, name: '来歆山', type: 'TypeUnknow', exploration_percentage: 1000 },
  { id: 12, parent_id: 10, name: '沉玉谷·南陵', type: 'TypeUnknow', exploration_percentage: 1000 },
  { id: 13, parent_id: 10, name: '沉玉谷·上谷', type: 'TypeUnknow', exploration_percentage: 1000 },
  { id: 20, parent_id: 0, name: '至冬', type: 'Reputation', exploration_percentage: 520,
    area_exploration_list: ['古兽冰原', '白桦雪葬地', '永凝冻土', '焰羽谷', '霜殛寒峰']
      .map(name => ({ name, exploration_percentage: 1050 })) }
] })

const normalize = (input: ReturnType<typeof profile>) => personalMapsFromCandidates(
  'miyoushe', extractGenshinExplorationProgressCandidates(input)
)

describe('Genshin map acceptance regressions', () => {
  it('only the verified Chenyu grouping zero uses its complete child coverage', () => {
    const input = profile()
    expect(normalize(input).find(item => item.title === '沉玉谷')).toMatchObject({ completed: true, progressPercent: 100 })
    expect(parseGenshinPersonalData({ profile: input }).find(item => item.title === '沉玉谷'))
      .toMatchObject({ completed: true, progressPercent: 100 })
    input.world_explorations[1].type = 'Reputation'
    expect(normalize(input).find(item => item.title === '沉玉谷')).toMatchObject({ completed: false, progressPercent: 0 })
    input.world_explorations[1].type = 'Offering'
    input.world_explorations[1].exploration_percentage = 600
    expect(normalize(input).find(item => item.title === '沉玉谷')).toMatchObject({ completed: false, progressPercent: 60 })
  })

  it.each(['missing', 'duplicate', 'unexpected'] as const)('%s child coverage cannot claim aggregate completion', kind => {
    const input = profile()
    if (kind === 'missing') input.world_explorations.splice(4, 1)
    if (kind === 'duplicate') input.world_explorations.push({ ...input.world_explorations[2] })
    if (kind === 'unexpected') input.world_explorations.push({ ...input.world_explorations[2], id: 99 })
    expect(normalize(input).some(item => item.title === '沉玉谷')).toBe(false)
    expect(parseGenshinPersonalData({ profile: input }).find(item => item.title === '沉玉谷'))
      .toMatchObject({ completed: undefined, progressPercent: null })
  })

  it('sync keeps canonical hierarchy and country totals, while aggregate completion can recover and reopen', () => {
    const database = new AppDatabase(':memory:')
    const apply = (input: ReturnType<typeof profile>) => database.replacePersonalSnapshot(
      'genshin', 'exploration', `miyoushe:${'a'.repeat(64)}`, normalize(input), 'genshin-map-regression'
    )
    const get = (title: string) => database.listChecklistItems('genshin').find(item => item.title === title)!
    try {
      const original = get('沉玉谷')
      const originalKey = original.remoteKey
      const parentKey = get('璃月').remoteKey
      apply(profile())
      expect(get('沉玉谷')).toMatchObject({ id: original.id, remoteKey: originalKey,
        mapNodeKind: 'subregion', parentTitle: '璃月', parentRemoteKey: parentKey, completed: true, progressPercent: 100 })
      expect(get('至冬')).toMatchObject({ completed: false, progressPercent: 52 })
      expect(database.listChecklistItems('genshin').filter(item => item.parentTitle === '至冬'))
        .toHaveLength(5)
      const missing = profile()
      missing.world_explorations.splice(4, 1)
      apply(missing)
      expect(get('沉玉谷')).toMatchObject({ completed: true, progressPercent: 100 })

      const incomplete = profile()
      incomplete.world_explorations[2].exploration_percentage = 500
      apply(incomplete)
      expect(get('沉玉谷')).toMatchObject({ completed: false, progressPercent: null })
      expect(isChecklistItemComplete(get('沉玉谷'))).toBe(false)
      const maps = database.listChecklistItems('genshin', { category: 'exploration' })
      const rows = filterIncompleteMapTreeRows(buildMapTreeRows(
        maps.filter(item => !isChecklistItemComplete(item)), new Set(), maps, false
      ))
      expect(rows.find(row => row.item.title === '沉玉谷')).toMatchObject({ parentContext: '璃月' })
      expect(rows.some(row => row.item.parentTitle === '至冬')).toBe(false)
      expect(rows.find(row => row.item.title === '至冬')?.displayProgressPercent).toBe(52)

      apply(profile())
      expect(get('沉玉谷')).toMatchObject({ completed: true, progressPercent: 100 })
      database.updateChecklistItem({ id: original.id, completed: true })
      apply(incomplete)
      expect(get('沉玉谷')).toMatchObject({ completed: true, progressPercent: 100, manualCompletionLocked: true })
    } finally { database.close() }
  })
})
