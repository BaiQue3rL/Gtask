import { describe, expect, it, vi } from 'vitest'
import { CredentialBackedAdapter } from '../src/main/sync/credential-backed-adapter'
import { SyncVerificationRequiredError } from '../src/main/sync/types'

describe('CredentialBackedAdapter', () => {
  it('未登录时返回可识别的验证状态错误', async () => {
    const adapter = new CredentialBackedAdapter('miyoushe', { read: () => null }, () => {
      throw new Error('不应创建内部适配器')
    })
    await expect(adapter.sync('genshin')).rejects.toBeInstanceOf(SyncVerificationRequiredError)
    await expect(adapter.sync('genshin')).rejects.toThrow('米游社尚未登录')
  })

  it('只把解密后的凭据交给内部适配器，不写入同步结果', async () => {
    const createAdapter = vi.fn(() => ({
      sync: async () => ({ items: [], message: '已同步' })
    }))
    const adapter = new CredentialBackedAdapter(
      'kuro-community',
      { read: () => ({ kind: 'token', value: 'encrypted-at-rest-token' }) },
      createAdapter
    )

    expect(await adapter.sync('wuthering-waves')).toEqual({ items: [], message: '已同步' })
    expect(createAdapter).toHaveBeenCalledWith({ kind: 'token', value: 'encrypted-at-rest-token' })
  })
})
