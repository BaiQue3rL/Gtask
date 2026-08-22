import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CredentialVault,
  removeRetiredDeepSeekCredential,
  type CredentialProtector
} from '../src/main/credential-vault'

let temporaryDirectory: string | null = null

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

const testProtector: CredentialProtector = {
  isAvailable: () => true,
  protect: (value) => Buffer.from(Buffer.from(value, 'utf8').map((byte) => byte ^ 0xa5)),
  unprotect: (value) => Buffer.from(value.map((byte) => byte ^ 0xa5)).toString('utf8')
}

describe('CredentialVault', () => {
  it('磁盘不出现明文，并支持读取状态和一键清除', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-credential-test-'))
    const vault = new CredentialVault(temporaryDirectory, testProtector)
    expect(vault.status('miyoushe')).toMatchObject({ stored: false, updatedAt: null })

    const status = vault.store('miyoushe', {
      kind: 'cookie',
      value: 'sensitive-cookie-value',
      accountLabel: '测试账号'
    })
    expect(status.stored).toBe(true)
    expect(readFileSync(join(temporaryDirectory, 'miyoushe.bin'), 'utf8')).not.toContain(
      'sensitive-cookie-value'
    )
    expect(vault.read('miyoushe')).toEqual({
      kind: 'cookie',
      value: 'sensitive-cookie-value',
      accountLabel: '测试账号'
    })
    vault.store('miyoushe', { kind: 'session', value: 'replacement-secret' })
    expect(vault.read('miyoushe')).toEqual({ kind: 'session', value: 'replacement-secret' })
    expect(vault.clear('miyoushe')).toBe(true)
    expect(vault.read('miyoushe')).toBeNull()
  })

  it('升级时清除已经退役的 DeepSeek 密钥文件', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-retired-credential-test-'))
    const path = join(temporaryDirectory, 'deepseek.bin')
    writeFileSync(path, 'encrypted-legacy-key')

    expect(removeRetiredDeepSeekCredential(temporaryDirectory)).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(removeRetiredDeepSeekCredential(temporaryDirectory)).toBe(false)
  })

  it('系统安全存储不可用时拒绝落盘', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gtask-credential-unavailable-test-'))
    const vault = new CredentialVault(temporaryDirectory, {
      ...testProtector,
      isAvailable: () => false
    })
    expect(() => vault.store('kuro-community', { kind: 'token', value: 'secret' })).toThrow(
      '无法使用安全凭据存储'
    )
  })
})
