import { describe, expect, it } from 'vitest'
import { compileCatalogDelta } from '../src/main/catalog-compiler'
import { validateCatalogPublication } from '../src/main/catalog-validation'

const base = { schemaVersion: 1, revision: 'compiler.base', publishedAt: '2026-09-14T00:00:00Z',
  games: [{ gameId: 'genshin', upserts: [], archives: ['event:retired-before'] }] }
const event = { remoteKey: 'event:compiler-fixture', title: '编译测试活动', category: 'limited_event',
  startsAt: '2026-09-14T00:00:00Z', endsAt: '2026-10-01T00:00:00Z', activityTags: ['combat'], sourceUrl: 'https://example.com/official' }
const delta = { schemaVersion: 1, revision: 'compiler.new', publishedAt: '2026-09-15T00:00:00Z',
  games: [{ gameId: 'genshin', upserts: [event], archives: [] }] }

describe('public catalog compiler', () => {
  it('preserves prior retirements, emits the same feed for bundled and remote consumers, and avoids unchanged republication', () => {
    const result = compileCatalogDelta(base, delta)
    expect(result.changed).toBe(true)
    expect(result.feed.games[0].archives).toEqual(['event:retired-before'])
    expect(result.feed.games[0].upserts).toEqual([event])
    const unchanged = compileCatalogDelta(result.feed, { ...delta, revision: 'unused', publishedAt: '2026-09-16T00:00:00Z' })
    expect(unchanged.changed).toBe(false)
    expect(unchanged.feed.revision).toBe('compiler.new')
    expect(base.games[0].upserts).toEqual([])
  })
  it('requires explicit retirement and a new publication identity, rejecting private progress fields', () => {
    expect(() => compileCatalogDelta(base, { ...delta, publishedAt: base.publishedAt })).toThrow('发布时间')
    expect(() => compileCatalogDelta(base, { ...delta, revision: base.revision })).toThrow('修订')
    expect(() => compileCatalogDelta(base, { ...delta, games: [{ gameId: 'genshin', upserts: [{ ...event, completed: true }] }] })).toThrow()
    const first = compileCatalogDelta(base, delta).feed
    const retired = compileCatalogDelta(first, { ...delta, revision: 'compiler.retired', publishedAt: '2026-09-16T00:00:00Z',
      games: [{ gameId: 'genshin', archives: [event.remoteKey] }] }).feed
    expect(retired.games[0].upserts).toEqual([])
    expect(retired.games[0].archives).toEqual(['event:retired-before', event.remoteKey])
  })
  it('exports only public inventory from a temporary consumer', () => {
    const inspection = validateCatalogPublication(base, { inventory: true })
    expect(inspection.inventory).toHaveLength(4)
    const serialized = JSON.stringify(inspection.inventory)
    for (const privateField of ['"completed":', '"progressPercent":', '"credential":', '"sourceIdentity":', '"manualCompletionLocked":']) {
      expect(serialized).not.toContain(privateField)
    }
  })

  it('compiles another game after a retained version exception has ended', () => {
    const versionWindow = { periodKey: '4.6', startsAt: '2026-09-28T06:00:00+08:00',
      endsAt: '2026-11-11T06:00:00+08:00', timeZone: 'Asia/Shanghai', confidence: 1,
      sourceUrl: 'https://example.com/official-version' }
    const historical = { ...base, publishedAt: '2026-09-29T00:00:00Z',
      games: [...base.games, { gameId: 'star-rail', versionWindow, upserts: [], archives: [] }] }
    const next = { ...delta, publishedAt: '2026-11-12T03:00:00Z' }
    const result = compileCatalogDelta(historical, { ...next,
      games: [{ gameId: 'wuthering-waves', upserts: [{ ...event, startsAt: '2026-11-12T03:00:00Z',
        endsAt: '2026-12-01T00:00:00Z' }] }] })
    expect(result.changed).toBe(true)
    expect(result.feed.games.find((game) => game.gameId === 'star-rail')?.versionWindow).toEqual(versionWindow)
    expect(result.feed.games.find((game) => game.gameId === 'genshin')?.archives).toEqual(base.games[0].archives)
    expect(result.validation.receipt?.revision).toBe(delta.revision)
    expect(() => compileCatalogDelta(historical, { ...next, games: [{ gameId: 'star-rail',
      versionWindow: { ...versionWindow, startsAt: '2026-12-01T00:00:00Z', endsAt: '2027-01-01T00:00:00Z' } }] }))
      .toThrow('当前已经开始')
    expect(() => compileCatalogDelta(historical, { ...next, games: [{ gameId: 'star-rail',
      versionWindow: { ...versionWindow, endsAt: versionWindow.startsAt } }] })).toThrow('开始时间')
  })
})
