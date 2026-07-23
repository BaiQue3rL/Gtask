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
  },
  eventCalendar: {
    act_list: [{
      id: 5001,
      name: '折纸小鸟对对碰',
      time_info: {
        start_ts: 1784505600,
        end_ts: 1787183999
      },
      act_status: 'OtherActStatusUnFinish',
      current_progress: 3,
      total_progress: 5,
      all_finished: false
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
      expect.objectContaining({ modeKey: 'anomaly-arbitration', progressPercent: 100, completed: true }),
      expect.objectContaining({
        remoteKey: 'event:miyoushe:5001',
        category: 'limited_event',
        title: '折纸小鸟对对碰',
        progressPercent: 60,
        completed: false
      })
    ]))
  })

  it('accepts numeric-string event timestamps and preserves events without a usable window', () => {
    const items = parseStarRailPersonalData({
      eventCalendar: {
        act_list: [
          {
            id: 6001,
            name: '货币战争•零和博弈',
            time_info: { start_ts: '1784505600', end_ts: '1787183999' },
            all_finished: false
          },
          {
            id: 6002,
            name: '无有效排期的活动',
            time_info: { start_ts: '0', end_ts: '0' },
            all_finished: true
          }
        ]
      }
    })

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        remoteKey: 'event:miyoushe:6001',
        startsAt: '2026-07-20T00:00:00.000Z',
        endsAt: '2026-08-19T23:59:59.000Z',
        scheduleKind: 'fixed_window'
      }),
      expect.objectContaining({
        remoteKey: 'event:miyoushe:6002',
        completed: true,
        startsAt: undefined,
        endsAt: undefined,
        periodKey: 'star-rail:event:6002',
        scheduleKind: undefined
      })
    ]))
  })

  it('does not reuse explicit or numeric completion for an event that has not started', () => {
    const items = parseStarRailPersonalData({
      eventCalendar: {
        act_list: [{
          id: 6010,
          name: '未来活动',
          time_info: { start_ts: 1785110400, end_ts: 1787183999 },
          all_finished: true,
          act_status: 'OtherActStatusFinish',
          current_progress: 10,
          total_progress: 10
        }]
      }
    }, new Date('2026-07-23T00:00:00.000Z'))

    expect(items[0]).toMatchObject({
      completed: false,
      progressPercent: undefined
    })
  })

  it('treats full stars as completed when the endpoint omits a parseable last-floor marker', () => {
    const items = parseStarRailPersonalData({
      pureFiction: {
        star_num: 12,
        max_floor: '',
        has_data: true,
        all_floor_detail: [],
        groups: [season(202, '虚构叙事')]
      }
    })

    expect(items[0]).toMatchObject({
      modeKey: 'pure-fiction',
      progressPercent: 100,
      completed: true
    })
  })

  it('the adapter requests each source sequentially and rejects other games', async () => {
    const order: string[] = []
    const client = {
      getMemoryOfChaos: async () => { order.push('memory'); return payload.memoryOfChaos },
      getPureFiction: async () => { order.push('fiction'); return payload.pureFiction },
      getApocalypticShadow: async () => { order.push('shadow'); return payload.apocalypticShadow },
      getAnomalyArbitration: async () => { order.push('arbitration'); return payload.anomalyArbitration },
      getEventCalendar: async () => { order.push('events'); return payload.eventCalendar }
    }
    const adapter = new StarRailPersonalAdapter(client)

    const result = await adapter.sync('star-rail')
    expect(order).toEqual(['memory', 'fiction', 'shadow', 'arbitration', 'events'])
    expect(result.items).toHaveLength(5)
    order.length = 0
    const eventsOnly = await adapter.sync('star-rail', 'events')
    expect(order).toEqual(['events'])
    expect(eventsOnly.items).toHaveLength(1)
    order.length = 0
    const exploration = await adapter.sync('star-rail', 'exploration')
    expect(order).toEqual([])
    expect(exploration.items).toEqual([])
    await expect(adapter.sync('genshin')).rejects.toThrow('不能用于其他游戏')
  })

  it('周期接口部分失败时仍返回已取得的数据', async () => {
    const adapter = new StarRailPersonalAdapter({
      getMemoryOfChaos: async () => payload.memoryOfChaos,
      getPureFiction: async () => { throw new Error('虚构风控') },
      getApocalypticShadow: async () => { throw new Error('末日风控') },
      getAnomalyArbitration: async () => { throw new Error('仲裁风控') },
      getEventCalendar: async () => payload.eventCalendar
    })
    const partial = await adapter.sync('star-rail', 'cycles')
    expect(partial.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modeKey: 'memory-of-chaos' })
    ]))
    expect(partial.message).toContain('部分成功 1/4')
  })
})
