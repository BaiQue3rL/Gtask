import { describe, expect, it } from 'vitest'
import { toCodexWorkerPreferencesIpcPayload } from '../src/renderer/src/codex-worker-preferences'

describe('Codex worker preference IPC payload', () => {
  it('copies a reactive-like proxy into a structured-cloneable plain object', () => {
    const proxy = new Proxy({
      strategy: 'fixed' as const,
      model: 'gpt-5.6-sol' as const,
      reasoningEffort: 'high' as const
    }, {})

    expect(() => structuredClone(proxy)).toThrow()

    const payload = toCodexWorkerPreferencesIpcPayload(proxy)
    expect(payload).toEqual({
      strategy: 'fixed',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high'
    })
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype)
    expect(() => structuredClone(payload)).not.toThrow()
  })
})
