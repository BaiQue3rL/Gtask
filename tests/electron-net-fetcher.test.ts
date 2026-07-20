import { describe, expect, it, vi } from 'vitest'
import { createElectronNetFetcher } from '../src/main/sync/electron-net-fetcher'

describe('Electron 网络传输适配', () => {
  it('将 URL 规范化后交给 Chromium 网络栈并绕过自定义协议处理器', async () => {
    const response = new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
    const netFetch = vi.fn(async () => response)
    const fetcher = createElectronNetFetcher(netFetch)
    const controller = new AbortController()

    await expect(
      fetcher(new URL('https://schedule.example/game.json'), {
        method: 'GET',
        signal: controller.signal
      })
    ).resolves.toBe(response)
    expect(netFetch).toHaveBeenCalledWith('https://schedule.example/game.json', {
      method: 'GET',
      signal: controller.signal,
      bypassCustomProtocolHandlers: true
    })
  })

  it('保留 Request 对象和调用方请求头', async () => {
    const request = new Request('https://schedule.example/game.json')
    const netFetch = vi.fn(async () => new Response('{}'))
    const fetcher = createElectronNetFetcher(netFetch)

    await fetcher(request, { headers: { accept: 'application/json' } })
    expect(netFetch).toHaveBeenCalledWith(request, {
      headers: { accept: 'application/json' },
      bypassCustomProtocolHandlers: true
    })
  })
})
