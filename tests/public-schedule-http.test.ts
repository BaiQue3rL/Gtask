import { describe, expect, it, vi } from 'vitest'
import { createPublicScheduleHttpLoader } from '../src/main/sync/public-schedule-http'

function jsonResponse(value: unknown, overrides: Partial<Response> = {}): Response {
  const body = new TextEncoder().encode(JSON.stringify(value)).buffer
  return {
    ok: true,
    status: 200,
    url: 'https://schedule.example.com/genshin.json',
    headers: new Headers({ 'content-type': 'application/json' }),
    arrayBuffer: async () => body,
    ...overrides
  } as Response
}

describe('公开排期 HTTP loader', () => {
  it('只从 HTTPS 白名单域名读取有大小限制的 JSON', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ schemaVersion: 1 }))
    const load = createPublicScheduleHttpLoader({
      urls: { genshin: 'https://schedule.example.com/genshin.json' },
      allowedHosts: ['schedule.example.com'],
      fetcher
    })

    await expect(load('genshin')).resolves.toEqual({ schemaVersion: 1 })
    expect(fetcher).toHaveBeenCalledWith(
      new URL('https://schedule.example.com/genshin.json'),
      expect.objectContaining({ method: 'GET', redirect: 'manual' })
    )
  })

  it('拒绝 HTTP、非白名单来源和跳转到非白名单域名', async () => {
    expect(() =>
      createPublicScheduleHttpLoader({
        urls: { genshin: 'http://schedule.example.com/genshin.json' },
        allowedHosts: ['schedule.example.com']
      })('genshin')
    ).rejects.toThrow('只允许 HTTPS')

    const unlisted = createPublicScheduleHttpLoader({
      urls: { genshin: 'https://untrusted.example/genshin.json' },
      allowedHosts: ['schedule.example.com']
    })
    await expect(unlisted('genshin')).rejects.toThrow('不在白名单')

    const redirected = createPublicScheduleHttpLoader({
      urls: { genshin: 'https://schedule.example.com/genshin.json' },
      allowedHosts: ['schedule.example.com'],
      fetcher: async () =>
        jsonResponse({}, {
          ok: false,
          status: 302,
          headers: new Headers({ location: 'https://redirected.example/payload.json' })
        })
    })
    await expect(redirected('genshin')).rejects.toThrow('不在白名单')
  })

  it('允许白名单内的有限相对跳转并拒绝跳转循环', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({}, {
          ok: false,
          status: 302,
          headers: new Headers({ location: '/current/genshin.json' })
        })
      )
      .mockResolvedValueOnce(jsonResponse({ schemaVersion: 1 }))
    const load = createPublicScheduleHttpLoader({
      urls: { genshin: 'https://schedule.example.com/genshin.json' },
      allowedHosts: ['schedule.example.com'],
      fetcher
    })
    await expect(load('genshin')).resolves.toEqual({ schemaVersion: 1 })
    expect(fetcher.mock.calls[1][0]).toEqual(
      new URL('https://schedule.example.com/current/genshin.json')
    )

    const looping = createPublicScheduleHttpLoader({
      urls: { genshin: 'https://schedule.example.com/a.json' },
      allowedHosts: ['schedule.example.com'],
      maximumRedirects: 1,
      fetcher: async () =>
        jsonResponse({}, {
          ok: false,
          status: 302,
          headers: new Headers({ location: '/again.json' })
        })
    })
    await expect(looping('genshin')).rejects.toThrow('跳转次数过多')
  })

  it('拒绝错误内容类型、超大响应和超时请求', async () => {
    const wrongType = createPublicScheduleHttpLoader({
      urls: { genshin: 'https://schedule.example.com/genshin.json' },
      allowedHosts: ['schedule.example.com'],
      fetcher: async () =>
        jsonResponse({}, { headers: new Headers({ 'content-type': 'text/html' }) })
    })
    await expect(wrongType('genshin')).rejects.toThrow('不是 JSON')

    const oversized = createPublicScheduleHttpLoader({
      urls: { genshin: 'https://schedule.example.com/genshin.json' },
      allowedHosts: ['schedule.example.com'],
      maximumBytes: 10,
      fetcher: async () => jsonResponse({ payload: 'too large' })
    })
    await expect(oversized('genshin')).rejects.toThrow('超过大小限制')

    const streamedOversized = createPublicScheduleHttpLoader({
      urls: { genshin: 'https://schedule.example.com/genshin.json' },
      allowedHosts: ['schedule.example.com'],
      maximumBytes: 10,
      fetcher: async () =>
        new Response(JSON.stringify({ payload: 'streamed and too large' }), {
          headers: { 'content-type': 'application/json' }
        })
    })
    await expect(streamedOversized('genshin')).rejects.toThrow('超过大小限制')

    const timedOut = createPublicScheduleHttpLoader({
      urls: { genshin: 'https://schedule.example.com/genshin.json' },
      allowedHosts: ['schedule.example.com'],
      timeoutMs: 5,
      fetcher: async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    await expect(timedOut('genshin')).rejects.toThrow('请求超时')
  })
})
