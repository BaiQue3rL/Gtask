import type { CredentialPayload } from '../credential-vault'

export interface KuroCommunityCredential {
  token: string
  did: string
  roleId: string
  serverId: string
  roleName?: string
}

export function encodeKuroCommunityCredential(
  credential: KuroCommunityCredential
): CredentialPayload {
  const normalized = normalizeCredential(credential)
  return {
    kind: 'token',
    value: JSON.stringify(normalized),
    accountLabel: normalized.roleName || maskRoleId(normalized.roleId)
  }
}

export function decodeKuroCommunityCredential(
  payload: CredentialPayload
): KuroCommunityCredential {
  if (payload.kind !== 'token') throw new Error('库街区凭据类型不正确')
  let parsed: unknown
  try {
    parsed = JSON.parse(payload.value)
  } catch {
    throw new Error('库街区凭据格式已损坏')
  }
  if (!isRecord(parsed)) throw new Error('库街区凭据格式已损坏')
  return normalizeCredential({
    token: parsed.token,
    did: parsed.did,
    roleId: parsed.roleId,
    serverId: parsed.serverId,
    roleName: parsed.roleName
  })
}

function normalizeCredential(value: {
  token: unknown
  did: unknown
  roleId: unknown
  serverId: unknown
  roleName?: unknown
}): KuroCommunityCredential {
  return {
    token: requiredString(value.token, '库街区 Token'),
    did: requiredString(value.did, '库街区设备标识'),
    roleId: requiredString(value.roleId, '鸣潮特征码'),
    serverId: requiredString(value.serverId, '鸣潮服务器标识'),
    ...(optionalString(value.roleName) && { roleName: optionalString(value.roleName)! })
  }
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value)
  if (!normalized) throw new Error(`${field}不能为空`)
  return normalized
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maskRoleId(value: string): string {
  return value.length <= 4 ? value : `${value.slice(0, 2)}***${value.slice(-2)}`
}
