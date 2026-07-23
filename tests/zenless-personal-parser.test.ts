import { describe, expect, it } from 'vitest'
import {
  parseZenlessDeadlyAssault,
  parseZenlessEvents,
  parseZenlessPersonalData,
  parseZenlessShiyuDefense
} from '../src/main/sync/zenless-personal-parser'
import { ZenlessPersonalAdapter } from '../src/main/sync/zenless-personal-adapter'

describe('绝区零个人战绩解析', () => {
  it('把式舆防卫战映射为稳定模式标识、周期和完成度', () => {
    expect(
      parseZenlessShiyuDefense({
        schedule_id: 62052,
        begin_time: '2026-07-10T04:00:00+08:00',
        end_time: '2026-07-24T03:59:59+08:00',
        passed_fifth_floor: true,
        brief_info: { score: 111142, max_score: 150000 }
      })
    ).toEqual({
      remoteKey: 'endgame:shiyu-defense',
      category: 'endgame',
      title: '式舆防卫战',
      completed: true,
      progressPercent: 74.09,
      startsAt: '2026-07-09T20:00:00.000Z',
      endsAt: '2026-07-23T19:59:59.000Z',
      periodKey: 'zenless:shiyu-defense:62052',
      scheduleKind: 'remote_schedule',
      modeKey: 'shiyu-defense'
    })
  })

  it('用各挑战满星判断危局强袭战完成，并按中国时区解释无偏移时间', () => {
    expect(
      parseZenlessDeadlyAssault({
        id: 69041,
        start_time: '2026-07-17T04:00:00',
        end_time: '2026-07-29T03:59:59',
        has_data: true,
        total_star: 9,
        challenges: [
          { star: 3, total_star: 3 },
          { star: 3, total_star: 3 },
          { star: 3, total_star: 3 }
        ]
      })
    ).toMatchObject({
      remoteKey: 'endgame:deadly-assault',
      completed: true,
      progressPercent: 100,
      startsAt: '2026-07-16T20:00:00.000Z',
      endsAt: '2026-07-28T19:59:59.000Z',
      periodKey: 'zenless:deadly-assault:69041'
    })
  })

  it('允许单项响应，但拒绝完全无法识别的个人数据', () => {
    expect(
      parseZenlessPersonalData({
        shiyuDefense: {
          schedule_id: 1,
          begin_time: '2026-07-01T04:00:00+08:00',
          end_time: '2026-07-15T03:59:59+08:00',
          passed_fifth_floor: false
        }
      })
    ).toHaveLength(1)
    expect(() => parseZenlessPersonalData({})).toThrow('没有可识别')
  })

  it('把活动状态和菲林领取进度映射到活动清单', () => {
    expect(parseZenlessEvents({
      activity_list: [{
        activity_id: 7001,
        name: '嗯呢从天降',
        state: 'STATE_IN_PROGRESS',
        monochrome_got_cnt: 240,
        monochrome_cnt: 300,
        start_ts: 1784505600,
        end_ts: 1787183999
      }]
    })).toEqual([
      expect.objectContaining({
        remoteKey: 'event:miyoushe:7001',
        category: 'limited_event',
        title: '嗯呢从天降',
        progressPercent: 80,
        completed: false
      })
    ])
  })

  it('活动未开始时不继承完成状态或领取进度', () => {
    const items = parseZenlessEvents({
      activity_list: [{
        activity_id: 7002,
        name: '未来活动',
        state: 'STATE_COMPLETED',
        monochrome_got_cnt: 300,
        monochrome_cnt: 300,
        start_ts: 1785110400,
        end_ts: 1787183999
      }]
    }, new Date('2026-07-23T00:00:00.000Z'))

    expect(items[0]).toMatchObject({
      completed: false,
      progressPercent: undefined
    })
  })

  it('个人接口省略排期时间时仍保留完成状态并交由公开排期补时', () => {
    expect(parseZenlessShiyuDefense({
      schedule_id: 62053,
      passed_fifth_floor: false,
      brief_info: { score: 50000, max_score: 100000 }
    })).toEqual({
      remoteKey: 'endgame:shiyu-defense',
      category: 'endgame',
      title: '式舆防卫战',
      completed: false,
      progressPercent: 50,
      startsAt: undefined,
      endsAt: undefined,
      periodKey: 'zenless:shiyu-defense:62053',
      scheduleKind: 'remote_schedule',
      modeKey: 'shiyu-defense'
    })

    const endTimestamp = Date.parse('2026-07-23T19:59:59.000Z') / 1000
    expect(parseZenlessShiyuDefense({
      schedule_id: 62054,
      begin_time: { year: 2026, month: 7, day: 10, hour: 4, minute: 0, second: 0 },
      end_time: endTimestamp,
      passed_fifth_floor: true
    })).toMatchObject({
      startsAt: '2026-07-09T20:00:00.000Z',
      endsAt: '2026-07-23T19:59:59.000Z'
    })
  })

  it('正式适配器顺序请求两个已验证接口并拒绝用于其他游戏', async () => {
    const order: string[] = []
    const adapter = new ZenlessPersonalAdapter({
      getShiyuDefense: async () => {
        order.push('shiyu')
        return {
          schedule_id: 62052,
          begin_time: '2026-07-10T04:00:00+08:00',
          end_time: '2026-07-24T03:59:59+08:00',
          passed_fifth_floor: true
        }
      },
      getDeadlyAssault: async () => {
        order.push('deadly')
        return {
          id: 69041,
          start_time: '2026-07-17T04:00:00',
          end_time: '2026-07-29T03:59:59',
          has_data: false,
          total_star: 0,
          challenges: []
        }
      },
      getZenlessEventCalendar: async () => {
        order.push('events')
        return {
          activity_list: [{
            activity_id: 7001,
            name: '嗯呢从天降',
            state: 'STATE_COMPLETED',
            monochrome_got_cnt: 300,
            monochrome_cnt: 300,
            start_ts: 1784505600,
            end_ts: 1787183999
          }]
        }
      }
    })
    const progress: Array<{ message: string; current?: number | null; total?: number | null }> = []

    const output = await adapter.sync('zenless', 'all', (update) => progress.push(update))
    expect(order).toEqual(['shiyu', 'deadly', 'events'])
    expect(progress).toEqual([
      expect.objectContaining({ message: '正在读取式舆防卫战战绩', current: 1, total: 3 }),
      expect.objectContaining({ message: '正在读取危局强袭战战绩', current: 2, total: 3 }),
      expect.objectContaining({ message: '正在读取绝区零活动进度', current: 3, total: 3 })
    ])
    expect(output.items).toHaveLength(3)
    order.length = 0
    const eventsOnly = await adapter.sync('zenless', 'events')
    expect(order).toEqual(['events'])
    expect(eventsOnly.items).toHaveLength(1)
    order.length = 0
    const exploration = await adapter.sync('zenless', 'exploration')
    expect(order).toEqual([])
    expect(exploration.items).toEqual([])
    await expect(adapter.sync('genshin')).rejects.toThrow('不能用于其他游戏')
  })

  it('周期接口部分失败时保留另一项战绩', async () => {
    const adapter = new ZenlessPersonalAdapter({
      getShiyuDefense: async () => ({
        schedule_id: 62052,
        begin_time: '2026-07-10T04:00:00+08:00',
        end_time: '2026-07-24T03:59:59+08:00',
        passed_fifth_floor: true
      }),
      getDeadlyAssault: async () => { throw new Error('危局接口失败') },
      getZenlessEventCalendar: async () => ({ activity_list: [] })
    })
    const progress: Array<{ message: string }> = []
    const partial = await adapter.sync('zenless', 'cycles', (update) => progress.push(update))
    expect(partial.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ modeKey: 'shiyu-defense' })
    ]))
    expect(partial.message).toContain('部分成功 1/2')
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: '危局强袭战战绩读取失败，继续下一项' })
    ]))
  })
})
