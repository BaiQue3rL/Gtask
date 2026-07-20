import { describe, expect, it, vi } from 'vitest'
import { createElectronPublicScheduleAdapter } from '../src/main/sync/electron-public-schedule-adapter'

describe('Electron 公开排期适配器装配', () => {
  it('串联 Chromium 传输、HTTP 约束和公开文档校验', async () => {
    const document = {
      schemaVersion: 1,
      gameId: 'genshin',
      sourceUrl: 'https://official.example/events',
      fetchedAt: '2026-07-20T02:00:00.000Z',
      items: [
        {
          remoteKey: 'event:one',
          category: 'limited_event',
          title: '公开活动',
          completed: true,
          endsAt: '2026-07-30T02:00:00.000Z'
        }
      ]
    }
    const netFetch = vi.fn(async () =>
      new Response(JSON.stringify(document), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const adapter = createElectronPublicScheduleAdapter(netFetch, {
      urls: { genshin: 'https://feed.example/genshin.json' },
      allowedHosts: ['feed.example'],
      document: { now: () => new Date('2026-07-20T02:30:00.000Z') }
    })

    const output = await adapter.sync('genshin')
    expect(output.items).toEqual([
      expect.objectContaining({
        remoteKey: 'event:one',
        title: '公开活动',
        completed: undefined,
        scheduleKind: 'fixed_window'
      })
    ])
    expect(netFetch).toHaveBeenCalledWith(
      'https://feed.example/genshin.json',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        bypassCustomProtocolHandlers: true
      })
    )
  })

  it('仍由 HTTP 层拒绝白名单之外的来源', async () => {
    const adapter = createElectronPublicScheduleAdapter(vi.fn(), {
      urls: { genshin: 'https://untrusted.example/genshin.json' },
      allowedHosts: ['feed.example']
    })

    await expect(adapter.sync('genshin')).rejects.toThrow('域名不在白名单')
  })
})
