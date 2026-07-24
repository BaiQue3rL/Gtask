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
const resolveIosDevCode = async (): Promise<string> => '203.0.113.8, KuroGameBox/Test'

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
    }, fetcher, undefined, undefined, resolveIosDevCode)

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

  it('使用 data 直返字符串格式的 BAT 读取个人数据', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({
        code: 200,
        data: 'eyJhbGciOiJIUzI1NiJ9.payload.signature'
      }))
      .mockResolvedValueOnce(response({ code: 200, data: {} }))
      .mockResolvedValueOnce(response({ code: 200, data: { exploreList: [] } }))
    const client = new KuroCommunityClient({
      token: 'long-token',
      did: 'DEVICE-ID',
      roleId: '123456789',
      serverId: 'server-cn'
    }, fetcher, undefined, undefined, resolveIosDevCode)

    await expect(client.getExploration()).resolves.toEqual({ exploreList: [] })
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('b-at'))
      .toBe('eyJhbGciOiJIUzI1NiJ9.payload.signature')
  })

  it('BAT 失效时自动刷新一次并重试原请求', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 200, data: { accessToken: 'bat-1' } }))
      .mockResolvedValueOnce(response({ code: 200, data: {} }))
      .mockResolvedValueOnce(response({ code: 10903, msg: '数据令牌失效' }))
      .mockResolvedValueOnce(response({ code: 200, data: { accessToken: 'bat-2' } }))
      .mockResolvedValueOnce(response({ code: 200, data: { exploreList: [] } }))
    const reportProgress = vi.fn()
    const client = new KuroCommunityClient({
      token: 'long-token',
      did: 'DEVICE-ID',
      roleId: '123456789',
      serverId: 'server-cn'
    }, fetcher, reportProgress, undefined, resolveIosDevCode)

    await expect(client.getExploration()).resolves.toEqual({ exploreList: [] })
    expect(new Headers(fetcher.mock.calls[4][1]?.headers).get('b-at')).toBe('bat-2')
    expect(reportProgress).toHaveBeenCalledWith({
      phase: 'retrying',
      message: '库街区数据令牌已失效，正在刷新后重试（1/1）',
      current: 1,
      total: 1
    })
  })

  it('长期 Token 过期时要求重新登录', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValue(response({ code: 220, msg: '登录已过期' }))
    const client = new KuroCommunityClient({
      token: 'expired',
      did: 'DEVICE-ID',
      roleId: '123456789',
      serverId: 'server-cn'
    }, fetcher, undefined, undefined, resolveIosDevCode)
    await expect(client.getTower()).rejects.toMatchObject({
      name: 'SyncVerificationRequiredError'
    })
  })

  it('临时服务错误会限次重试并回传真实重试进度', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 1005, msg: '数据准备中' }))
      .mockResolvedValueOnce(response({ code: 200, data: { accessToken: 'short-bat' } }))
      .mockResolvedValueOnce(response({ code: 200, data: {} }))
      .mockResolvedValueOnce(response({ code: 503, msg: '服务繁忙' }))
      .mockResolvedValueOnce(response({ code: 200, data: { difficultyList: [] } }))
    const reportProgress = vi.fn()
    const wait = vi.fn(async () => {})
    const client = new KuroCommunityClient({
      token: 'long-token',
      did: 'DEVICE-ID',
      roleId: '123456789',
      serverId: 'server-cn'
    }, fetcher, reportProgress, wait, resolveIosDevCode)

    await expect(client.getTower()).resolves.toEqual({ difficultyList: [] })
    expect(wait).toHaveBeenCalledTimes(2)
    expect(reportProgress).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phase: 'retrying',
      message: '库街区数据令牌暂时失败，正在重试 2/3',
      current: 2,
      total: 3
    }))
    expect(reportProgress).toHaveBeenNthCalledWith(2, expect.objectContaining({
      phase: 'retrying',
      message: '逆境深塔战绩暂时失败，正在重试 2/3'
    }))
  })

  it('登录过期和风控错误不会进入自动重试', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValue(response({ code: 270, msg: '当前环境存在风险' }))
    const wait = vi.fn(async () => {})
    const client = new KuroCommunityClient({
      token: 'long-token',
      did: 'DEVICE-ID',
      roleId: '123456789',
      serverId: 'server-cn'
    }, fetcher, undefined, wait, resolveIosDevCode)

    await expect(client.getExploration()).rejects.toMatchObject({
      name: 'SyncVerificationRequiredError'
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(wait).not.toHaveBeenCalled()
  })
})
