import { describe, expect, it, vi } from 'vitest'
import { KuroCommunityLoginService } from '../src/main/auth/kuro-community-login'

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

describe('KuroCommunityLoginService', () => {
  it('通过官方滑块、短信验证码和角色查询生成最小长期凭据', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 200, success: true, data: null }))
      .mockResolvedValueOnce(response({ code: 200, data: { token: 'long-token' } }))
      .mockResolvedValueOnce(response({ code: 200, data: [{
        gameId: 3,
        roleId: '123456789',
        roleName: '漂泊者',
        serverId: 'server-cn'
      }] }))
      .mockResolvedValueOnce(response({ code: 200, data: { accessToken: 'short-bat' } }))
    const solveCaptcha = vi.fn(async () => ({
      captcha_id: 'captcha',
      lot_number: 'lot',
      pass_token: 'pass',
      gen_time: 'time',
      captcha_output: 'output'
    }))
    const service = new KuroCommunityLoginService(fetcher, solveCaptcha)

    await expect(service.requestSmsCode('13800138000')).resolves.toEqual({
      message: '验证码已发送，请输入短信验证码',
      phoneMasked: '138****8000'
    })
    await expect(service.completeLogin('13800138000', '123456')).resolves.toMatchObject({
      token: 'long-token',
      roleId: '123456789',
      roleName: '漂泊者',
      serverId: 'server-cn'
    })
    expect(solveCaptcha).toHaveBeenCalledWith('ec4aa4174277d822d73f2442a165a2cd')
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(String(fetcher.mock.calls[0][0])).toContain('/user/getSmsCodeForH5')
    expect(String(fetcher.mock.calls[1][0])).toContain('/user/sdkLogin')
    expect(new Headers(fetcher.mock.calls[2][1]?.headers).get('token')).toBe('long-token')
    expect(String(fetcher.mock.calls[3][0])).toContain('/aki/roleBox/requestToken')
  })

  it('拒绝未获取验证码或过期的登录会话', async () => {
    const service = new KuroCommunityLoginService(
      vi.fn<typeof fetch>(),
      vi.fn(async () => null)
    )
    await expect(service.completeLogin('13800138000', '123456')).rejects.toThrow('已过期')
  })

  it('可将库街区官网回传的访问令牌换成鸣潮长期凭据', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 200, data: [{
        gameId: 3,
        roleId: '987654321',
        roleName: '漂泊者',
        serverId: 'server-cn'
      }] }))
      .mockResolvedValueOnce(response({ code: 200, data: { accessToken: 'short-bat' } }))
    const service = new KuroCommunityLoginService(fetcher, vi.fn(async () => null))

    await expect(service.completeWebLogin('official-web-token')).resolves.toMatchObject({
      token: 'official-web-token',
      roleId: '987654321',
      roleName: '漂泊者',
      serverId: 'server-cn'
    })
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('token')).toBe(
      'official-web-token'
    )
    expect(String(fetcher.mock.calls[1][0])).toContain('/aki/roleBox/requestToken')
  })
})
