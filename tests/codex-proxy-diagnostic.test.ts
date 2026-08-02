import { describe, expect, it } from 'vitest'
import type { SyncProgressUpdate } from '../src/shared/contracts'
import {
  CODEX_PROXY_REPAIR_PROMPT,
  CODEX_PROXY_WARNING,
  isCodexConnectionRetry
} from '../src/renderer/src/codex-proxy-diagnostic'

function progress(overrides: Partial<SyncProgressUpdate> = {}): SyncProgressUpdate {
  return {
    gameId: 'genshin',
    target: 'all',
    source: 'public_schedule',
    phase: 'retrying',
    status: 'running',
    retryKind: 'codex_connection',
    message: 'Codex 正在连接模型，重试 2/5',
    current: 2,
    total: 5,
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides
  }
}

describe('Codex 代理诊断提示', () => {
  it('只按结构化重试来源判断 Codex 连接问题', () => {
    expect(isCodexConnectionRetry(progress())).toBe(true)
    expect(isCodexConnectionRetry(progress({
      source: 'personal_data',
      message: '任何内部说明'
    }))).toBe(true)
    expect(isCodexConnectionRetry(progress({
      retryKind: 'source_request',
      message: 'Codex 正在连接模型，重试 2/5'
    }))).toBe(false)
    expect(isCodexConnectionRetry(progress({ phase: 'verifying' }))).toBe(false)
  })

  it('说明已验证的网络风险、同步耗时和用户选择权', () => {
    expect(CODEX_PROXY_WARNING).toContain('当前版 Codex 已支持 Windows 系统代理')
    expect(CODEX_PROXY_WARNING).toContain('可能延长同步时间')
    expect(CODEX_PROXY_WARNING).toContain('全局/TUN')
    expect(CODEX_PROXY_WARNING).toContain('HTTPS 兼容连接')
    expect(CODEX_PROXY_REPAIR_PROMPT).toContain('WebSocket')
    expect(CODEX_PROXY_REPAIR_PROMPT).toContain('chatgpt.com:443')
    expect(CODEX_PROXY_REPAIR_PROMPT).toContain('不要预设')
  })
})
