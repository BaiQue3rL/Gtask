import { describe, expect, it } from 'vitest'
import { normalizeActivityTags } from '../src/main/activity-tags'

describe('活动玩法标签中文规范化', () => {
  it('把常见英文分类键转换为中文并去重', () => {
    expect(normalizeActivityTags([
      'ley-line',
      'double-rewards',
      'shooting',
      'puzzle',
      'shooting'
    ])).toEqual(['地脉', '双倍奖励', '射击', '解谜'])
  })

  it('未知外语标签不直接暴露在中文界面', () => {
    expect(normalizeActivityTags(['new-unknown-mode', '战斗', '待识别']))
      .toEqual(['未知', '战斗'])
  })

  it('英语界面保留 Codex 按契约提交的英语标签', () => {
    expect(normalizeActivityTags(['shooting', 'puzzle'], 'en-US'))
      .toEqual(['shooting', 'puzzle'])
  })
})
