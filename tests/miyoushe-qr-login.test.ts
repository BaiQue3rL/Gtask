import { describe, expect, it, vi } from 'vitest'
import { MiyousheQrLoginService } from '../src/main/auth/miyoushe-qr-login'

function jsonResponse(data: unknown, setCookie?: string): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      ...(setCookie ? { 'set-cookie': setCookie } : {})
    }
  })
}

describe('MiyousheQrLoginService', () => {
  it('creates a local QR image and stores credentials only after phone confirmation', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ retcode: 0, data: { ticket: 'ticket-1', url: 'https://example.com/qr' } }))
      .mockResolvedValueOnce(jsonResponse({ retcode: 0, data: { status: 'Scanned' } }))
      .mockResolvedValueOnce(jsonResponse(
        { retcode: 0, data: { status: 'Confirmed' } },
        [
          'cookie_token_v2=cookie-token; Path=/',
          'account_mid_v2=mid; Path=/',
          'account_id_v2=12345; Path=/',
          'ltoken_v2=ltoken; Path=/',
          'ltmid_v2=ltmid; Path=/',
          'ltuid_v2=12345; Path=/'
        ].join(', ')
      ))
    const service = new MiyousheQrLoginService(fetcher, () => Date.parse('2026-07-21T16:00:00.000Z'))

    const started = await service.start()
    expect(started.status).toBe('waiting_scan')
    expect(started.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/)

    const scanned = await service.poll(started.sessionId)
    expect(scanned.state.status).toBe('waiting_confirmation')
    expect(scanned.credential).toBeNull()

    const confirmed = await service.poll(started.sessionId)
    expect(confirmed.state.status).toBe('confirmed')
    expect(confirmed.credential).toEqual({
      accountLabel: '12345',
      cookie: 'cookie_token_v2=cookie-token; account_mid_v2=mid; account_id_v2=12345; ltoken_v2=ltoken; ltmid_v2=ltmid; ltuid_v2=12345'
    })
    await expect(service.poll(started.sessionId)).rejects.toThrow('会话不存在')
  })

  it('expires an old session without another network request', async () => {
    let now = Date.parse('2026-07-21T16:00:00.000Z')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({ retcode: 0, data: { ticket: 'ticket-2', url: 'https://example.com/qr' } })
    )
    const service = new MiyousheQrLoginService(fetcher, () => now)
    const started = await service.start()
    now += 5 * 60 * 1000

    const result = await service.poll(started.sessionId)
    expect(result.state.status).toBe('expired')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('rejects a confirmed response without the full credential set', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ retcode: 0, data: { ticket: 'ticket-3', url: 'https://example.com/qr' } }))
      .mockResolvedValueOnce(jsonResponse(
        { retcode: 0, data: { status: 'Confirmed' } },
        'account_id_v2=12345; Path=/'
      ))
    const service = new MiyousheQrLoginService(fetcher)
    const started = await service.start()

    await expect(service.poll(started.sessionId)).rejects.toThrow('登录凭据不完整')
  })
})
