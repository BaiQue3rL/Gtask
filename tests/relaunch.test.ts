import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  resolveStablePackagedExecutable,
  restoreRelaunchOptions
} from '../src/main/relaunch'

let temporaryDirectory: string | null = null

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe('恢复后的应用重启', () => {
  it('普通解包/安装环境沿用 Electron 默认重启', () => {
    expect(restoreRelaunchOptions({}, ['app.exe'])).toBeUndefined()
  })

  it('单文件便携环境重启原始启动器并保留用户参数', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-portable-relaunch-test-'))
    const portableExecutable = join(temporaryDirectory, 'Gtask-portable.exe')
    writeFileSync(portableExecutable, 'test')

    expect(
      restoreRelaunchOptions(
        { PORTABLE_EXECUTABLE_FILE: portableExecutable },
        ['temporary-unpacked.exe', '--user-data-dir=D:\\GTM-Test']
      )
    ).toEqual({
      execPath: portableExecutable,
      args: ['--user-data-dir=D:\\GTM-Test']
    })
  })

  it('拒绝不存在或不是绝对 EXE 路径的便携启动器', () => {
    expect(() =>
      restoreRelaunchOptions({ PORTABLE_EXECUTABLE_FILE: 'relative.exe' }, ['app.exe'])
    ).toThrow('路径格式不正确')
  })

  it('MCP 启动器优先使用不会随解包目录消失的便携版入口', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-portable-entry-test-'))
    const portableExecutable = join(temporaryDirectory, 'Gtask-portable.exe')
    writeFileSync(portableExecutable, 'test')

    expect(resolveStablePackagedExecutable(
      { PORTABLE_EXECUTABLE_FILE: portableExecutable },
      'C:\\Temp\\unpacked\\Gtask.exe'
    )).toBe(portableExecutable)
    expect(resolveStablePackagedExecutable(
      { PORTABLE_EXECUTABLE_FILE: 'C:\\missing\\Gtask.exe' },
      'C:\\Apps\\Gtask.exe',
      () => false
    )).toBe('C:\\Apps\\Gtask.exe')
  })
})
