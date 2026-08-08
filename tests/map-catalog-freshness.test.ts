import { describe, expect, it } from 'vitest'
import {
  evaluateMapCatalogFreshness,
  selectRelevantVersionWindow
} from '../src/main/sync/map-catalog-freshness'

describe('map catalog freshness', () => {
  it('uses the active game version window instead of a future or expired duplicate', () => {
    const selected = selectRelevantVersionWindow([
      {
        periodKey: '3.4',
        startsAt: '2026-06-01T00:00:00.000Z',
        endsAt: '2026-07-01T00:00:00.000Z'
      },
      {
        periodKey: '3.5',
        startsAt: '2026-07-01T00:00:00.000Z',
        endsAt: '2026-08-12T00:00:00.000Z'
      },
      {
        periodKey: '3.6',
        startsAt: '2026-08-20T00:00:00.000Z',
        endsAt: '2026-10-01T00:00:00.000Z'
      }
    ], new Date('2026-07-31T00:00:00.000Z'))

    expect(selected).toEqual({
      periodKey: '3.5',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-08-12T00:00:00.000Z'
    })
  })

  it('does not start Codex again while the bundled catalog was verified in this version', () => {
    expect(evaluateMapCatalogFreshness({
      bundledVerifiedAt: '2026-07-30T00:00:00.000Z',
      lastCodexAuditAt: null,
      versionWindow: {
        periodKey: '3.5',
        startsAt: '2026-07-01T00:00:00.000Z',
        endsAt: '2026-08-12T00:00:00.000Z'
      },
      reference: new Date('2026-07-31T00:00:00.000Z')
    })).toMatchObject({ shouldAudit: false, reason: 'catalog_current' })
  })

  it('requests one incremental audit after a new version starts', () => {
    expect(evaluateMapCatalogFreshness({
      bundledVerifiedAt: '2026-07-30T00:00:00.000Z',
      lastCodexAuditAt: null,
      versionWindow: {
        periodKey: '3.6',
        startsAt: '2026-08-12T00:00:00.000Z',
        endsAt: '2026-09-23T00:00:00.000Z'
      },
      reference: new Date('2026-08-13T00:00:00.000Z')
    })).toMatchObject({ shouldAudit: true, reason: 'version_started' })
  })

  it('does not repeat a boundary audit that already completed after the version ended', () => {
    expect(evaluateMapCatalogFreshness({
      bundledVerifiedAt: '2026-07-01T00:00:00.000Z',
      lastCodexAuditAt: '2026-08-12T01:00:00.000Z',
      versionWindow: {
        periodKey: '3.5',
        startsAt: '2026-07-01T00:00:00.000Z',
        endsAt: '2026-08-12T00:00:00.000Z'
      },
      reference: new Date('2026-08-13T00:00:00.000Z')
    })).toMatchObject({ shouldAudit: false, reason: 'catalog_current' })
  })

  it('falls back to a bounded age check when version timing is unavailable', () => {
    expect(evaluateMapCatalogFreshness({
      bundledVerifiedAt: '2026-06-01T00:00:00.000Z',
      lastCodexAuditAt: null,
      versionWindow: null,
      reference: new Date('2026-07-31T00:00:00.000Z')
    })).toMatchObject({ shouldAudit: true, reason: 'catalog_age_limit' })
  })
})
