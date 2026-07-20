import { describe, expect, it } from 'vitest'
import {
  parseZenlessDeadlyAssault,
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
      }
    })

    const output = await adapter.sync('zenless')
    expect(order).toEqual(['shiyu', 'deadly'])
    expect(output.items).toHaveLength(2)
    await expect(adapter.sync('genshin')).rejects.toThrow('不能用于其他游戏')
  })
})
