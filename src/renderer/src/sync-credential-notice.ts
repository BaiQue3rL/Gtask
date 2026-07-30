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

export function credentialProviderFromSyncMessage(
  message: string
): CredentialProvider | null {
  const asksForLogin = /(尚未登录|重新登录|登录已失效|登录已过期|凭据.*(?:失效|过期|无法解密)|数据令牌.*失效)/
    .test(message)
  if (!asksForLogin) return null
  if (message.includes('米游社')) return 'miyoushe'
  if (message.includes('库街区')) return 'kuro-community'
  return null
}
