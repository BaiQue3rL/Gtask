import type { GameId } from '../../shared/contracts'
import type { CredentialPayload } from '../credential-vault'
import type { CredentialProvider } from '../../shared/contracts'
import { SyncVerificationRequiredError, type SyncAdapter, type SyncAdapterOutput } from './types'

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
    private readonly createAdapter: (credential: CredentialPayload) => SyncAdapter
  ) {}

  async sync(gameId: GameId): Promise<SyncAdapterOutput> {
    let credential: CredentialPayload | null
    try {
      credential = this.credentials.read(this.provider)
    } catch {
      throw new SyncVerificationRequiredError(`${PROVIDER_LABELS[this.provider]}凭据无法解密，请重新登录`)
    }
    if (!credential) {
      throw new SyncVerificationRequiredError(`${PROVIDER_LABELS[this.provider]}尚未登录`)
    }
    return this.createAdapter(credential).sync(gameId)
  }
}
