import { describe, expect, it } from 'vitest'
import type { ChecklistItem } from '../src/shared/contracts'
import {
  completeCycleCatalog,
  findCycleMode,
  listCycleModes,
  nextCyclePeriod,
  predictCycleWindow
} from '../src/main/sync/cycle-catalog'

describe('cycle catalog', () => {
  it.each([
    ['genshin', ['深境螺旋', '幻想真境剧诗', '幽境危战']],
    ['star-rail', ['混沌回忆', '虚构叙事', '末日幻影', '异相仲裁']],
    ['zenless', ['式舆防卫战', '危局强袭战']],
    ['wuthering-waves', ['逆境深塔', '冥歌海墟', '终焉矩阵']]
  ] as const)('新用户没有任何挑战记录时仍补齐 %s 基准目录', (gameId, expectedTitles) => {
    const reference = new Date('2026-08-02T01:00:00.000Z')
    const items = completeCycleCatalog(gameId, [], [], 'personal_sync', reference)

    expect(items.map((item) => item.title).sort()).toEqual([...expectedTitles].sort())
    expect(items.every((item) => item.completed === false)).toBe(true)
    expect(items.every((item) => item.sourceIdentity?.provider === 'gtask-cycle-catalog')).toBe(true)
    expect(items.every((item) =>
      Boolean(item.startsAt) &&
      Boolean(item.endsAt) &&
      Date.parse(item.startsAt!) <= reference.getTime() &&
      Date.parse(item.endsAt!) > reference.getTime()
    )).toBe(true)
  })

  it('为缺少战绩的固定模式补齐稳定名称和预测周期', () => {
    const items = completeCycleCatalog(
      'star-rail',
      [{
        remoteKey: 'official:any-name',
        category: 'endgame',
        title: '虚构叙事·某一期',
        modeKey: 'pure-fiction',
        completed: true,
        startsAt: '2026-06-22T20:00:00.000Z',
        endsAt: '2026-08-03T20:00:00.000Z',
        periodKey: 'star-rail:pure-fiction:official-1'
      }],
      [],
      'personal_sync',
      new Date('2026-08-01T00:00:00.000Z')
    )

    expect(items).toHaveLength(4)
    expect(items.find((item) => item.modeKey === 'pure-fiction')).toMatchObject({
      remoteKey: 'endgame:pure-fiction',
      title: '虚构叙事',
      completed: true,
      periodKey: 'star-rail:pure-fiction:official-1'
    })
    const missing = items.filter((item) => item.modeKey !== 'pure-fiction')
    expect(missing.every((item) => item.completed === false)).toBe(true)
    expect(missing.every((item) => item.sourceIdentity?.provider === 'gtask-cycle-catalog')).toBe(true)
  })

  it('官方返回手动挑战记录时即使周期窗口不完整也判定已完成', () => {
    const reference = new Date('2026-08-02T01:00:00.000Z')
    const incoming = {
      remoteKey: 'endgame:endstate-matrix',
      category: 'endgame' as const,
      title: '终焉矩阵',
      completed: true,
      startsAt: null,
      endsAt: '2026-08-19T23:59:59.000Z',
      modeKey: 'endstate-matrix',
      periodKey: 'wuthering-waves:endstate-matrix:2026-08-19T23:59:59.000Z'
    }

    const first = completeCycleCatalog(
      'wuthering-waves', [incoming], [], 'personal_sync', reference
    )
    expect(first.find((item) => item.modeKey === 'endstate-matrix')).toMatchObject({
      completed: true,
      endsAt: incoming.endsAt
    })

    const existing = [{
      ...incoming,
      id: 'existing-matrix',
      gameId: 'wuthering-waves' as const,
      startsAt: '2026-07-17T04:00:00+08:00',
      source: 'personal_sync' as const
    }] as ChecklistItem[]
    const repeated = completeCycleCatalog(
      'wuthering-waves', [incoming], existing, 'personal_sync', reference
    )
    expect(repeated.find((item) => item.modeKey === 'endstate-matrix')?.completed).toBe(true)
  })

  it('按固定锚点只生成当前一期，不回填中间遗漏期', () => {
    const definition = listCycleModes('zenless').find(
      (candidate) => candidate.modeKey === 'shiyu-defense'
    )!
    const window = predictCycleWindow(definition, new Date('2026-08-01T12:00:00.000Z'))
    expect(window).not.toBeNull()
    expect(Date.parse(window!.startsAt)).toBeLessThanOrEqual(Date.parse('2026-08-01T12:00:00.000Z'))
    expect(Date.parse(window!.endsAt)).toBeGreaterThan(Date.parse('2026-08-01T12:00:00.000Z'))
  })

  it.each([
    {
      gameId: 'genshin' as const,
      modeKey: 'imaginarium-theater',
      title: '幻想真境剧诗',
      startsAt: '2026-07-01T20:00:00.000Z',
      endsAt: '2026-07-31T20:00:00.000Z'
    },
    {
      gameId: 'wuthering-waves' as const,
      modeKey: 'endstate-matrix',
      title: '终焉矩阵',
      startsAt: '2026-07-04T20:00:00.000Z',
      endsAt: '2026-08-01T20:00:00.000Z'
    }
  ])('过期的 $title 只作为学习依据并另建当前期占位', (observed) => {
    const reference = new Date('2026-08-02T01:00:00.000Z')
    const items = completeCycleCatalog(
      observed.gameId,
      [{
        remoteKey: `endgame:${observed.modeKey}`,
        category: 'endgame',
        title: observed.title,
        completed: true,
        modeKey: observed.modeKey,
        periodKey: `${observed.gameId}:${observed.modeKey}:expired`,
        startsAt: observed.startsAt,
        endsAt: observed.endsAt,
        sourceIdentity: {
          provider: 'official-provider', endpoint: 'challenge', externalId: 'expired'
        }
      }],
      [],
      'personal_sync',
      reference
    )
    const sameMode = items.filter((item) => item.modeKey === observed.modeKey)
    const current = sameMode.filter((item) =>
      (!item.startsAt || Date.parse(item.startsAt) <= reference.getTime()) &&
      (!item.endsAt || Date.parse(item.endsAt) > reference.getTime())
    )

    expect(sameMode).toHaveLength(2)
    expect(current).toEqual([expect.objectContaining({
      title: observed.title,
      completed: false,
      sourceIdentity: expect.objectContaining({ provider: 'gtask-cycle-catalog' })
    })])
    expect(current[0].startsAt).not.toBeNull()
    expect(Date.parse(current[0].endsAt!)).toBeGreaterThan(reference.getTime())
  })

  it('已公布但尚未开始的未来周期不进入清单，固定目录仍生成当前期', () => {
    const reference = new Date('2026-08-02T01:00:00.000Z')
    const items = completeCycleCatalog(
      'genshin',
      [{
        remoteKey: 'official:future-theater',
        category: 'endgame',
        title: '幻想真境剧诗·下一期',
        completed: false,
        modeKey: 'imaginarium-theater',
        periodKey: 'future',
        startsAt: '2026-08-31T20:00:00.000Z',
        endsAt: '2026-09-30T20:00:00.000Z'
      }],
      [],
      'personal_sync',
      reference
    )
    const theater = items.filter((item) => item.modeKey === 'imaginarium-theater')

    expect(theater).toHaveLength(1)
    expect(theater[0]).toMatchObject({
      title: '幻想真境剧诗',
      completed: false,
      sourceIdentity: expect.objectContaining({ provider: 'gtask-cycle-catalog' })
    })
    expect(Date.parse(theater[0].startsAt!)).toBeLessThanOrEqual(reference.getTime())
    expect(Date.parse(theater[0].endsAt!)).toBeGreaterThan(reference.getTime())
  })

  it('过期观测只用于识别模式，换期仍按固定锚点与周期计算', () => {
    const previous = {
      modeKey: 'tower-of-adversity',
      remoteKey: 'endgame:tower-of-adversity',
      title: '逆境深塔',
      startsAt: '2026-06-01T20:00:00.000Z',
      endsAt: '2026-06-29T20:00:00.000Z'
    } as ChecklistItem
    const next = nextCyclePeriod(
      'wuthering-waves',
      previous,
      new Date('2026-08-01T00:00:00.000Z')
    )
    expect(next).toMatchObject({
      startsAt: '2026-07-19T20:00:00.000Z',
      endsAt: '2026-08-16T20:00:00.000Z'
    })
  })

  it('带空档的周期不会拿上一期持续时间首尾相接', () => {
    const previous = {
      modeKey: 'stygian-onslaught',
      remoteKey: 'endgame:stygian-onslaught',
      title: '幽境危战',
      startsAt: '2026-07-08T10:00:00+08:00',
      endsAt: '2026-08-11T04:00:00+08:00'
    } as ChecklistItem

    expect(nextCyclePeriod(
      'genshin',
      previous,
      new Date('2026-08-13T12:00:00+08:00')
    )).toMatchObject({
      startsAt: '2026-08-19T02:00:00.000Z',
      endsAt: '2026-09-21T20:00:00.000Z'
    })
  })

  it('只按稳定模式或明确别名识别，不猜测未知玩法', () => {
    expect(findCycleMode('genshin', {
      remoteKey: 'unknown', modeKey: null, title: '深境螺旋'
    })?.modeKey).toBe('spiral-abyss')
    expect(findCycleMode('genshin', {
      remoteKey: 'unknown', modeKey: null, title: '全新未知挑战'
    })).toBeNull()
  })
})
