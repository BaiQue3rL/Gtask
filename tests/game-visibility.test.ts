import { describe, expect, it, vi } from 'vitest'
import {
  GAME_VISIBILITY_STORAGE_KEY,
  normalizeHiddenGameIds,
  readHiddenGameIds,
  writeHiddenGameIds
} from '../src/renderer/src/game-visibility'

describe('游戏显示偏好', () => {
  it('只保留受支持且不重复的游戏', () => {
    expect(normalizeHiddenGameIds(['star-rail', 'unknown', 'star-rail', 'zenless'])).toEqual([
      'star-rail',
      'zenless'
    ])
  })

  it('即使存储值损坏也至少保留一款游戏可见', () => {
    expect(normalizeHiddenGameIds(['genshin', 'star-rail', 'zenless', 'wuthering-waves']))
      .toEqual(['star-rail', 'zenless', 'wuthering-waves'])
    expect(readHiddenGameIds({ getItem: () => '{broken' })).toEqual([])
  })

  it('使用固定版本键保存规范化偏好', () => {
    const setItem = vi.fn()
    expect(writeHiddenGameIds({ setItem }, ['star-rail', 'star-rail'])).toEqual(['star-rail'])
    expect(setItem).toHaveBeenCalledWith(GAME_VISIBILITY_STORAGE_KEY, '["star-rail"]')
  })

  it('一次性迁移旧产品名称下的显示偏好', () => {
    const values = new Map([['gacha-task-manager.hidden-games.v1', '["zenless"]']])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }

    expect(readHiddenGameIds(storage)).toEqual(['zenless'])
    expect(values.get(GAME_VISIBILITY_STORAGE_KEY)).toBe('["zenless"]')
    expect(values.has('gacha-task-manager.hidden-games.v1')).toBe(false)
  })
})
