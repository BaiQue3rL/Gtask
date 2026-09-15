import { performance } from 'node:perf_hooks'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database'
import type { NormalizedSyncItem } from '../src/main/sync/types'

describe.skipIf(process.env.GTASK_PERFORMANCE_TEST !== '1')('isolated performance benchmark', () => {
  it('measures a large catalog before and after bindings have been created', () => {
    const started = performance.now()
    const db = new AppDatabase(':memory:')
    const openedMs = performance.now() - started
    try {
      const sourceUrl = 'https://example.com/performance-fixture'
      const maps: NormalizedSyncItem[] = [{ remoteKey: 'perf:region', title: '性能测试地区',
        category: 'exploration', mapNodeKind: 'region', sourceUrl }]
      for (let index = 0; index < 499; index++) maps.push({ remoteKey: `perf:map:${index}`,
        title: `性能测试子区${index}`, category: 'exploration', mapNodeKind: 'subregion',
        parentRemoteKey: 'perf:region', parentTitle: '性能测试地区', sourceUrl })
      db.mergeSyncedItems('genshin', 'public_schedule', maps)
      for (let index = 0; index < 5_000; index++) db.createChecklistItem({
        gameId: 'genshin', category: 'custom', title: `性能自定义${index}` })
      const snapshot = maps.map((map, index) => ({ ...map, remoteKey: `provider:${index}`,
        progressPercent: index % 101, sourceIdentity: { provider: 'miyoushe', endpoint: 'benchmark', externalId: String(index) } }))
      const measure = (operation: () => void, count: number) => {
        const values: number[] = []
        for (let index = 0; index < count; index++) {
          const start = performance.now()
          operation()
          values.push(performance.now() - start)
        }
        const sorted = [...values].sort((a, b) => a - b)
        return { p50Ms: sorted[Math.floor(count * 0.5)], p95Ms: sorted[Math.min(count - 1, Math.floor(count * 0.95))], values }
      }
      const sync = () => db.replacePersonalSnapshot('genshin', 'exploration',
        `miyoushe:${'a'.repeat(64)}`, snapshot, 'benchmark')
      const cold = measure(sync, 1)
      const warm = measure(sync, 10)
      const reads = measure(() => { db.listChecklistItems('genshin') }, 20)
      const revisions = measure(() => { db.getChecklistRevision() }, 20)
      const metrics = { openedMs, customCount: 5_000, snapshotCount: 500, cold, warm, reads, revisions }
      mkdirSync('tmp/performance', { recursive: true })
      writeFileSync(join('tmp/performance', `${process.env.GTASK_PERFORMANCE_LABEL ?? 'current'}.json`), JSON.stringify(metrics, null, 2))
      console.log(JSON.stringify(metrics))
      expect(db.listChecklistItems('genshin').filter((item) => item.remoteKey?.startsWith('perf:'))).toHaveLength(500)
      expect(cold.p95Ms).toBeLessThan(150)
      expect(warm.p95Ms).toBeLessThan(150)
      expect(reads.p95Ms).toBeLessThan(100)
      expect(revisions.p95Ms).toBeLessThan(5)
    } finally { db.close() }
  }, 120_000)
})
