import { describe, expect, it, vi } from 'vitest'
import { KuroCommunityCredentialService } from '../src/main/auth/kuro-community-credential'

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}
const resolveIosDevCode = async (): Promise<string> => '203.0.113.8, KuroGameBox/Test'

describe('KuroCommunityCredentialService', () => {
  it('从官方角色列表只读取鸣潮角色', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      code: 200,
      data: [
        {
          gameId: 2,
          roleId: 'pgr-role',
          roleName: '指挥官',
          serverId: 'pgr',
          serverName: '战双'
        },
        {
          gameId: 3,
          roleId: '123456789',
          roleName: '漂泊者',
          serverId: '76402e5b20be2c39f095a152090afddc',
          serverName: '潮起测试服'
        }
      ]
    }))
    const service = new KuroCommunityCredentialService(fetcher, resolveIosDevCode)

    await expect(service.listRoles('app-token', 'DEVICE-ID')).resolves.toEqual([
      {
        roleId: '123456789',
        roleName: '漂泊者',
        serverId: '76402e5b20be2c39f095a152090afddc',
        serverName: '潮起测试服'
      }
    ])
    expect(String(fetcher.mock.calls[0][0])).toContain('/gamer/role/list')
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('token')).toBe('app-token')
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('devCode')).toBe('DEVICE-ID')
    expect(fetcher.mock.calls[0][1]?.body).toBe('gameId=3')
  })

  it('通过短期 BAT 刷新验证所选角色后返回可保存凭据', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      code: 200,
      data: { accessToken: 'short-lived-bat' }
    }))
    const service = new KuroCommunityCredentialService(fetcher, resolveIosDevCode)

    await expect(service.validateCredential({
      token: 'app-token',
      did: 'DEVICE-ID',
      roleId: '123456789',
      roleName: '漂泊者',
      serverId: 'server-cn'
    })).resolves.toEqual({
      token: 'app-token',
      did: 'DEVICE-ID',
      roleId: '123456789',
      roleName: '漂泊者',
      serverId: 'server-cn'
    })
    expect(String(fetcher.mock.calls[0][0])).toContain('/aki/roleBox/requestToken')
    const headers = new Headers(fetcher.mock.calls[0][1]?.headers)
    expect(headers.get('did')).toBe('DEVICE-ID')
    expect(headers.get('b-at')).toBe('')
    expect(headers.get('devCode')).toBe('203.0.113.8, KuroGameBox/Test')
    expect(String(fetcher.mock.calls[0][1]?.body)).toContain('roleId=123456789')
  })

  it('兼容库街区直接把 BAT 放在 data 字符串中的新格式', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      code: 200,
      data: 'eyJhbGciOiJIUzI1NiJ9.payload.signature'
    }))
    const service = new KuroCommunityCredentialService(fetcher, resolveIosDevCode)

    await expect(service.validateCredential({
      token: 'app-token',
      did: 'DEVICE-ID',
      roleId: '123456789',
      serverId: 'server-cn'
    })).resolves.toMatchObject({
      token: 'app-token',
      roleId: '123456789'
    })
  })

  it('无角色或 BAT 无效时拒绝导入', async () => {
    const noRoleFetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      code: 200,
      data: []
    }))
    await expect(
      new KuroCommunityCredentialService(noRoleFetcher, resolveIosDevCode)
        .listRoles('token', 'did')
    ).rejects.toThrow('没有找到已绑定的鸣潮角色')

    const noBatFetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      code: 200,
      data: {}
    }))
    await expect(
      new KuroCommunityCredentialService(noBatFetcher, resolveIosDevCode)
        .validateCredential({
        token: 'token',
        did: 'did',
        roleId: '123',
        serverId: 'server'
      })
    ).rejects.toThrow('凭据未保存')
  })

  it('明确提示 App Token 已过期', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      code: 220,
      msg: '登录已过期'
    }))
    const service = new KuroCommunityCredentialService(fetcher, resolveIosDevCode)

    await expect(service.listRoles('expired-token', 'DEVICE-ID'))
      .rejects.toThrow('App Token 已过期')
  })
})
