import { describe, expect, it } from 'vitest'
import {
  credentialProviderForSyncResult,
  credentialProviderFromSyncMessage
} from '../src/renderer/src/sync-credential-notice'

describe('sync credential notice', () => {
  it('根据结构化验证状态识别米游社和库街区登录入口', () => {
    expect(credentialProviderForSyncResult({
      gameId: 'star-rail',
      requestedScope: 'personal_data',
      requestedTarget: 'events',
      status: 'error',
      startedAt: '',
      finishedAt: '',
      sources: [{
        source: 'personal_data',
        status: 'verification_required',
        message: '米游社登录已失效，请重新登录',
        added: 0,
        updated: 0,
        preserved: 0
      }],
      message: '米游社登录已失效，请重新登录'
    })).toBe('miyoushe')

    expect(credentialProviderForSyncResult({
      gameId: 'wuthering-waves',
      requestedScope: 'personal_data',
      requestedTarget: 'cycles',
      status: 'error',
      startedAt: '',
      finishedAt: '',
      sources: [{
        source: 'personal_data',
        status: 'verification_required',
        message: '库街区登录已过期，请重新登录',
        added: 0,
        updated: 0,
        preserved: 0
      }],
      message: '库街区登录已过期，请重新登录'
    })).toBe('kuro-community')
  })

  it('兼容旧结果消息中的凭据失效说法', () => {
    expect(credentialProviderFromSyncMessage('米游社凭据无法解密，请重新登录'))
      .toBe('miyoushe')
    expect(credentialProviderFromSyncMessage('库街区数据令牌已失效，请重新登录'))
      .toBe('kuro-community')
    expect(credentialProviderFromSyncMessage('公开资料任务等待 Codex 处理'))
      .toBeNull()
  })
})
