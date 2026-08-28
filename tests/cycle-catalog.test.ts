import { describe, expect, it } from 'vitest'
import type { ChecklistItem } from '../src/shared/contracts'
import {
  completePublicCycleCatalog,
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
  ] as const)('公共基准为新用户补齐 %s 周期目录', (gameId, expectedTitles) => {
    const reference = new Date('2026-08-02T01:00:00.000Z')
    const items = completePublicCycleCatalog(gameId, [], [], reference)

    expect(items.map((item) => item.title).sort()).toEqual([...expectedTitles].sort())
    expect(items.every((item) => item.completed === false)).toBe(true)
    expect(items.every((item) => item.sourceIdentity === undefined)).toBe(true)
    expect(items.every((item) =>
      Boolean(item.startsAt) &&
      Boolean(item.endsAt) &&
      Date.parse(item.startsAt!) <= reference.getTime() &&
      Date.parse(item.endsAt!) > reference.getTime()
    )).toBe(true)
  })

  it('公共维护规范化已知玩法并补齐其余稳定目录', () => {
    const items = completePublicCycleCatalog(
      'star-rail',
      [{
        remoteKey: 'official:any-name',
        category: 'endgame',
        title: '虚构叙事·某一期',
        modeKey: 'pure-fiction',
        startsAt: '2026-06-22T20:00:00.000Z',
        endsAt: '2026-08-03T20:00:00.000Z',
        periodKey: 'star-rail:pure-fiction:official-1'
      }],
      [],
      new Date('2026-08-01T00:00:00.000Z')
    )

    expect(items).toHaveLength(4)
    expect(items.find((item) => item.modeKey === 'pure-fiction')).toMatchObject({
      remoteKey: 'endgame:pure-fiction',
      title: '虚构叙事',
      periodKey: 'star-rail:pure-fiction:official-1'
    })
  })

  it('公开来源提前给出未来周期时仍保留当前稳定目录', () => {
    const reference = new Date('2026-08-02T01:00:00.000Z')
    const items = completePublicCycleCatalog(
      'genshin',
      [{
        remoteKey: 'endgame:imaginarium-theater',
        category: 'endgame',
        title: '幻想真境剧诗',
        modeKey: 'imaginarium-theater',
        periodKey: 'future',
        startsAt: '2026-08-31T20:00:00.000Z',
        endsAt: '2026-09-30T20:00:00.000Z'
      }],
      [],
      reference
    )
    const theater = items.filter((item) => item.modeKey === 'imaginarium-theater')

    expect(theater).toHaveLength(1)
    expect(Date.parse(theater[0].startsAt!)).toBeLessThanOrEqual(reference.getTime())
    expect(Date.parse(theater[0].endsAt!)).toBeGreaterThan(reference.getTime())
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

  it('过期基准换期仍按固定锚点与周期计算', () => {
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

  it('终焉矩阵跟随当前版本第七天开启并在下次维护时结束', () => {
    const definition = listCycleModes('wuthering-waves').find(
      (candidate) => candidate.modeKey === 'endstate-matrix'
    )!
    const versionWindow = {
      startsAt: '2026-08-20T11:00:00+08:00',
      endsAt: '2026-09-30T04:00:00+08:00'
    }
    const window = predictCycleWindow(
      definition,
      new Date('2026-08-27T20:00:00+08:00'),
      {
        startsAt: '2026-08-28T04:00:00+08:00',
        endsAt: '2026-10-01T04:00:00+08:00'
      },
      versionWindow
    )

    expect(window).toEqual({
      startsAt: '2026-08-26T20:00:00.000Z',
      endsAt: '2026-09-29T20:00:00.000Z'
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
