import { describe, expect, it, vi } from 'vitest'
import {
  KURO_IOS_USER_AGENT,
  resolveKuroIosDevCode
} from '../src/main/auth/kuro-community-device'

describe('resolveKuroIosDevCode', () => {
  it('uses the current Kuro-visible public IP and caches it per fetcher', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('203.0.113.8', { status: 200 })
    )

    await expect(resolveKuroIosDevCode(fetcher))
      .resolves.toBe(`203.0.113.8, ${KURO_IOS_USER_AGENT}`)
    await resolveKuroIosDevCode(fetcher)

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[0][0])).toBe('https://event.kurobbs.com/event/ip')
  })

  it('uses the mature-client fallback identity when IP lookup fails', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))

    await expect(resolveKuroIosDevCode(fetcher))
      .resolves.toBe(`127.127.127.127, ${KURO_IOS_USER_AGENT}`)
  })
})
