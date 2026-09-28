import { afterEach, describe, expect, it, vi } from 'vitest'
import catalog from '../updates/catalog.json'
import { AppDatabase } from '../src/main/database'
import { parseRemoteCatalogFeed } from '../src/main/remote-catalog-update'

const sourceUrl = 'https://www.taptap.cn/moment/841375445998898274'
const publication = { ...catalog, games: catalog.games.filter(game => game.gameId === 'star-rail') }
const instant = (value: string) => new Date(value).toISOString()
const modes = [
  ['memory-of-chaos', '混沌回忆', '2026-08-17T04:00:00+08:00', '2026-09-28T19:00:00+08:00'],
  ['pure-fiction', '虚构叙事', '2026-09-14T04:00:00+08:00', '2026-10-26T04:00:00+08:00'],
  ['apocalyptic-shadow', '末日幻影', '2026-08-31T04:00:00+08:00', '2026-10-05T04:00:00+08:00'],
  ['anomaly-arbitration', '异相仲裁', '2026-08-26T06:00:00+08:00', '2026-10-07T06:00:00+08:00']
]

function previousDatabase() {
  vi.useFakeTimers()
  vi.setSystemTime('2026-09-28T10:55:00Z')
  const db = new AppDatabase(':memory:', { seedBundledBaselines: false })
  db.applyRemoteCatalogFeed(parseRemoteCatalogFeed({ schemaVersion: 1, revision: 'fixture.previous',
    publishedAt: '2026-09-24T14:26:41Z', games: [{ gameId: 'star-rail', upserts: modes.map(([mode, title, start, end]) => ({
      remoteKey: `endgame:${mode}`, modeKey: mode, title, category: 'endgame', sourceUrl,
      startsAt: instant(start), endsAt: instant(end), periodKey: `predicted:star-rail:${mode}:${instant(start)}`
    })) }] }))
  return db
}

afterEach(() => vi.useRealTimers())
describe('Star Rail 4.6 exceptional public schedule publication', () => {
  it('resets expired modes, preserves an active completed period, and keeps one stable row per mode', () => {
    const db = previousDatabase()
    try {
      const before = db.listChecklistItems('star-rail')
      for (const item of before) db.setChecklistCompletion(item.id, true)
      vi.setSystemTime(publication.publishedAt)
      db.applyRemoteCatalogFeed(parseRemoteCatalogFeed(publication))
      const cycles = db.listChecklistItems('star-rail').filter(item => item.category === 'endgame')
      expect(cycles).toHaveLength(4)
      for (const item of before) expect(cycles.find(row => row.modeKey === item.modeKey)?.id).toBe(item.id)
      const byMode = (mode: string) => cycles.find(item => item.modeKey === mode)!
      expect(byMode('memory-of-chaos')).toMatchObject({ completed: false, manualCompletionLocked: false,
        periodKey: 'star-rail:memory-of-chaos:1035' })
      expect(instant(byMode('memory-of-chaos').endsAt!)).toBe('2026-11-01T20:00:00.000Z')
      expect(byMode('anomaly-arbitration')).toMatchObject({ completed: false, periodKey: 'star-rail:anomaly-arbitration:10' })
      expect(instant(byMode('anomaly-arbitration').endsAt!)).toBe('2026-11-10T22:00:00.000Z')
      expect(byMode('pure-fiction')).toMatchObject({ completed: true, manualCompletionLocked: true,
        periodKey: 'predicted:star-rail:pure-fiction:2026-09-13T20:00:00.000Z' })
      expect(instant(byMode('pure-fiction').endsAt!)).toBe('2026-10-18T20:00:00.000Z')
      expect(byMode('apocalyptic-shadow').completed).toBe(true)
      expect(instant(db.getRelevantGameVersionWindow('star-rail')!.endsAt)).toBe('2026-11-10T22:00:00.000Z')
    } finally { db.close() }
  })

  it('calibrates an already rolled Memory of Chaos without clearing its completion', () => {
    const db = previousDatabase()
    try {
      vi.setSystemTime(publication.publishedAt)
      db.rolloverDueCycleItems()
      const memory = db.listChecklistItems('star-rail').find(item => item.modeKey === 'memory-of-chaos')!
      db.setChecklistCompletion(memory.id, true)
      db.applyRemoteCatalogFeed(parseRemoteCatalogFeed(publication))
      expect(db.getChecklistItem(memory.id)).toMatchObject({ completed: true, manualCompletionLocked: true,
        periodKey: 'star-rail:memory-of-chaos:1035' })
    } finally { db.close() }
  })

  it('uses the new anchors at each boundary and does not rewind on later cumulative publications', () => {
    const db = previousDatabase()
    try {
      vi.setSystemTime(publication.publishedAt)
      db.applyRemoteCatalogFeed(parseRemoteCatalogFeed(publication))
      for (const [boundary, mode, end] of [
        ['2026-10-05T04:00:00+08:00', 'apocalyptic-shadow', '2026-11-16T04:00:00+08:00'],
        ['2026-10-19T04:00:00+08:00', 'pure-fiction', '2026-11-30T04:00:00+08:00'],
        ['2026-11-02T04:00:00+08:00', 'memory-of-chaos', '2026-12-14T04:00:00+08:00'],
        ['2026-11-11T06:00:00+08:00', 'anomaly-arbitration', '2026-12-23T06:00:00+08:00']
      ]) {
        vi.setSystemTime(boundary)
        db.rolloverDueCycleItems()
        const item = db.listChecklistItems('star-rail').find(row => row.modeKey === mode)!
        expect(instant(item.startsAt!)).toBe(instant(boundary))
        expect(instant(item.endsAt!)).toBe(instant(end))
        db.setChecklistCompletion(item.id, true)
      }
      // A later unrelated publication retains the original verified version exception.
      // Apply with its original publication time: it cannot represent a future verification of an expired version.
      db.applyRemoteCatalogFeed(parseRemoteCatalogFeed({ ...publication, revision: `${publication.revision}.reapply` }))
      for (const item of db.listChecklistItems('star-rail').filter(row => row.category === 'endgame')) {
        expect(item.completed).toBe(true)
      }
    } finally { db.close() }
  })
})
