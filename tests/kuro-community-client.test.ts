import { describe, expect, it, vi } from 'vitest'
import {
  KuroCommunityClient
} from '../src/main/sync/kuro-community-client'

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

describe('KuroCommunityClient', () => {
  it('刷新短期 BAT 后顺序读取鸣潮探索与三类挑战', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 200, data: { accessToken: 'short-bat' } }))
      .mockResolvedValueOnce(response({ code: 200, data: {} }))
      .mockResolvedValueOnce(response({ code: 200, data: { exploreList: [] } }))
      .mockResolvedValueOnce(response({ code: 200, data: { difficultyList: [] } }))
      .mockResolvedValueOnce(response({ code: 200, data: { difficultyList: [] } }))
      .mockResolvedValueOnce(response({ code: 200, data: { modeDetails: [] } }))
    const client = new KuroCommunityClient({
      token: 'long-token',
      did: 'DEVICE-ID',
      roleId: '123456789',
      serverId: 'server-cn'
    }, fetcher)

    await expect(client.getExploration()).resolves.toEqual({ exploreList: [] })
    await expect(client.getTower()).resolves.toEqual({ difficultyList: [] })
    await expect(client.getSlash()).resolves.toEqual({ difficultyList: [] })
    await expect(client.getMatrix()).resolves.toEqual({ modeDetails: [] })
    expect(fetcher).toHaveBeenCalledTimes(6)
    expect(String(fetcher.mock.calls[0][0])).toContain('/aki/roleBox/requestToken')
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('token')).toBe('long-token')
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('b-at')).toBe('short-bat')
    expect(String(fetcher.mock.calls[2][1]?.body)).toContain('countryCode=1')
  })

  it('BAT 失效时自动刷新一次并重试原请求', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 200, data: { accessToken: 'bat-1' } }))
      .mockResolvedValueOnce(response({ code: 200, data: {} }))
      .mockResolvedValueOnce(response({ code: 10903, msg: '数据令牌失效' }))
      .mockResolvedValueOnce(response({ code: 200, data: { accessToken: 'bat-2' } }))
      .mockResolvedValueOnce(response({ code: 200, data: { exploreList: [] } }))
    const client = new KuroCommunityClient({
      token: 'long-token',
      did: 'DEVICE-ID',
      roleId: '123456789',
      serverId: 'server-cn'
    }, fetcher)

    await expect(client.getExploration()).resolves.toEqual({ exploreList: [] })
    expect(new Headers(fetcher.mock.calls[4][1]?.headers).get('b-at')).toBe('bat-2')
  })

  it('长期 Token 过期时要求重新登录', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValue(response({ code: 220, msg: '登录已过期' }))
    const client = new KuroCommunityClient({
      token: 'expired',
      did: 'DEVICE-ID',
      roleId: '123456789',
      serverId: 'server-cn'
    }, fetcher)
    await expect(client.getTower()).rejects.toMatchObject({
      name: 'SyncVerificationRequiredError'
    })
  })
})
