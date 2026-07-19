import { describe, expect, it } from 'vitest'
import {
  parseCreateChecklistItem,
  parseGameId,
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
})
