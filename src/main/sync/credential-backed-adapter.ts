import { createHash } from 'node:crypto'
import type { GameId, SyncTarget } from '../../shared/contracts'
import type { CredentialPayload } from '../credential-vault'
import type { CredentialProvider } from '../../shared/contracts'
import {
  SyncVerificationRequiredError,
  type SyncAdapter,
  type SyncAdapterOutput,
  type SyncProgressReporter
} from './types'

export interface CredentialReader {
  read: (provider: CredentialProvider) => CredentialPayload | null
}

const PROVIDER_LABELS: Record<CredentialProvider, string> = {
  miyoushe: '米游社',
  'kuro-community': '库街区'
}

export class CredentialBackedAdapter implements SyncAdapter {
  constructor(
    private readonly provider: CredentialProvider,
    private readonly credentials: CredentialReader,
    private readonly createAdapter: (
      credential: CredentialPayload,
      reportProgress?: SyncProgressReporter,
      signal?: AbortSignal
    ) => SyncAdapter
  ) {}

  async sync(
    gameId: GameId,
    target: SyncTarget = 'all',
    reportProgress?: SyncProgressReporter,
    signal?: AbortSignal
  ): Promise<SyncAdapterOutput> {
    signal?.throwIfAborted()
    let credential: CredentialPayload | null
    try {
      credential = this.credentials.read(this.provider)
    } catch {
      throw new SyncVerificationRequiredError(`${PROVIDER_LABELS[this.provider]}凭据无法解密，请重新登录`)
    }
    if (!credential) {
      throw new SyncVerificationRequiredError(`${PROVIDER_LABELS[this.provider]}尚未登录`)
    }
    const adapter = this.createAdapter(credential, reportProgress, signal)
    const output = await adapter.sync(gameId, target, reportProgress, signal)
    return {
      ...output,
      accountScope: createPersonalAccountScope(this.provider, gameId, credential)
    }
  }
}

function createPersonalAccountScope(
  provider: CredentialProvider,
  gameId: GameId,
  credential: CredentialPayload
): string {
  const stableIdentity = provider === 'miyoushe'
    ? readCookieValue(credential.value, 'account_id_v2') ??
      readCookieValue(credential.value, 'ltuid_v2') ??
      credential.accountLabel
    : readKuroRoleIdentity(credential.value) ?? credential.accountLabel
  if (!stableIdentity) {
    throw new SyncVerificationRequiredError(
      `${PROVIDER_LABELS[provider]}凭据缺少稳定账号标识，请重新登录`
    )
  }
  const digest = createHash('sha256')
    .update(`${provider}|${gameId}|${stableIdentity}`)
    .digest('hex')
  return `${provider}:${digest}`
}

function readCookieValue(cookie: string, name: string): string | null {
  for (const segment of cookie.split(';')) {
    const separator = segment.indexOf('=')
    if (separator < 0) continue
    if (segment.slice(0, separator).trim() !== name) continue
    const value = segment.slice(separator + 1).trim()
    return value || null
  }
  return null
}

function readKuroRoleIdentity(value: string): string | null {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const record = parsed as Record<string, unknown>
    const roleId = typeof record.roleId === 'string' ? record.roleId.trim() : ''
    const serverId = typeof record.serverId === 'string' ? record.serverId.trim() : ''
    return roleId && serverId ? `${serverId}:${roleId}` : null
  } catch {
    return null
  }
}
