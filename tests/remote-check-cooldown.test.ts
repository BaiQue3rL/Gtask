import { describe, expect, it } from 'vitest'
import {
  AUTOMATIC_REMOTE_CHECK_COOLDOWN_MS,
  MANUAL_REMOTE_CATALOG_COOLDOWN_MS,
  automaticRemoteCheckDelay,
  remoteCheckCooldownRemaining
} from '../src/main/remote-check-cooldown'

describe('automatic remote check cooldown', () => {
  const reference = new Date('2026-08-11T12:00:00.000Z')

  it('uses the normal startup delay when no valid attempt was persisted', () => {
    expect(automaticRemoteCheckDelay(null, reference, 750)).toBe(750)
    expect(automaticRemoteCheckDelay('invalid', reference, 2_000)).toBe(2_000)
  })

  it('keeps automatic requests quiet across restarts for twenty-four hours', () => {
    expect(automaticRemoteCheckDelay('2026-08-11T10:00:00.000Z', reference, 750))
      .toBe(22 * 60 * 60 * 1_000)
  })

  it('runs normally after the cooldown and tolerates a backwards system clock', () => {
    expect(automaticRemoteCheckDelay(
      new Date(reference.getTime() - AUTOMATIC_REMOTE_CHECK_COOLDOWN_MS).toISOString(),
      reference,
      750
    )).toBe(750)
    expect(automaticRemoteCheckDelay('2026-08-12T12:00:00.000Z', reference, 750)).toBe(750)
  })

  it('keeps a successful manual catalog check quiet for one hour', () => {
    expect(remoteCheckCooldownRemaining(
      '2026-08-11T11:30:00.000Z',
      reference,
      MANUAL_REMOTE_CATALOG_COOLDOWN_MS
    )).toBe(30 * 60 * 1_000)
    expect(remoteCheckCooldownRemaining(
      '2026-08-11T11:00:00.000Z',
      reference,
      MANUAL_REMOTE_CATALOG_COOLDOWN_MS
    )).toBe(0)
  })
})
