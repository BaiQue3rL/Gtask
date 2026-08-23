import { describe, expect, it, vi } from 'vitest'
import { CredentialBackedAdapter } from '../src/main/sync/credential-backed-adapter'
import { SyncVerificationRequiredError } from '../src/main/sync/types'

describe('CredentialBackedAdapter', () => {
  it('未登录时返回可识别的验证状态错误', async () => {
    const adapter = new CredentialBackedAdapter('miyoushe', { read: () => null }, () => {
      throw new Error('不应创建内部适配器')
    })
    await expect(adapter.sync('genshin')).rejects.toBeInstanceOf(SyncVerificationRequiredError)
    await expect(adapter.sync('genshin')).rejects.toThrow('米游社还没登录')
  })

  it('只把解密后的凭据交给内部适配器，并仅输出不可逆账号作用域', async () => {
    const createAdapter = vi.fn(() => ({
      sync: async () => ({ items: [], message: '已同步' })
    }))
    const credential = {
      kind: 'token' as const,
      value: JSON.stringify({
        token: 'secret-token',
        did: 'secret-device',
        roleId: '123456789',
        serverId: '76402g20'
      })
    }
    const adapter = new CredentialBackedAdapter(
      'kuro-community',
      { read: () => credential },
      createAdapter
    )

    const result = await adapter.sync('wuthering-waves')
    expect(result).toMatchObject({
      items: [],
      message: '已同步',
      accountScope: expect.stringMatching(/^kuro-community:[a-f0-9]{64}$/u)
    })
    expect(JSON.stringify(result)).not.toContain('123456789')
    expect(JSON.stringify(result)).not.toContain('secret-token')
    expect(createAdapter).toHaveBeenCalledWith(
      credential,
      undefined,
      undefined
    )
  })

  it('同一平台账号按游戏隔离个人状态作用域', async () => {
    const credential = {
      kind: 'cookie' as const,
      value: 'account_id_v2=12345; cookie_token_v2=secret'
    }
    const adapter = new CredentialBackedAdapter(
      'miyoushe',
      { read: () => credential },
      () => ({ sync: async () => ({ items: [], message: '已同步' }) })
    )

    const genshin = await adapter.sync('genshin')
    const starRail = await adapter.sync('star-rail')
    expect(genshin.accountScope).not.toBe(starRail.accountScope)
    expect(genshin.accountScope).toMatch(/^miyoushe:[a-f0-9]{64}$/u)
  })
})
