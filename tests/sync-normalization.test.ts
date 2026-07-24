import { describe, expect, it } from 'vitest'
import { normalizeSyncItem } from '../src/main/sync/normalization'

describe('normalizeSyncItem', () => {
  it('清理规范标识和标题两侧空白并保留合法字段', () => {
    expect(
      normalizeSyncItem({
        remoteKey: ' event:summer ',
        category: 'limited_event',
        title: ' 夏日活动 ',
        sourceUrl: 'https://example.com/schedule',
        startsAt: '2026-07-20T00:00:00.000Z',
        progressPercent: 50
      })
    ).toMatchObject({
      remoteKey: 'event:summer',
      category: 'limited_event',
      title: '夏日活动',
      sourceUrl: 'https://example.com/schedule',
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
    expect(() => normalizeSyncItem({ ...base, title: '活动', sourceUrl: 'file:///secret' })).toThrow(
      'HTTP/HTTPS'
    )
  })

  it('把可解析时间统一为 ISO 8601 后再写入数据库', () => {
    expect(
      normalizeSyncItem({
        remoteKey: 'event:date-normalization',
        category: 'limited_event',
        title: '时间归一化',
        startsAt: '2026-07-20T08:00:00+08:00'
      }).startsAt
    ).toBe('2026-07-20T00:00:00.000Z')
  })

  it('规范化 AI 提供的活动玩法标签', () => {
    expect(
      normalizeSyncItem({
        remoteKey: 'event:tagged',
        category: 'limited_event',
        title: '玩法活动',
        activityTags: [' 战斗 ', '解谜', '战斗']
      }).activityTags
    ).toEqual(['战斗', '解谜'])

    expect(() =>
      normalizeSyncItem({
        remoteKey: 'event:too-many-tags',
        category: 'limited_event',
        title: '标签过多',
        activityTags: ['签到', '战斗', '跑酷', '解谜', '经营', '音游']
      })
    ).toThrow('活动玩法标签')
  })
})
