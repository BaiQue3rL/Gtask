import { describe, expect, it } from 'vitest'
import {
  AUTOMATIC_REMOTE_CHECK_COOLDOWN_MS,
  automaticRemoteCheckDelay
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
})
