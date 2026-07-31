import { describe, expect, it } from 'vitest'
import {
  extractZenlessExplorationReviewCandidates,
  extractZenlessEventReviewCandidates,
  parseZenlessDeadlyAssault,
  parseZenlessPersonalData,
  parseZenlessShiyuDefense
} from '../src/main/sync/zenless-personal-parser'
import { ZenlessPersonalAdapter } from '../src/main/sync/zenless-personal-adapter'

describe('绝区零个人战绩解析', () => {
  it('把官方区域收集解析为一级、二级地图进度候选', () => {
    expect(extractZenlessExplorationReviewCandidates({
      area_collections: [{
        urban_area_group_id: 21,
        name: '罗斯凯利法',
        collection_progress: 60,
        map_collections: [{
          urban_area_id: 2101,
          name: '布亚斯特城区',
          collection_progress: 100
        }, {
          urban_area_id: 2102,
          name: '[管制区]算枢局',
          collection_progress: 65
        }]
      }]
    })).toEqual([
      expect.objectContaining({
        target: 'exploration',
        payload: expect.objectContaining({
          officialId: 'group:21',
          officialTitle: '罗斯凯利法',
          observedNodeKind: 'region',
          observedProgress: 60
        })
      }),
      expect.objectContaining({
        target: 'exploration',
        payload: expect.objectContaining({
          officialId: 'area:2101',
          officialTitle: '布亚斯特城区',
          observedNodeKind: 'subregion',
          observedParentTitle: '罗斯凯利法',
          observedProgress: 100
        })
      }),
      expect.objectContaining({
        target: 'exploration',
        payload: expect.objectContaining({
          officialId: 'area:2102',
          officialTitle: '[管制区]算枢局',
          observedNodeKind: 'subregion',
          observedParentTitle: '罗斯凯利法',
          observedProgress: 65
        })
      })
    ])
  })

  it('把式舆防卫战映射为稳定模式标识、周期和战绩状态', () => {
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
      startsAt: '2026-07-09T20:00:00.000Z',
      endsAt: '2026-07-23T19:59:59.000Z',
      periodKey: 'zenless:shiyu-defense:62052',
      scheduleKind: 'remote_schedule',
      modeKey: 'shiyu-defense'
    })
  })

  it('有危局强袭战记录即完成，并按中国时区解释无偏移时间', () => {
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
      startsAt: '2026-07-16T20:00:00.000Z',
      endsAt: '2026-07-28T19:59:59.000Z',
      periodKey: 'zenless:deadly-assault:69041'
    })
  })

  it('兼容绝区零战绩接口中的数字字符串', () => {
    expect(parseZenlessDeadlyAssault({
      id: '69042',
      start_time: '2026-07-17T04:00:00',
      end_time: '2026-07-29T03:59:59',
      has_data: true,
      total_star: '9',
      challenges: [
        { star: '3', total_star: '3' },
        { star: '3', total_star: '3' },
        { star: '3', total_star: '3' }
      ]
    })).toMatchObject({
      completed: true
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

  it('活动状态只脱敏进入 Codex 核验，不由本地状态枚举直接判完成', () => {
    const candidates = extractZenlessEventReviewCandidates({
      uid: '不应读取',
      activity_list: [{
        activity_id: 7001,
        name: '嗯呢从天降',
        state: 'STATE_IN_PROGRESS',
        monochrome_got_cnt: 240,
        monochrome_cnt: 300,
        start_ts: 1784505600,
        end_ts: 1787183999
      }]
    })
    expect(candidates).toEqual([
      expect.objectContaining({
        target: 'events',
        kind: 'personal-item-semantics',
        payload: expect.objectContaining({
          officialEventId: '7001',
          title: '嗯呢从天降',
          normalizedStartAt: '2026-07-20T00:00:00.000Z',
          normalizedEndAt: '2026-08-19T23:59:59.000Z',
          observedStatus: {
            state: 'STATE_IN_PROGRESS',
            status: null,
            obtainedCount: 240,
            totalCount: 300
          }
        })
      })
    ])
    expect(JSON.stringify(candidates)).not.toContain('uid')
    expect(JSON.stringify(candidates)).not.toContain('不应读取')
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
      completed: true,
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

  it('只在本期完全没有挑战记录时保持未完成', () => {
    expect(parseZenlessShiyuDefense({
      schedule_id: 62055,
      passed_fifth_floor: false,
      brief_info: { score: 0, max_score: 150000 }
    })).toMatchObject({ completed: false })

    expect(parseZenlessDeadlyAssault({
      id: 69045,
      has_data: false,
      total_star: 0,
      challenges: []
    })).toMatchObject({ completed: false })
  })

  it('正式适配器按目标顺序请求已验证接口并拒绝用于其他游戏', async () => {
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
      },
      getZenlessExploration: async () => {
        order.push('exploration')
        return {
          area_collections: [{
            urban_area_group_id: 21,
            name: '罗斯凯利法',
            collection_progress: 60,
            map_collections: [{
              urban_area_id: 2101,
              name: '布亚斯特城区',
              collection_progress: 100
            }]
          }]
        }
      }
    })
    const progress: Array<{ message: string; current?: number | null; total?: number | null }> = []

    const output = await adapter.sync('zenless', 'all', (update) => progress.push(update))
    expect(order).toEqual(['shiyu', 'deadly', 'events', 'exploration'])
    expect(progress).toEqual([
      expect.objectContaining({ message: '正在读取式舆防卫战战绩', current: 1, total: 4 }),
      expect.objectContaining({ message: '正在读取危局强袭战战绩', current: 2, total: 4 }),
      expect.objectContaining({ message: '正在读取绝区零活动进度', current: 3, total: 4 }),
      expect.objectContaining({ message: '正在读取绝区零区域探索进度', current: 4, total: 4 })
    ])
    expect(output.items).toHaveLength(5)
    expect(output.snapshotCompleteness).toBe('complete')
    order.length = 0
    const eventsOnly = await adapter.sync('zenless', 'events')
    expect(order).toEqual(['events'])
    expect(eventsOnly.items).toHaveLength(1)
    order.length = 0
    const exploration = await adapter.sync('zenless', 'exploration')
    expect(order).toEqual(['exploration'])
    expect(exploration.items).toHaveLength(2)
    expect(exploration.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ mapNodeKind: 'region' }),
      expect.objectContaining({ mapNodeKind: 'subregion' })
    ]))
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
      getZenlessEventCalendar: async () => ({ activity_list: [] }),
      getZenlessExploration: async () => ({ area_collections: [] })
    })
    const progress: Array<{ message: string }> = []
    const partial = await adapter.sync('zenless', 'cycles', (update) => progress.push(update))
    expect(partial.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: 'endgame', modeKey: 'shiyu-defense' })
    ]))
    expect(partial.snapshotCompleteness).toBe('partial')
    expect(partial.message).toContain('部分成功 1/2')
    expect(progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: '危局强袭战战绩读取失败，继续下一项' })
    ]))
  })
})
