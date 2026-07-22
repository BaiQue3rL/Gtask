import { describe, expect, it, vi } from 'vitest'
import {
  MiyousheGenshinClient,
  MiyousheStarRailClient,
  MiyousheZenlessClient,
  createMiyousheZenlessPersonalAdapter
} from '../src/main/sync/miyoushe-chronicle-client'

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
      .mockResolvedValueOnce(response({ retcode: 0, data: { activity_list: [] } }))
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
    await expect(client.getZenlessEventCalendar()).resolves.toEqual({ activity_list: [] })
    expect(fetcher).toHaveBeenCalledTimes(4)
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

  it('opens the injected manual solver and retries once with Geetest headers', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ retcode: 0, data: { list: [
        { game_biz: 'nap_cn', game_uid: '10194867', region: 'prod_gf_cn' }
      ] } }))
      .mockResolvedValueOnce(response({ retcode: 1034, message: 'Verification required', data: null }))
      .mockResolvedValueOnce(response({ retcode: 0, data: {
        gt: 'geetest-id',
        challenge: 'challenge-id',
        new_captcha: 1,
        success: 1
      } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: {} }))
      .mockResolvedValueOnce(response({ retcode: 0, data: {
        hadal_ver: 'v2',
        hadal_info_v2: {
          zone_id: 62052,
          hadal_begin_time: '2026-07-10T04:00:00+08:00',
          hadal_end_time: '2026-07-24T03:59:59+08:00',
          pass_fifth_floor: true,
          brief: { score: 150000, max_score: 150000 }
        }
      } }))
    const solver = vi.fn(async () => ({
      geetest_challenge: 'verified-challenge',
      geetest_validate: 'verified-validate',
      geetest_seccode: 'verified-seccode'
    }))
    const client = new MiyousheZenlessClient('cookie=secret', fetcher, solver)

    await expect(client.getShiyuDefense()).resolves.toMatchObject({ schedule_id: 62052 })
    expect(solver).toHaveBeenCalledWith({
      gt: 'geetest-id',
      challenge: 'challenge-id',
      newCaptcha: 1,
      success: 1
    })
    expect(String(fetcher.mock.calls[3][0])).toContain('/misc/api/verifyVerification')
    expect(JSON.parse(String(fetcher.mock.calls[3][1]?.body))).toEqual({
      geetest_seccode: 'verified-seccode',
      geetest_challenge: 'challenge-id',
      geetest_validate: 'verified-validate'
    })
    const retryHeaders = new Headers(fetcher.mock.calls[4][1]?.headers)
    expect(retryHeaders.get('x-rpc-challenge')).toBeNull()
    expect(retryHeaders.get('x-rpc-validate')).toBeNull()
    expect(retryHeaders.get('x-rpc-seccode')).toBeNull()
  })

  it('never opens a second verification window in the same sync batch', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ retcode: 0, data: { list: [
        { game_biz: 'nap_cn', game_uid: '10194867', region: 'prod_gf_cn' }
      ] } }))
      .mockResolvedValueOnce(response({ retcode: 1034, message: 'Verification required', data: null }))
      .mockResolvedValueOnce(response({ retcode: 0, data: {
        gt: 'geetest-id', challenge: 'challenge-id', new_captcha: 1, success: 1
      } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: {} }))
      .mockResolvedValueOnce(response({ retcode: 1034, message: 'Verification required again', data: null }))
    const solver = vi.fn(async () => ({
      geetest_challenge: 'verified-challenge',
      geetest_validate: 'verified-validate',
      geetest_seccode: 'verified-seccode'
    }))
    const client = new MiyousheZenlessClient('cookie=secret', fetcher, solver)

    await expect(client.getShiyuDefense()).rejects.toMatchObject({
      name: 'SyncVerificationRequiredError'
    })
    expect(solver).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('uses the session-bound Aigis header when the record endpoint supplies one', async () => {
    const aigis = JSON.stringify({
      session_id: 'record-session',
      data: JSON.stringify({
        gt: 'record-geetest-id',
        challenge: 'record-challenge-id',
        new_captcha: 1,
        success: 1
      })
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ retcode: 0, data: { list: [
        { game_biz: 'nap_cn', game_uid: '10194867', region: 'prod_gf_cn' }
      ] } }))
      .mockResolvedValueOnce(response(
        { retcode: 1034, message: 'Verification required', data: null },
        { 'x-rpc-aigis': aigis }
      ))
      .mockResolvedValueOnce(response(
        { retcode: 0, data: {
          hadal_ver: 'v2',
          hadal_info_v2: { zone_id: 62052, pass_fifth_floor: false }
        } },
        // The service may echo the challenge header even though retcode and
        // data show that verification succeeded.
        { 'x-rpc-aigis': aigis }
      ))
    const solver = vi.fn(async () => ({
      geetest_challenge: 'verified-challenge',
      geetest_validate: 'verified-validate',
      geetest_seccode: 'verified-seccode'
    }))
    const client = new MiyousheZenlessClient('cookie=secret', fetcher, solver)

    await expect(client.getShiyuDefense()).resolves.toMatchObject({ schedule_id: 62052 })
    expect(solver).toHaveBeenCalledWith({
      gt: 'record-geetest-id',
      challenge: 'record-challenge-id',
      newCaptcha: 1,
      success: 1,
      sessionId: 'record-session'
    })
    const retryHeaders = new Headers(fetcher.mock.calls[2][1]?.headers)
    const aigisHeader = retryHeaders.get('x-rpc-aigis')!
    const [sessionId, encoded] = aigisHeader.split(';')
    expect(sessionId).toBe('record-session')
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual({
      geetest_challenge: 'verified-challenge',
      geetest_validate: 'verified-validate',
      geetest_seccode: 'verified-seccode'
    })
    expect(retryHeaders.get('x-rpc-challenge')).toBeNull()
  })

  it('uses a session-bound Geetest V4 result when the record endpoint requests it', async () => {
    const aigis = JSON.stringify({
      session_id: 'record-v4-session',
      data: JSON.stringify({
        gt: 'record-v4-captcha-id',
        risk_type: 'slide',
        use_v4: true
      })
    })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ retcode: 0, data: { list: [
        { game_biz: 'nap_cn', game_uid: '10194867', region: 'prod_gf_cn' }
      ] } }))
      .mockResolvedValueOnce(response(
        { retcode: 1034, message: 'Verification required', data: null },
        { 'x-rpc-aigis': aigis }
      ))
      .mockResolvedValueOnce(response({ retcode: 0, data: {
        hadal_ver: 'v2',
        hadal_info_v2: { zone_id: 62052, pass_fifth_floor: false }
      } }))
    const solver = vi.fn(async () => ({
      captcha_id: 'record-v4-captcha-id',
      lot_number: 'verified-lot-number',
      pass_token: 'verified-pass-token',
      gen_time: '1753180000',
      captcha_output: 'verified-captcha-output',
      version: 4 as const
    }))
    const client = new MiyousheZenlessClient('cookie=secret', fetcher, solver)

    await expect(client.getShiyuDefense()).resolves.toMatchObject({ schedule_id: 62052 })
    expect(solver).toHaveBeenCalledWith({
      gt: 'record-v4-captcha-id',
      riskType: 'slide',
      sessionId: 'record-v4-session',
      version: 4
    })
    const retryHeaders = new Headers(fetcher.mock.calls[2][1]?.headers)
    const aigisHeader = retryHeaders.get('x-rpc-aigis')!
    const [sessionId, encoded] = aigisHeader.split(';')
    expect(sessionId).toBe('record-v4-session')
    expect(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))).toEqual({
      captcha_id: 'record-v4-captcha-id',
      lot_number: 'verified-lot-number',
      pass_token: 'verified-pass-token',
      gen_time: '1753180000',
      captcha_output: 'verified-captcha-output'
    })
    expect(retryHeaders.get('x-rpc-challenge')).toBeNull()
  })

  it('rejects retired credential payloads before a network request', () => {
    expect(() => createMiyousheZenlessPersonalAdapter(
      { kind: 'session', value: 'old-session' },
      vi.fn()
    )).toThrow('请重新登录')
  })
})

describe('MiyousheGenshinClient', () => {
  it('uses the bound Genshin role for profile, three endgame endpoints and activities', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ retcode: 0, data: { list: [
        { game_biz: 'hk4e_cn', game_uid: '100071776', region: 'cn_gf01' }
      ] } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: { world_explorations: [] } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: { schedule_id: 1 } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: { is_unlock: true, data: [] } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: { data: [] } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: { act_list: [] } }))
    const client = new MiyousheGenshinClient('cookie=secret', fetcher)

    await client.getProfile()
    await client.getSpiralAbyss()
    await client.getImaginariumTheater()
    await client.getStygianOnslaught()
    await client.getEventCalendar()

    expect(fetcher).toHaveBeenCalledTimes(6)
    expect(String(fetcher.mock.calls[1][0])).toContain('/genshin/api/index')
    expect(String(fetcher.mock.calls[2][0])).toContain('/genshin/api/spiralAbyss')
    expect(String(fetcher.mock.calls[3][0])).toContain('/genshin/api/role_combat')
    expect(String(fetcher.mock.calls[4][0])).toContain('/genshin/api/hard_challenge')
    expect(String(fetcher.mock.calls[5][0])).toContain('/genshin/api/act_calendar')
    expect(fetcher.mock.calls[5][1]?.method).toBe('POST')
    const profileHeaders = new Headers(fetcher.mock.calls[1][1]?.headers)
    expect(profileHeaders.get('x-rpc-device_id')).toBeNull()
    expect(profileHeaders.get('x-rpc-device_fp')).toBeNull()
    expect(JSON.parse(String(fetcher.mock.calls[5][1]?.body))).toEqual({
      role_id: '100071776',
      server: 'cn_gf01'
    })
    for (const call of fetcher.mock.calls.slice(1, 5)) {
      expect(String(call[0])).toContain('role_id=100071776')
      expect(String(call[0])).toContain('server=cn_gf01')
    }
  })

  it('registers a stable per-account fingerprint before requesting Genshin records', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ retcode: 0, data: { list: [
        { game_biz: 'hk4e_cn', game_uid: '100071776', region: 'cn_gf01' }
      ] } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: { device_fp: 'account-device-fp' } }))
      .mockResolvedValueOnce(response({ retcode: 0, data: { world_explorations: [] } }))
    const client = new MiyousheGenshinClient(
      'account_id_v2=12345678; cookie_token_v2=secret',
      fetcher
    )

    await client.getProfile()

    expect(String(fetcher.mock.calls[1][0])).toContain('/device-fp/api/getFp')
    const fingerprintBody = JSON.parse(String(fetcher.mock.calls[1][1]?.body))
    expect(fingerprintBody.device_id).toMatch(/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/)
    const profileHeaders = new Headers(fetcher.mock.calls[2][1]?.headers)
    expect(profileHeaders.get('x-rpc-device_id')).toBeNull()
    expect(profileHeaders.get('x-rpc-device_fp')).toBe('account-device-fp')
  })
})

describe('MiyousheStarRailClient', () => {
  it('uses the bound Star Rail role for all current endgame endpoints and activities', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ retcode: 0, data: { list: [
        { game_biz: 'hkrpg_cn', game_uid: '100000001', region: 'prod_gf_cn' }
      ] } }))
      .mockImplementation(async () => response({ retcode: 0, data: { groups: [] } }))
    const client = new MiyousheStarRailClient('cookie=secret', fetcher)

    await client.getMemoryOfChaos()
    await client.getPureFiction()
    await client.getApocalypticShadow()
    await client.getAnomalyArbitration()
    const challengeHeaders = new Headers(fetcher.mock.calls[1][1]?.headers)
    expect(challengeHeaders.get('x-rpc-device_id')).toBeNull()
    expect(challengeHeaders.get('x-rpc-device_fp')).toBeNull()
    await client.getEventCalendar()

    expect(fetcher).toHaveBeenCalledTimes(6)
    expect(String(fetcher.mock.calls[1][0])).toContain('/hkrpg/api/challenge?')
    expect(String(fetcher.mock.calls[2][0])).toContain('/hkrpg/api/challenge_story?')
    expect(String(fetcher.mock.calls[3][0])).toContain('/hkrpg/api/challenge_boss?')
    expect(String(fetcher.mock.calls[4][0])).toContain('/hkrpg/api/challenge_peak?')
    expect(String(fetcher.mock.calls[4][0])).toContain('schedule_type=3')
    expect(String(fetcher.mock.calls[5][0])).toContain('/hkrpg/api/get_act_calender?')
    for (const call of fetcher.mock.calls.slice(1)) {
      expect(String(call[0])).toContain('role_id=100000001')
      expect(String(call[0])).toContain('server=prod_gf_cn')
    }
  })
})
