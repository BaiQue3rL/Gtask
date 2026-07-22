import { describe, expect, it } from 'vitest'
import { rollRecurringWindow } from '../src/main/recurrence'

describe('rollRecurringWindow', () => {
  it('按固定天数跨过多个过期周期', () => {
    expect(rollRecurringWindow(
      '2026-06-01T00:00:00.000Z',
      '2026-06-15T00:00:00.000Z',
      'interval-days:14',
      new Date('2026-07-01T00:00:00.000Z')
    )).toEqual({
      startsAt: '2026-06-29T00:00:00.000Z',
      endsAt: '2026-07-13T00:00:00.000Z'
    })
  })

  it('按上海服务器每月多个固定日期滚动且不受用户时区影响', () => {
    expect(rollRecurringWindow(
      '2026-07-01T20:00:00.000Z',
      '2026-07-15T20:00:00.000Z',
      'monthly-days:1,16@04:00[Asia/Shanghai]',
      new Date('2026-07-16T00:00:00.000Z')
    )).toEqual({
      startsAt: '2026-07-15T20:00:00.000Z',
      endsAt: '2026-07-31T20:00:00.000Z'
    })
  })

  it('未过期或规则不受支持时不修改', () => {
    expect(rollRecurringWindow(
      '2026-07-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z',
      'monthly-days:1@04:00[Europe/London]',
      new Date('2026-07-20T00:00:00.000Z')
    )).toBeNull()
  })
})
