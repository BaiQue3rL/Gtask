import { describe, expect, it, vi } from 'vitest'
import { SingleFlight } from '../src/main/single-flight'
import { persistUpdateCache } from '../src/main/update-cache'
import { AppDatabase } from '../src/main/database'

describe('update completion boundaries', () => {
  it('commits once for overlapping requests and permits a later retry after failure', async () => {
    const flight = new SingleFlight<number>()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    let commits = 0
    const work = vi.fn(async () => { await wait; return ++commits })
    const requests = Array.from({ length: 20 }, () => flight.run(work))
    release()
    expect(await Promise.all(requests)).toEqual(Array(20).fill(1))
    expect(work).toHaveBeenCalledOnce()
    await expect(flight.run(async () => { throw new Error('offline') })).rejects.toThrow('offline')
    await expect(flight.run(async () => ++commits)).resolves.toBe(2)
  })
  it('keeps a real committed catalog receipt authoritative when the cooldown file cannot be written', () => {
    const db = new AppDatabase(':memory:')
    try {
      db.applyRemoteCatalogFeed({ schemaVersion: 1, revision: 'cache-failure-fixture', publishedAt: new Date().toISOString(),
        games: [{ gameId: 'genshin', upserts: [], archives: [] }] })
      const receipt = db.getRemoteCatalogReceipt()
      const report = vi.fn()
      const state = persistUpdateCache(receipt, () => { throw new Error('disk full') }, report)
      expect(state?.revision).toBe('cache-failure-fixture')
      expect(db.getRemoteCatalogReceipt()).toEqual(receipt)
      expect(report).toHaveBeenCalledOnce()
    } finally { db.close() }
  })
})
