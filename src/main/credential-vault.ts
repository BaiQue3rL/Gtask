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
    if (!this.protector.isAvailable()) throw new Error('当前系统无法使用安全凭据存储')
    if (!payload.value) throw new Error('凭据内容不能为空')
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
    if (!this.protector.isAvailable()) throw new Error('当前系统无法解密已保存凭据')
    const parsed = JSON.parse(this.protector.unprotect(readFileSync(path))) as unknown
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('kind' in parsed) ||
      !('value' in parsed) ||
      !['cookie', 'token', 'session'].includes(String(parsed.kind)) ||
      typeof parsed.value !== 'string'
    ) {
      throw new Error('已保存凭据格式损坏')
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
    if (!CREDENTIAL_PROVIDERS.includes(provider)) throw new Error('不支持的凭据平台')
    return join(this.directory, `${provider}.bin`)
  }
}
