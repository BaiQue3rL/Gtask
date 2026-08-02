import { describe, expect, it } from 'vitest'
import {
  activityTagsMeetQualityContract,
  getActivityTagQualityRole,
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

  it('英语界面保留 Codex 按契约提交的英语标签', () => {
    expect(normalizeActivityTags(['shooting', 'puzzle'], 'en-US'))
      .toEqual(['shooting', 'puzzle'])
  })

  it('移除版块分类和数据来源，只保留实际玩法标签', () => {
    expect(normalizeActivityTags([
      '限时活动',
      '战斗',
      '个人数据',
      '网页活动'
    ])).toEqual(['combat', 'web-event'])
  })

  it('移除看似非空但没有玩法语义的泛化占位标签', () => {
    expect(normalizeActivityTags([
      '活动玩法',
      '活动内容',
      '通用玩法',
      '战斗'
    ])).toEqual(['combat'])
  })

  it('英语界面同样移除结构标签而不改写玩法标签', () => {
    expect(normalizeActivityTags([
      'limited_event',
      'shooting',
      'personal data',
      'event gameplay',
      'puzzle'
    ], 'en-US')).toEqual(['shooting', 'puzzle'])
  })

  it('稳定 ID 按界面语言本地化展示', () => {
    expect(localizeActivityTags(['combat', 'puzzle'], 'zh-CN')).toEqual(['战斗', '解谜'])
    expect(localizeActivityTags(['combat', 'puzzle'], 'en-US')).toEqual(['Combat', 'Puzzle'])
  })

  it('AI 标签以准确性优先，允许模型按活动语义自主选择最小准确标签集', () => {
    expect(activityTagsMeetQualityContract(['combat', 'challenge', 'story'])).toBe(true)
    expect(activityTagsMeetQualityContract(['challenge', 'story', 'quest'])).toBe(true)
    expect(activityTagsMeetQualityContract(['sign-in'])).toBe(true)
    expect(activityTagsMeetQualityContract(['story'])).toBe(true)
    expect(activityTagsMeetQualityContract(['combat', 'challenge'])).toBe(true)
    expect(activityTagsMeetQualityContract(['unknown', 'challenge', 'story'])).toBe(false)
    expect(getActivityTagQualityRole('combat')).toBe('primary')
    expect(getActivityTagQualityRole('challenge')).toBe('supporting')
    expect(getActivityTagQualityRole('unknown')).toBe('fallback')
    expect(getActivityTagQualityRole('custom.new-mode')).toBe('primary')
  })
})
