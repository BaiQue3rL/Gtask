import { describe, expect, it, vi } from 'vitest'
import { MiyousheZenlessClient, createMiyousheZenlessPersonalAdapter } from '../src/main/sync/miyoushe-chronicle-client'

function response(data: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

describe('MiyousheZenlessClient', () => {
  it('discovers the bound ZZZ role and normalizes both current challenge responses', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ retcode: 0, data: { list: [
        { game_biz: 'hk4e_cn', game_uid: '1001', region: 'cn_gf01' },
        { game_biz: 'nap_cn', game_uid: '10194867', region: 'prod_gf_cn' }
      ] } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: {
        hadal_ver: 'v2',
        hadal_info_v2: {
          zone_id: 62052,
          hadal_begin_time: '2026-07-10T04:00:00+08:00',
          hadal_end_time: '2026-07-24T03:59:59+08:00',
          pass_fifth_floor: true,
          brief: { score: 111142, max_score: 150000 }
        }
      } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: {
        zone_id: 69041,
        start_time: '2026-07-17T04:00:00+08:00',
        end_time: '2026-07-29T03:59:59+08:00',
        has_data: true,
        total_star: 6,
        list: [
          { star: 3, total_star: 3 },
          { star: 3, total_star: 3 }
        ]
      } }))
    const client = new MiyousheZenlessClient('cookie_token_v2=secret', fetcher)

    await expect(client.getShiyuDefense()).resolves.toMatchObject({
      schedule_id: 62052,
      passed_fifth_floor: true,
      brief_info: { score: 111142, max_score: 150000 }
    })
    await expect(client.getDeadlyAssault()).resolves.toMatchObject({
      id: 69041,
      total_star: 6
    })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(String(fetcher.mock.calls[1][0])).toContain('role_id=10194867')
    const headers = new Headers(fetcher.mock.calls[1][1]?.headers)
    expect(headers.get('cookie')).toBe('cookie_token_v2=secret')
    expect(headers.get('ds')).toMatch(/^\d+,\d+,[0-9a-f]{32}$/)
  })

  it('maps Geetest and invalid sessions to verification_required errors', async () => {
    const geetestFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({ retcode: 10035, message: 'Verification is required', data: null })
    )
    const geetestClient = new MiyousheZenlessClient('cookie=secret', geetestFetcher)
    await expect(geetestClient.getShiyuDefense()).rejects.toMatchObject({
      name: 'SyncVerificationRequiredError'
    })

    const expiredFetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({ retcode: -100, message: 'Not logged in', data: null })
    )
    const expiredClient = new MiyousheZenlessClient('cookie=secret', expiredFetcher)
    await expect(expiredClient.getShiyuDefense()).rejects.toMatchObject({
      name: 'SyncVerificationRequiredError'
    })
  })

  it('rejects retired credential payloads before a network request', () => {
    expect(() => createMiyousheZenlessPersonalAdapter(
      { kind: 'session', value: 'old-session' },
      vi.fn()
    )).toThrow('请重新登录')
  })
})
