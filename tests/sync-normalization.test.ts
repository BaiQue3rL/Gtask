import { describe, expect, it } from 'vitest'
import { normalizeSyncItem } from '../src/main/sync/normalization'

describe('normalizeSyncItem', () => {
  it('清理规范标识和标题两侧空白并保留合法字段', () => {
    expect(
      normalizeSyncItem({
        remoteKey: ' event:summer ',
        category: 'limited_event',
        title: ' 夏日活动 ',
        startsAt: '2026-07-20T00:00:00.000Z',
        progressPercent: 50
      })
    ).toMatchObject({
      remoteKey: 'event:summer',
      category: 'limited_event',
      title: '夏日活动',
      progressPercent: 50
    })
  })

  it('拒绝空标题、非法时间和越界进度', () => {
    const base = { remoteKey: 'event:test', category: 'limited_event' }
    expect(() => normalizeSyncItem({ ...base, title: ' ' })).toThrow('同步事项名称')
    expect(() => normalizeSyncItem({ ...base, title: '活动', endsAt: 'not-a-date' })).toThrow(
      '不是有效时间'
    )
    expect(() => normalizeSyncItem({ ...base, title: '活动', progressPercent: 101 })).toThrow(
      '0 到 100'
    )
  })
})
