import { describe, expect, it } from 'vitest'
import { getWeeklyPeriod } from '../src/main/periods'

describe('weekly periods', () => {
  it('按 Asia/Shanghai 周一零点划分周期', () => {
    const beforeReset = getWeeklyPeriod(new Date('2026-07-19T15:59:59.000Z'))
    const afterReset = getWeeklyPeriod(new Date('2026-07-19T16:00:00.000Z'))

    expect(beforeReset).toEqual({
      key: 'weekly:Asia/Shanghai:1:2026-07-13',
      startsAt: '2026-07-12T16:00:00.000Z',
      endsAt: '2026-07-19T16:00:00.000Z'
    })
    expect(afterReset).toEqual({
      key: 'weekly:Asia/Shanghai:1:2026-07-20',
      startsAt: '2026-07-19T16:00:00.000Z',
      endsAt: '2026-07-26T16:00:00.000Z'
    })
  })

  it('拒绝当前版本不支持的时区和重置日', () => {
    expect(() => getWeeklyPeriod(new Date(), 0)).toThrow('周重置日必须在 1 到 7 之间')
    expect(() => getWeeklyPeriod(new Date(), 1, 'UTC')).toThrow(
      '当前版本只支持 Asia/Shanghai 周期时区'
    )
  })
})
