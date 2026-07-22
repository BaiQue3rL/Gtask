import { describe, expect, it } from 'vitest'
import { parseScheduleImageText } from '../src/main/schedule-image-parser'

describe('parseScheduleImageText', () => {
  it('把北京时间海报日期转换为绝对时间并保留核对警告', () => {
    expect(parseScheduleImageText(
      '盛夏活动\n7月22日 10:00 至 8月1日 03:59',
      new Date('2026-07-20T00:00:00.000Z')
    )).toEqual([
      expect.objectContaining({
        title: '盛夏活动',
        startsAt: '2026-07-22T02:00:00.000Z',
        endsAt: '2026-07-31T19:59:00.000Z',
        warnings: ['图片未完整标注年份，请核对跨年情况']
      })
    ])
  })

  it('明确年份且跨年时生成正确的绝对时间', () => {
    expect(parseScheduleImageText(
      '跨年活动\n2026年12月30日 10:00 - 2027年1月2日 03:59'
    )[0]).toMatchObject({
      startsAt: '2026-12-30T02:00:00.000Z',
      endsAt: '2027-01-01T19:59:00.000Z',
      warnings: []
    })
  })

  it('按图片标注的负 UTC 偏移解释时间', () => {
    expect(parseScheduleImageText(
      '海外服活动\n2026年7月22日 10:00 至 2026年7月23日 03:59',
      new Date('2026-07-20T00:00:00.000Z'),
      -5 * 60
    )[0]).toMatchObject({
      startsAt: '2026-07-22T15:00:00.000Z',
      endsAt: '2026-07-23T08:59:00.000Z'
    })
  })

  it('拒绝日历中不存在的日期', () => {
    expect(() => parseScheduleImageText(
      '异常活动\n2026年2月30日 10:00 至 2026年3月2日 03:59'
    )).toThrow('图片中的日期时间格式不正确')
  })
})
