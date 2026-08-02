import type {
  CredentialProvider,
  GameId,
  SyncResult
} from '../../shared/contracts'

export function personalCredentialProvider(gameId: GameId): CredentialProvider {
  return gameId === 'wuthering-waves' ? 'kuro-community' : 'miyoushe'
}

export function credentialProviderForSyncResult(
  result: SyncResult
): CredentialProvider | null {
  return result.sources.some((source) => source.status === 'verification_required')
    ? personalCredentialProvider(result.gameId)
    : null
}
