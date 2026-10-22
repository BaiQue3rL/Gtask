import { describe, expect, it } from 'vitest'
import {
  areValidActivityTags,
  localizeActivityTags,
  normalizeActivityTags
} from '../src/main/activity-tags'

describe('活动玩法标签中文规范化', () => {
  it('把常见分类键转换为稳定 ID 并去重', () => {
    expect(normalizeActivityTags([
      'ley-line',
      'double-rewards',
      'shooting',
      'puzzle',
      'shooting'
    ])).toEqual(['ley-line', 'double-reward', 'shooting', 'puzzle'])
  })

  it('未知外语标签不直接暴露在中文界面', () => {
    expect(normalizeActivityTags(['new-unknown-mode', '战斗', '待识别']))
      .toEqual(['unknown', 'combat'])
  })

  it('规范化保留按契约提交的稳定英文 ID', () => {
    expect(normalizeActivityTags(['shooting', 'puzzle']))
      .toEqual(['shooting', 'puzzle'])
  })

  it('旧数据中未注册的文字统一展示未知，不按语义黑名单丢弃', () => {
    expect(normalizeActivityTags([
      '限时活动',
      '战斗',
      '个人数据',
      '网页活动'
    ])).toEqual(['unknown', 'combat', 'web-event'])
  })

  it('未注册的泛化词按同一 ID 解析规则处理', () => {
    expect(normalizeActivityTags([
      '活动玩法',
      '活动内容',
      '通用玩法',
      '战斗'
    ])).toEqual(['unknown', 'combat'])
  })

  it('未注册的英文文字同样解析为未知', () => {
    expect(normalizeActivityTags([
      'limited_event',
      'shooting',
      'personal data',
      'event gameplay',
      'puzzle'
    ])).toEqual(['unknown', 'shooting', 'puzzle'])
  })

  it('稳定 ID 按界面语言本地化展示', () => {
    expect(localizeActivityTags(['combat', 'puzzle'], 'zh-CN')).toEqual(['战斗', '解谜'])
    expect(localizeActivityTags(['combat', 'puzzle'], 'en-US')).toEqual(['Combat', 'Puzzle'])
  })

  it('只校验标签 ID、数量与重复，Agent 可使用未知或任意已注册组合', () => {
    expect(areValidActivityTags(['combat', 'challenge', 'story'])).toBe(true)
    expect(areValidActivityTags(['challenge', 'story', 'quest'])).toBe(true)
    expect(areValidActivityTags(['sign-in'])).toBe(true)
    expect(areValidActivityTags(['story'])).toBe(true)
    expect(areValidActivityTags(['unknown'])).toBe(true)
    expect(areValidActivityTags(['unknown', 'challenge', 'story'])).toBe(true)
    expect(areValidActivityTags(['unregistered'])).toBe(false)
    expect(areValidActivityTags([])).toBe(false)
    expect(areValidActivityTags(['story', 'story'])).toBe(false)
    expect(areValidActivityTags(['combat', 'challenge', 'story', 'quest', 'unknown', 'sign-in'])).toBe(false)
  })
})
