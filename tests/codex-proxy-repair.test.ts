import { describe, expect, it } from 'vitest'
import { resolveLoopbackHttpProxy } from '../src/main/ai/codex-proxy-repair'

describe('Codex proxy repair', () => {
  it('extracts only a local HTTP proxy from Windows proxy resolution', () => {
    expect(resolveLoopbackHttpProxy('PROXY 127.0.0.1:10081; DIRECT'))
      .toBe('http://127.0.0.1:10081')
    expect(resolveLoopbackHttpProxy('HTTPS localhost:7890'))
      .toBe('http://localhost:7890')
    expect(resolveLoopbackHttpProxy('PROXY [::1]:7890'))
      .toBe('http://[::1]:7890')
  })

  it('rejects direct, remote and credential-bearing proxies', () => {
    expect(resolveLoopbackHttpProxy('DIRECT')).toBeNull()
    expect(resolveLoopbackHttpProxy('PROXY 192.168.1.20:7890')).toBeNull()
    expect(resolveLoopbackHttpProxy('PROXY user:secret@127.0.0.1:7890')).toBeNull()
  })
})
