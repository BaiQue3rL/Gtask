import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  CREDENTIAL_PROVIDERS,
  type CredentialProvider,
  type CredentialStatus
} from '../shared/contracts'

export interface CredentialPayload {
  kind: 'cookie' | 'token' | 'session'
  value: string
  accountLabel?: string
}

export interface CredentialProtector {
  isAvailable: () => boolean
  protect: (plainText: string) => Buffer
  unprotect: (encrypted: Buffer) => string
}

export class CredentialVault {
  private readonly directory: string

  constructor(directory: string, private readonly protector: CredentialProtector) {
    this.directory = resolve(directory)
  }

  status(provider: CredentialProvider): CredentialStatus {
    const path = this.pathFor(provider)
    return {
      provider,
      stored: existsSync(path),
      updatedAt: existsSync(path) ? statSync(path).mtime.toISOString() : null
    }
  }

  store(provider: CredentialProvider, payload: CredentialPayload): CredentialStatus {
    if (!this.protector.isAvailable()) throw new Error('Windows 暂时无法安全保存登录信息')
    if (!payload.value) throw new Error('登录信息为空，请重新登录')
    mkdirSync(this.directory, { recursive: true })
    const path = this.pathFor(provider)
    const temporaryPath = `${path}.tmp`
    const encrypted = this.protector.protect(JSON.stringify(payload))
    try {
      writeFileSync(temporaryPath, encrypted, { mode: 0o600 })
      renameSync(temporaryPath, path)
    } catch (error) {
      if (existsSync(temporaryPath)) rmSync(temporaryPath)
      throw error
    }
    return this.status(provider)
  }

  read(provider: CredentialProvider): CredentialPayload | null {
    const path = this.pathFor(provider)
    if (!existsSync(path)) return null
    if (!this.protector.isAvailable()) throw new Error('Windows 无法读取已保存的登录信息，请重新登录')
    const parsed = JSON.parse(this.protector.unprotect(readFileSync(path))) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('kind' in parsed) ||
      !('value' in parsed) ||
      !['cookie', 'token', 'session'].includes(String(parsed.kind)) ||
      typeof parsed.value !== 'string'
    ) {
      throw new Error('已保存的登录信息已损坏，请重新登录')
    }
    return parsed as CredentialPayload
  }

  clear(provider: CredentialProvider): boolean {
    const path = this.pathFor(provider)
    if (!existsSync(path)) return false
    rmSync(path)
    return true
  }

  private pathFor(provider: CredentialProvider): string {
    if (!CREDENTIAL_PROVIDERS.includes(provider)) throw new Error('不支持这个登录平台')
    return join(this.directory, `${provider}.bin`)
  }
}

export function removeRetiredDeepSeekCredential(directory: string): boolean {
  const path = join(resolve(directory), 'deepseek.bin')
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}
