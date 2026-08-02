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
