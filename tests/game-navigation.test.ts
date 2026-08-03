import { describe, expect, it } from 'vitest'
import type { GameSummary, GameVersionSummary } from '../src/shared/contracts'
import {
  formatGameVersionRemaining,
  isGameVersionDeadlineUrgent,
  orderGamesByVersion
} from '../src/renderer/src/game-navigation'

const games: GameSummary[] = [
  { id: 'genshin', name: '原神', shortName: '原神', accent: '#fff', sortOrder: 10, enabled: true },
  { id: 'star-rail', name: '崩坏：星穹铁道', shortName: '星铁', accent: '#fff', sortOrder: 20, enabled: true },
  { id: 'zenless', name: '绝区零', shortName: '绝区零', accent: '#fff', sortOrder: 30, enabled: true },
  { id: 'wuthering-waves', name: '鸣潮', shortName: '鸣潮', accent: '#fff', sortOrder: 40, enabled: true }
]

describe('sidebar game navigation', () => {
  it('orders active versions from nearest expiry and leaves unknown versions in product order', () => {
    const now = Date.parse('2026-08-03T12:00:00.000Z')
    const versions: GameVersionSummary[] = [
      { gameId: 'genshin', endsAt: '2026-08-13T12:00:00.000Z' },
      { gameId: 'star-rail', endsAt: null },
      { gameId: 'zenless', endsAt: '2026-08-08T12:00:00.000Z' },
      { gameId: 'wuthering-waves', endsAt: '2026-08-02T12:00:00.000Z' }
    ]

    expect(orderGamesByVersion(games, versions, now).map((game) => game.id)).toEqual([
      'zenless',
      'genshin',
      'star-rail',
      'wuthering-waves'
    ])
  })

  it('formats a compact days-and-hours countdown and hides unavailable windows', () => {
    const now = Date.parse('2026-08-03T12:20:00.000Z')
    expect(formatGameVersionRemaining('2026-08-05T15:05:00.000Z', now))
      .toBe('版本剩余 2 天 3 小时')
    expect(formatGameVersionRemaining(null, now)).toBeNull()
    expect(formatGameVersionRemaining('2026-08-03T12:00:00.000Z', now)).toBeNull()
    expect(isGameVersionDeadlineUrgent('2026-08-06T12:19:59.000Z', now)).toBe(true)
    expect(isGameVersionDeadlineUrgent('2026-08-06T12:20:00.000Z', now)).toBe(false)
  })
})
