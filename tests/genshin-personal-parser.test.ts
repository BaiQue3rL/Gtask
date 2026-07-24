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
      stat: { max_round_id: 10, get_medal_round_list: Array.from({ length: 12 }, () => true) }
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
  },
  eventCalendar: {
    act_list: [{
      id: 9001,
      name: '砺行修远',
      start_timestamp: 1784505600,
      end_timestamp: 1787183999,
      is_finished: false,
      explore_detail: { explore_percent: 85.5, is_finished: false }
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
        completed: true
      }),
      expect.objectContaining({ modeKey: 'imaginarium-theater', completed: true }),
      expect.objectContaining({ modeKey: 'stygian-onslaught', completed: true }),
      expect.objectContaining({
        remoteKey: 'event:miyoushe:9001',
        category: 'limited_event',
        title: '砺行修远',
        completed: false
      })
    ]))
    expect(items.filter((item) => item.category !== 'exploration')
      .every((item) => !Object.hasOwn(item, 'progressPercent'))).toBe(true)
  })

  it('兼容米游社把剧诗轮数和幽境难度返回为数字字符串', () => {
    const items = parseGenshinPersonalData({
      imaginariumTheater: {
        is_unlock: true,
        data: [{
          has_data: true,
          schedule: {
            schedule_id: '456',
            start_time: '1784505600',
            end_time: '1787183999'
          },
          stat: {
            max_round_id: '10',
            get_medal_round_list: Array.from({ length: 10 }, () => true)
          }
        }]
      },
      stygianOnslaught: {
        data: [{
          schedule: {
            schedule_id: '789',
            name: '幽境危战',
            is_valid: true,
            start_time: '1784505600',
            end_time: '1787183999'
          },
          single: { has_data: true, best: { difficulty: '5' } }
        }]
      }
    })

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modeKey: 'imaginarium-theater', completed: true }),
      expect.objectContaining({ modeKey: 'stygian-onslaught', completed: true })
    ]))
  })

  it('按 parent_id 建立地图父子关系，并只在全部子区域满探索时修正零值父项', () => {
    const items = parseGenshinPersonalData({
      profile: {
        world_explorations: [
          {
            id: 10,
            parent_id: 0,
            name: '沉玉谷',
            exploration_percentage: 0,
            area_exploration_list: [
              { name: '遗珑埠', exploration_percentage: 1000 }
            ]
          },
          { id: 11, parent_id: 10, name: '来歆山', exploration_percentage: 1000 },
          { id: 12, parent_id: 10, name: '沉玉谷·南陵', exploration_percentage: 1000 },
          { id: 13, parent_id: 10, name: '沉玉谷·上谷', exploration_percentage: 1000 }
        ]
      }
    })

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        remoteKey: 'exploration:world:10',
        title: '沉玉谷',
        progressPercent: 100,
        completed: true,
        parentTitle: '世界探索'
      }),
      expect.objectContaining({
        remoteKey: 'exploration:world:11',
        title: '来歆山',
        progressPercent: 100,
        parentTitle: '沉玉谷'
      }),
      expect.objectContaining({
        title: '遗珑埠',
        progressPercent: 100,
        parentTitle: '沉玉谷'
      })
    ]))
  })

  it('父区域零值且子区域未全满时不伪造平均探索度', () => {
    const items = parseGenshinPersonalData({
      profile: {
        world_explorations: [
          { id: 20, parent_id: 0, name: '测试父区域', exploration_percentage: 0 },
          { id: 21, parent_id: 20, name: '测试子区域甲', exploration_percentage: 1000 },
          { id: 22, parent_id: 20, name: '测试子区域乙', exploration_percentage: 500 }
        ]
      }
    })

    expect(items.find((item) => item.remoteKey === 'exploration:world:20')).toMatchObject({
      progressPercent: null,
      completed: false
    })
  })

  it('活动时间兼容数字字符串，并在无效时保留状态但不写错误倒计时', () => {
    const items = parseGenshinPersonalData({
      eventCalendar: {
        act_list: [
          {
            id: 9002,
            name: '数字时间活动',
            start_timestamp: '1784505600',
            end_timestamp: '1787183999',
            is_finished: true
          },
          {
            id: 9003,
            name: '特殊时间活动',
            start_timestamp: '0',
            end_timestamp: 'not-a-time',
            explore_detail: { explore_percent: 50 }
          }
        ]
      }
    })

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '数字时间活动',
        startsAt: '2026-07-20T00:00:00.000Z',
        endsAt: '2026-08-19T23:59:59.000Z',
        completed: true
      }),
      expect.objectContaining({
        title: '特殊时间活动',
        startsAt: undefined,
        endsAt: undefined,
        periodKey: 'genshin:event:9003'
      })
    ]))
    expect(items.every((item) => !Object.hasOwn(item, 'progressPercent'))).toBe(true)
  })

  it('活动同步排除挑战模式，并且未来活动不能继承完成状态', () => {
    const items = parseGenshinPersonalData({
      eventCalendar: {
        act_list: [
          {
            id: 9010,
            name: '幽境危战·栗烈之役',
            start_timestamp: 1784505600,
            end_timestamp: 1787183999,
            is_finished: true
          },
          {
            id: 9011,
            name: '未来普通活动',
            start_timestamp: 1785110400,
            end_timestamp: 1787183999,
            is_finished: true,
            explore_detail: { explore_percent: 100, is_finished: true }
          }
        ]
      }
    }, new Date('2026-07-23T00:00:00.000Z'))

    expect(items).toEqual([
      expect.objectContaining({
        remoteKey: 'event:miyoushe:9011',
        completed: false
      })
    ])
    expect(items[0]).not.toHaveProperty('progressPercent')
  })

  it('挑战模式只要本期存在战绩就完成，完全没有记录才未完成', () => {
    const items = parseGenshinPersonalData({
      spiralAbyss: {
        schedule_id: 1001,
        start_time: 1784505600,
        end_time: 1785715199,
        max_floor: '9-1',
        total_star: 1,
        floors: []
      },
      imaginariumTheater: {
        is_unlock: true,
        data: [{
          has_data: true,
          schedule: { schedule_id: 1002, start_time: 1784505600, end_time: 1787183999 },
          stat: { max_round_id: 1, get_medal_round_list: [true, false, false] }
        }]
      },
      stygianOnslaught: {
        data: [{
          schedule: { schedule_id: 1003, start_time: 1784505600, end_time: 1787183999 },
          single: { has_data: true, best: { difficulty: 1 } }
        }]
      }
    })

    expect(items.every((item) => item.completed)).toBe(true)
    expect(items.every((item) => !Object.hasOwn(item, 'progressPercent'))).toBe(true)

    expect(parseGenshinPersonalData({
      spiralAbyss: {
        schedule_id: 1004,
        start_time: 1784505600,
        end_time: 1785715199,
        has_data: false,
        max_floor: '',
        total_star: 0,
        floors: []
      }
    })[0]).toMatchObject({ completed: false })
  })

  it('the adapter requests each source sequentially and rejects other games', async () => {
    const order: string[] = []
    const client = {
      getProfile: async () => { order.push('profile'); return payload.profile },
      getSpiralAbyss: async () => { order.push('abyss'); return payload.spiralAbyss },
      getImaginariumTheater: async () => { order.push('theater'); return payload.imaginariumTheater },
      getStygianOnslaught: async () => { order.push('stygian'); return payload.stygianOnslaught },
      getEventCalendar: async () => { order.push('events'); return payload.eventCalendar }
    }
    const adapter = new GenshinPersonalAdapter(client)
    const progress: Array<{ message: string; current?: number | null; total?: number | null }> = []

    const result = await adapter.sync('genshin', 'all', (update) => progress.push(update))
    expect(order).toEqual(['profile', 'abyss', 'theater', 'stygian', 'events'])
    expect(progress).toEqual([
      expect.objectContaining({ message: '正在读取原神地图探索进度', current: 1, total: 5 }),
      expect.objectContaining({ message: '正在读取深境螺旋战绩', current: 2, total: 5 }),
      expect.objectContaining({ message: '正在读取幻想真境剧诗战绩', current: 3, total: 5 }),
      expect.objectContaining({ message: '正在读取幽境危战战绩', current: 4, total: 5 }),
      expect.objectContaining({ message: '正在读取原神活动进度', current: 5, total: 5 })
    ])
    expect(result.items).toHaveLength(6)
    order.length = 0
    const eventsOnly = await adapter.sync('genshin', 'events')
    expect(order).toEqual(['events'])
    expect(eventsOnly.items).toHaveLength(1)
    await expect(adapter.sync('zenless')).rejects.toThrow('不能用于其他游戏')
  })

  it('保留同版块内已成功的接口结果，仅在全部失败时抛错', async () => {
    const adapter = new GenshinPersonalAdapter({
      getProfile: async () => payload.profile,
      getSpiralAbyss: async () => { throw new Error('螺旋风控') },
      getImaginariumTheater: async () => payload.imaginariumTheater,
      getStygianOnslaught: async () => { throw new Error('幽境风控') },
      getEventCalendar: async () => { throw new Error('活动风控') }
    })

    const progress: Array<{ message: string }> = []
    const partial = await adapter.sync('genshin', 'cycles', (update) => progress.push(update))
    expect(partial.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modeKey: 'imaginarium-theater' })
    ]))
    expect(partial.message).toContain('部分成功 1/3')
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: '深境螺旋战绩读取失败，继续下一项' }),
      expect.objectContaining({ message: '幽境危战战绩读取失败，继续下一项' })
    ]))
    await expect(adapter.sync('genshin', 'events')).rejects.toThrow('活动风控')
  })
})
