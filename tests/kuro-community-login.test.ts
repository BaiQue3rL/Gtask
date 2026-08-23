import { describe, expect, it, vi } from 'vitest'
import { KuroCommunityLoginService } from '../src/main/auth/kuro-community-login'
import type { KuroCommunityCredentialService } from '../src/main/auth/kuro-community-credential'

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

const geetest = {
  captcha_id: 'captcha-id',
  lot_number: 'lot-number',
  pass_token: 'pass-token',
  gen_time: 'gen-time',
  captcha_output: 'captcha-output',
  version: 4 as const
}
const resolveIosDevCode = async (): Promise<string> => '203.0.113.8, KuroGameBox/Test'

describe('KuroCommunityLoginService', () => {
  it('自动生成 DID 并用同一设备标识完成短信登录', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 200, success: true }))
      .mockResolvedValueOnce(response({
        code: 200,
        data: { token: 'app-token', userId: 'account-id' }
      }))
    const credentialService = {
      listRoles: vi.fn().mockResolvedValue([
        {
          roleId: '123456789',
          roleName: '漂泊者',
          serverId: 'server-cn',
          serverName: '潮起测试服'
        }
      ]),
      validateCredential: vi.fn().mockImplementation(async (value) => value)
    } as unknown as KuroCommunityCredentialService
    const service = new KuroCommunityLoginService(
      credentialService,
      fetcher,
      () => Date.parse('2026-07-24T12:00:00.000Z'),
      resolveIosDevCode
    )

    const sms = await service.sendSms('13800138000', geetest)
    const login = await service.complete(sms.sessionId, '123456')
    const credential = await service.finish(
      login.sessionId,
      '123456789',
      'server-cn'
    )

    const smsHeaders = new Headers(fetcher.mock.calls[0][1]?.headers)
    const loginHeaders = new Headers(fetcher.mock.calls[1][1]?.headers)
    expect(String(fetcher.mock.calls[0][0])).toContain('/user/getSmsCodeForH5')
    expect(String(fetcher.mock.calls[1][0])).toContain('/user/sdkLogin')
    expect(smsHeaders.get('source')).toBe('h5')
    expect(loginHeaders.get('source')).toBe('ios')
    expect(smsHeaders.get('devCode')).toMatch(/^[0-9A-F-]{36}$/)
    expect(loginHeaders.get('devCode')).toBe('203.0.113.8, KuroGameBox/Test')
    expect(fetcher.mock.calls[0][1]?.body).toContain('geeTestData=')
    expect(fetcher.mock.calls[1][1]?.body).toContain('code=123456')
    expect(credentialService.listRoles).toHaveBeenCalledWith(
      'app-token',
      smsHeaders.get('devCode')
    )
    expect(credential).toMatchObject({
      token: 'app-token',
      did: smsHeaders.get('devCode'),
      roleId: '123456789',
      serverId: 'server-cn'
    })
  })

  it('不会允许界面保存不属于本次登录账号的角色', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 200 }))
      .mockResolvedValueOnce(response({ code: 200, data: { token: 'app-token' } }))
    const credentialService = {
      listRoles: vi.fn().mockResolvedValue([
        {
          roleId: '123',
          roleName: '漂泊者',
          serverId: 'server-cn',
          serverName: null
        }
      ]),
      validateCredential: vi.fn()
    } as unknown as KuroCommunityCredentialService
    const service = new KuroCommunityLoginService(
      credentialService,
      fetcher,
      Date.now,
      resolveIosDevCode
    )
    const sms = await service.sendSms('13800138000', geetest)
    await service.complete(sms.sessionId, '123456')

    await expect(
      service.finish(sms.sessionId, 'other-role', 'server-cn')
    ).rejects.toThrow('不属于刚才登录的账号')
    expect(credentialService.validateCredential).not.toHaveBeenCalled()
  })

  it('明确区分验证码错误和过期', async () => {
    const credentialService = {
      listRoles: vi.fn(),
      validateCredential: vi.fn()
    } as unknown as KuroCommunityCredentialService

    const wrongCodeFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 200 }))
      .mockResolvedValueOnce(response({ code: 130, msg: '验证码错误' }))
    const wrongCodeService = new KuroCommunityLoginService(
      credentialService,
      wrongCodeFetcher,
      Date.now,
      resolveIosDevCode
    )
    const wrongCodeSms = await wrongCodeService.sendSms('13800138000', geetest)
    await expect(
      wrongCodeService.complete(wrongCodeSms.sessionId, '123456')
    ).rejects.toThrow('短信验证码错误')

    const expiredFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code: 200 }))
      .mockResolvedValueOnce(response({ code: 132, msg: '验证码已过期' }))
    const expiredService = new KuroCommunityLoginService(
      credentialService,
      expiredFetcher,
      Date.now,
      resolveIosDevCode
    )
    const expiredSms = await expiredService.sendSms('13800138000', geetest)
    await expect(
      expiredService.complete(expiredSms.sessionId, '123456')
    ).rejects.toThrow('短信验证码已过期')
  })
})
