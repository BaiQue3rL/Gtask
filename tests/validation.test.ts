import { describe, expect, it } from 'vitest'
import {
  parseChecklistSection,
  parseCreateChecklistItem,
  parseExternalUrl,
  parseGameId,
  parseSyncRunMode,
  parseSyncScope,
  parseUpdateChecklistItem
} from '../src/main/validation'

describe('清单 IPC 参数校验', () => {
  it('拒绝支持范围之外的游戏', () => {
    expect(() => parseGameId('honkai-impact-3')).toThrow('不支持的游戏')
  })

  it('清理事项名称两端空格并限制探索进度', () => {
    expect(
      parseCreateChecklistItem({
        gameId: 'wuthering-waves',
        category: 'exploration',
        title: '  黎那汐塔  ',
        progressPercent: 75
      })
    ).toMatchObject({ title: '黎那汐塔', progressPercent: 75 })

    expect(() =>
      parseCreateChecklistItem({
        gameId: 'genshin',
        category: 'exploration',
        title: '纳塔',
        progressPercent: 101
      })
    ).toThrow('探索进度必须在 0 到 100 之间')
  })

  it('拒绝来自渲染进程的错误完成状态', () => {
    expect(() => parseUpdateChecklistItem({ id: 'test-id', completed: 'yes' })).toThrow(
      '完成状态格式不正确'
    )
  })

  it('只接受已定义的清单版块', () => {
    expect(parseChecklistSection('cycles')).toBe('cycles')
    expect(() => parseChecklistSection('all')).toThrow('不支持的清单版块')
  })

  it('校验同步模式和同步范围', () => {
    expect(parseSyncRunMode('automatic')).toBe('automatic')
    expect(parseSyncScope('public_and_personal')).toBe('public_and_personal')
    expect(() => parseSyncRunMode('startup')).toThrow('不支持的同步运行模式')
    expect(() => parseSyncScope('personal_only')).toThrow('不支持的同步范围')
  })

  it('拒绝非法时间和结束早于开始的事项', () => {
    expect(() =>
      parseCreateChecklistItem({
        gameId: 'genshin',
        category: 'limited_event',
        title: '活动',
        startsAt: 'not-a-date'
      })
    ).toThrow('不是有效时间')
    expect(() =>
      parseCreateChecklistItem({
        gameId: 'genshin',
        category: 'limited_event',
        title: '活动',
        startsAt: '2026-07-21T00:00:00.000Z',
        endsAt: '2026-07-20T00:00:00.000Z'
      })
    ).toThrow('结束时间不能早于开始时间')
  })

  it('把 IPC 和 AI 输入的时间统一为 ISO 8601', () => {
    expect(
      parseCreateChecklistItem({
        gameId: 'genshin',
        category: 'limited_event',
        title: '活动',
        startsAt: '2026-07-20T08:00:00+08:00'
      }).startsAt
    ).toBe('2026-07-20T00:00:00.000Z')
  })

  it('外部来源链接只允许 HTTP 和 HTTPS', () => {
    expect(parseExternalUrl('https://example.com/schedule')).toBe('https://example.com/schedule')
    expect(() => parseExternalUrl('file:///C:/secret.txt')).toThrow('HTTP/HTTPS')
    expect(() => parseExternalUrl('javascript:alert(1)')).toThrow('HTTP/HTTPS')
  })
})
