export interface ApplicationExitRuntime {
  platform: NodeJS.Platform
  pid: number
  kill: (pid: number, signal: NodeJS.Signals) => boolean
  exit: (code: number) => never
}

const defaultRuntime: ApplicationExitRuntime = {
  platform: process.platform,
  pid: process.pid,
  kill: process.kill,
  exit: process.exit
}

/** Normal Electron shutdown must first flush Chromium preferences and storage. */
export function scheduleForcedExitFallback(
  delayMs = 5_000,
  runtime: ApplicationExitRuntime = defaultRuntime
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => terminateApplicationProcess(0, runtime), delayMs)
  timer.unref()
  return timer
}

export function terminateApplicationProcess(
  exitCode = 0,
  runtime: ApplicationExitRuntime = defaultRuntime
): never {
  if (runtime.platform === 'win32') {
    try {
      runtime.kill(runtime.pid, 'SIGKILL')
    } catch {
      // Fall through to process.exit when Windows rejects the direct termination.
    }
  }
  return runtime.exit(exitCode)
}
