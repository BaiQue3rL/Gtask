import { describe, expect, it } from 'vitest'
import { GenshinPersonalAdapter } from '../src/main/sync/genshin-personal-adapter'
import { parseGenshinPersonalData } from '../src/main/sync/genshin-personal-parser'

const payload = {
  profile: {
    world_explorations: [
      { id: 1, name: '蒙德', exploration_percentage: 1000 },
      { id: 2, name: '璃月', exploration_percentage: 857 }
    ]
  },
  spiralAbyss: {
    schedule_id: 123,
    start_time: 1784505600,
    end_time: 1785715199,
    max_floor: '12-3',
    total_star: 33,
    floors: []
  },
  imaginariumTheater: {
    is_unlock: true,
    data: [{
      has_data: true,
      schedule: { schedule_id: 456, start_time: 1784505600, end_time: 1787183999 },
      stat: { max_round_id: 10, get_medal_round_list: Array.from({ length: 10 }, () => true) }
    }]
  },
  stygianOnslaught: {
    data: [{
      schedule: {
        schedule_id: 789,
        name: '幽境危战',
        is_valid: true,
        start_date_time: { year: 2026, month: 7, day: 20, hour: 4, minute: 0, second: 0 },
        end_date_time: { year: 2026, month: 8, day: 10, hour: 3, minute: 59, second: 59 }
      },
      single: { has_data: true, best: { difficulty: 5 } }
    }]
  }
}

describe('Genshin personal parsing', () => {
  it('maps exploration percentages and all supported endgame modes', () => {
    const items = parseGenshinPersonalData(payload)

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        remoteKey: 'exploration:world:1',
        title: '蒙德',
        progressPercent: 100,
        completed: true
      }),
      expect.objectContaining({
        remoteKey: 'exploration:world:2',
        progressPercent: 85.7,
        completed: false
      }),
      expect.objectContaining({
        modeKey: 'spiral-abyss',
        periodKey: 'genshin:spiral-abyss:123',
        progressPercent: 91.67,
        completed: true
      }),
      expect.objectContaining({ modeKey: 'imaginarium-theater', completed: true }),
      expect.objectContaining({ modeKey: 'stygian-onslaught', progressPercent: 83.33, completed: false })
    ]))
  })

  it('the adapter requests each source sequentially and rejects other games', async () => {
    const order: string[] = []
    const client = {
      getProfile: async () => { order.push('profile'); return payload.profile },
      getSpiralAbyss: async () => { order.push('abyss'); return payload.spiralAbyss },
      getImaginariumTheater: async () => { order.push('theater'); return payload.imaginariumTheater },
      getStygianOnslaught: async () => { order.push('stygian'); return payload.stygianOnslaught }
    }
    const adapter = new GenshinPersonalAdapter(client)

    const result = await adapter.sync('genshin')
    expect(order).toEqual(['profile', 'abyss', 'theater', 'stygian'])
    expect(result.items).toHaveLength(5)
    await expect(adapter.sync('zenless')).rejects.toThrow('不能用于其他游戏')
  })
})
