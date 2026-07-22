import { describe, expect, it } from 'vitest'
import { StarRailPersonalAdapter } from '../src/main/sync/star-rail-personal-adapter'
import { parseStarRailPersonalData } from '../src/main/sync/star-rail-personal-parser'

const season = (scheduleId: number, name: string) => ({
  schedule_id: scheduleId,
  name_mi18n: name,
  status: 'STATUS_CURRENT',
  begin_time: { year: 2026, month: 7, day: 20, hour: 4, minute: 0, second: 0 },
  end_time: { year: 2026, month: 8, day: 3, hour: 3, minute: 59, second: 59 }
})

const payload = {
  memoryOfChaos: {
    star_num: 33,
    extra_star_num: 0,
    max_floor: '12',
    has_data: true,
    all_floor_detail: [],
    groups: [season(101, '混沌回忆')]
  },
  pureFiction: {
    star_num: 9,
    max_floor: '03',
    has_data: true,
    all_floor_detail: [],
    groups: [season(102, '虚构叙事')]
  },
  apocalypticShadow: {
    star_num: 12,
    max_floor: '04',
    has_data: true,
    all_floor_detail: [],
    groups: [season(103, '末日幻影')]
  },
  anomalyArbitration: {
    challenge_peak_records: [{
      group: {
        group_id: 104,
        name_mi18n: '异相仲裁',
        status: 'STATUS_CURRENT',
        begin_time: { year: 2026, month: 7, day: 1, hour: 4, minute: 0, second: 0 },
        end_time: { year: 2026, month: 8, day: 1, hour: 3, minute: 59, second: 59 }
      },
      has_challenge_record: true,
      boss_record: { has_challenge_record: true },
      mob_records: [
        { has_challenge_record: true },
        { has_challenge_record: true },
        { has_challenge_record: true }
      ],
      boss_stars: 3,
      mob_stars: 9
    }]
  }
}

describe('Star Rail personal parsing', () => {
  it('maps all four endgame modes without requiring full stars for completion', () => {
    const items = parseStarRailPersonalData(payload)

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        modeKey: 'memory-of-chaos',
        periodKey: 'star-rail:memory-of-chaos:101',
        progressPercent: 91.67,
        completed: true,
        startsAt: '2026-07-19T20:00:00.000Z'
      }),
      expect.objectContaining({ modeKey: 'pure-fiction', progressPercent: 75, completed: false }),
      expect.objectContaining({ modeKey: 'apocalyptic-shadow', progressPercent: 100, completed: true }),
      expect.objectContaining({ modeKey: 'anomaly-arbitration', progressPercent: 100, completed: true })
    ]))
  })

  it('the adapter requests each source sequentially and rejects other games', async () => {
    const order: string[] = []
    const client = {
      getMemoryOfChaos: async () => { order.push('memory'); return payload.memoryOfChaos },
      getPureFiction: async () => { order.push('fiction'); return payload.pureFiction },
      getApocalypticShadow: async () => { order.push('shadow'); return payload.apocalypticShadow },
      getAnomalyArbitration: async () => { order.push('arbitration'); return payload.anomalyArbitration }
    }
    const adapter = new StarRailPersonalAdapter(client)

    const result = await adapter.sync('star-rail')
    expect(order).toEqual(['memory', 'fiction', 'shadow', 'arbitration'])
    expect(result.items).toHaveLength(4)
    await expect(adapter.sync('genshin')).rejects.toThrow('不能用于其他游戏')
  })
})
