import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export interface RelaunchOptions {
  execPath: string
  args: string[]
}

export function resolveStablePackagedExecutable(
  environment: NodeJS.ProcessEnv,
  fallbackExecutable: string,
  exists: (path: string) => boolean = existsSync
): string {
  const portableExecutable = environment.PORTABLE_EXECUTABLE_FILE?.trim()
  if (
    portableExecutable &&
    isAbsolute(portableExecutable) &&
    portableExecutable.toLowerCase().endsWith('.exe') &&
    exists(portableExecutable)
  ) {
    return portableExecutable
  }
  return fallbackExecutable
}

export function restoreRelaunchOptions(
  environment: NodeJS.ProcessEnv,
  argv: readonly string[]
): RelaunchOptions | undefined {
  const portableExecutable = environment.PORTABLE_EXECUTABLE_FILE?.trim()
  if (!portableExecutable) return undefined
  if (!isAbsolute(portableExecutable) || !portableExecutable.toLowerCase().endsWith('.exe')) {
    throw new Error('便携版重启路径格式不正确')
  }
  if (!existsSync(portableExecutable)) throw new Error('找不到便携版启动程序，数据已恢复，请手动重新打开')
  return {
    execPath: portableExecutable,
    args: [...argv.slice(1)]
  }
}
