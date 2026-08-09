import { describe, expect, it } from 'vitest'
import {
  claimStartupAutoSync,
  STARTUP_AUTO_SYNC_COOLDOWN_MS
} from '../src/renderer/src/startup-auto-sync'

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value) }
  }
}

describe('claimStartupAutoSync', () => {
  it('跨启动持久限制十分钟内的重复自动同步', () => {
    const storage = memoryStorage()
    const startedAt = Date.UTC(2026, 7, 9, 10)

    expect(claimStartupAutoSync(storage, startedAt)).toBe(true)
    expect(claimStartupAutoSync(storage, startedAt + STARTUP_AUTO_SYNC_COOLDOWN_MS - 1)).toBe(false)
    expect(claimStartupAutoSync(storage, startedAt + STARTUP_AUTO_SYNC_COOLDOWN_MS)).toBe(true)
  })

  it('存储不可用时仍允许本次启动继续同步', () => {
    const storage = {
      getItem: () => { throw new Error('disabled') },
      setItem: () => { throw new Error('disabled') }
    }
    expect(claimStartupAutoSync(storage, 1)).toBe(true)
  })
})
