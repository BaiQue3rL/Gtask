import { describe, expect, it } from 'vitest'
import {
  parsePublicScheduleDocument,
  PublicScheduleDocumentAdapter
} from '../src/main/sync/public-schedule-document'

describe('公开排期文档', () => {
  const document = {
    schemaVersion: 1,
    gameId: 'genshin',
    sourceUrl: 'https://example.com/genshin/schedule',
    fetchedAt: '2026-07-20T01:00:00.000Z',
    items: [
      {
        remoteKey: 'event:summer-2026',
        category: 'limited_event',
        title: '夏日活动',
        startsAt: '2026-07-20T02:00:00.000Z',
        endsAt: '2026-08-01T02:00:00.000Z',
        completed: true,
        progressPercent: 100
      },
      {
        remoteKey: 'endgame:abyss',
        category: 'endgame',
        title: '深境螺旋',
        periodKey: '2026-07-b',
        modeKey: 'abyss'
      }
    ]
  }

  it('统一注入来源并禁止公开排期声明个人完成状态', () => {
    const parsed = parsePublicScheduleDocument(document, 'genshin')
    expect(parsed.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          remoteKey: 'event:summer-2026',
          sourceUrl: document.sourceUrl,
          completed: undefined,
          progressPercent: undefined,
          scheduleKind: 'fixed_window'
        }),
        expect.objectContaining({
          remoteKey: 'endgame:abyss',
          scheduleKind: 'remote_schedule'
        })
      ])
    )
  })

  it('拒绝游戏不匹配、非 HTTP 来源和不允许的公开分类', () => {
    expect(() => parsePublicScheduleDocument(document, 'zenless')).toThrow('游戏不匹配')
    expect(() =>
      parsePublicScheduleDocument({ ...document, sourceUrl: 'file:///schedule.json' }, 'genshin')
    ).toThrow('HTTP/HTTPS')
    expect(() =>
      parsePublicScheduleDocument(
        { ...document, items: [{ remoteKey: 'custom:1', category: 'custom', title: '事项' }] },
        'genshin'
      )
    ).toThrow('只允许限时活动和周期挑战')
  })

  it('适配器加载文档并返回协调器可直接合并的事项', async () => {
    const adapter = new PublicScheduleDocumentAdapter(async () => document, {
      now: () => new Date('2026-07-20T02:00:00.000Z')
    })
    const output = await adapter.sync('genshin')
    expect(output.items).toHaveLength(2)
    expect(output.message).toContain('2026-07-20T01:00:00.000Z')
  })

  it('拒绝过期文档和明显来自未来的抓取时间', async () => {
    const now = () => new Date('2026-07-20T02:00:00.000Z')
    const stale = new PublicScheduleDocumentAdapter(
      async () => ({ ...document, fetchedAt: '2026-07-18T01:00:00.000Z' }),
      { now }
    )
    await expect(stale.sync('genshin')).rejects.toThrow('已过期')

    const future = new PublicScheduleDocumentAdapter(
      async () => ({ ...document, fetchedAt: '2026-07-20T03:00:00.000Z' }),
      { now }
    )
    await expect(future.sync('genshin')).rejects.toThrow('来自未来')
  })

  it('拒绝异常庞大的公开排期事项集合', () => {
    expect(() =>
      parsePublicScheduleDocument(
        {
          ...document,
          items: Array.from({ length: 501 }, (_, index) => ({
            remoteKey: `event:${index}`,
            category: 'limited_event',
            title: `活动 ${index}`
          }))
        },
        'genshin'
      )
    ).toThrow('不能超过 500 条')
  })
})
