import { describe, expect, it, vi } from 'vitest'
import { scheduleForcedExitFallback, terminateApplicationProcess, type ApplicationExitRuntime } from '../src/main/application-exit'

function runtime(platform: NodeJS.Platform): {
  value: ApplicationExitRuntime
  kill: ReturnType<typeof vi.fn>
  exit: ReturnType<typeof vi.fn>
} {
  const kill = vi.fn(() => true)
  const exit = vi.fn(() => {
    throw new Error('exit')
  })
  return {
    value: { platform, pid: 321, kill, exit },
    kill,
    exit
  }
}

describe('application process termination', () => {
  it('allows graceful shutdown and only force-exits when the watchdog expires', () => {
    vi.useFakeTimers()
    try {
      const fixture = runtime('win32')
      scheduleForcedExitFallback(5_000, fixture.value)
      vi.advanceTimersByTime(4_999)
      expect(fixture.kill).not.toHaveBeenCalled()
      expect(() => vi.advanceTimersByTime(1)).toThrow('exit')
      expect(fixture.kill).toHaveBeenCalledWith(321, 'SIGKILL')
    } finally { vi.useRealTimers() }
  })
  it('force-terminates the Windows process after runtime cleanup', () => {
    const fixture = runtime('win32')
    expect(() => terminateApplicationProcess(0, fixture.value)).toThrow('exit')
    expect(fixture.kill).toHaveBeenCalledWith(321, 'SIGKILL')
    expect(fixture.exit).toHaveBeenCalledWith(0)
  })

  it('uses the normal process exit fallback on other platforms', () => {
    const fixture = runtime('linux')
    expect(() => terminateApplicationProcess(2, fixture.value)).toThrow('exit')
    expect(fixture.kill).not.toHaveBeenCalled()
    expect(fixture.exit).toHaveBeenCalledWith(2)
  })
})
