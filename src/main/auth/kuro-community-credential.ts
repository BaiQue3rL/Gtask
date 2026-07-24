import type { KuroCommunityRole } from '../../shared/contracts'
import type { KuroCommunityCredential } from '../sync/kuro-community-credential'
import { extractKuroBatToken } from '../sync/kuro-community-bat'
import {
  KURO_IOS_USER_AGENT,
  resolveKuroIosDevCode
} from './kuro-community-device'

const BASE_URL = 'https://api.kurobbs.com'

interface KuroEnvelope {
  code?: number
  msg?: string
  success?: boolean
  data?: unknown
}

interface KuroCommunityCredentialInput {
  token: string
  did: string
  roleId: string
  serverId: string
  roleName?: string
}

export class KuroCommunityCredentialService {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly resolveIosDevCode: () => Promise<string> =
      () => resolveKuroIosDevCode(fetcher)
  ) {}

  async listRoles(token: unknown, did: unknown): Promise<KuroCommunityRole[]> {
    const normalizedToken = requiredSecret(token, '库街区 App Token', 16_384)
    const normalizedDid = requiredSecret(did, '库街区 DID', 512)
    const data = await this.request('/gamer/role/list', {
      gameId: '3'
    }, normalizedToken, normalizedDid)
    if (!Array.isArray(data)) throw new Error('库街区返回的角色列表格式不正确')

    const roles = data
      .filter(isRecord)
      .filter((role) => String(role.gameId) === '3')
      .map(parseRole)

    if (roles.length === 0) throw new Error('该库街区账号没有找到已绑定的鸣潮角色')
    return roles
  }

  async validateCredential(input: unknown): Promise<KuroCommunityCredential> {
    if (!isRecord(input)) throw new Error('库街区凭据参数格式不正确')
    const value = input as unknown as KuroCommunityCredentialInput
    const credential: KuroCommunityCredential = {
      token: requiredSecret(value.token, '库街区 App Token', 16_384),
      did: requiredSecret(value.did, '库街区 DID', 512),
      roleId: requiredText(value.roleId, '鸣潮特征码', 128),
      serverId: requiredText(value.serverId, '鸣潮服务器标识', 128),
      ...(optionalText(value.roleName, 200) && {
        roleName: optionalText(value.roleName, 200)!
      })
    }
    const data = await this.request('/aki/roleBox/requestToken', {
      serverId: credential.serverId,
      roleId: credential.roleId
    }, credential.token, credential.did, true)
    if (!extractKuroBatToken(data)) {
      throw new Error(
        `库街区未返回有效的数据令牌，凭据未保存（${describeResponseShape(data)}）`
      )
    }
    return credential
  }

  private async request(
    path: string,
    body: Record<string, string>,
    token: string,
    did: string,
    includeEmptyBat = false
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      source: 'ios',
      version: '3.1.3',
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'user-agent': KURO_IOS_USER_AGENT,
      devCode: includeEmptyBat ? await this.resolveIosDevCode() : did,
      token
    }
    if (includeEmptyBat) {
      headers.did = did
      headers['b-at'] = ''
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await this.fetcher(`${BASE_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers,
        body: new URLSearchParams(body).toString()
      })
      if (!response.ok) throw new Error(`库街区凭据校验失败（HTTP ${response.status}）`)
      const envelope = await response.json() as KuroEnvelope
      const code = typeof envelope.code === 'number'
        ? envelope.code
        : envelope.success === true
          ? 200
          : -1
      if (code === 220) throw new Error('库街区 App Token 已过期，请重新获取')
      if (code === 270) throw new Error('库街区判定当前网络环境存在风险，请稍后重试')
      if (code !== 0 && code !== 200) {
        throw new Error(envelope.msg?.trim() || `库街区凭据校验失败（${code}）`)
      }
      return envelope.data
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('库街区凭据校验超时，请稍后重试')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}

function parseRole(value: Record<string, unknown>): KuroCommunityRole {
  return {
    roleId: requiredText(value.roleId, '鸣潮特征码', 128),
    roleName: requiredText(value.roleName, '鸣潮角色名', 200),
    serverId: requiredText(value.serverId, '鸣潮服务器标识', 128),
    serverName: optionalText(value.serverName, 200)
  }
}

function requiredSecret(value: unknown, field: string, maxLength: number): string {
  const normalized = optionalText(value, maxLength)
  if (!normalized) throw new Error(`${field}不能为空`)
  return normalized
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const normalized = optionalText(value, maxLength)
  if (!normalized) throw new Error(`${field}格式不正确`)
  return normalized
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized && normalized.length <= maxLength ? normalized : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describeResponseShape(value: unknown): string {
  if (value === null || value === undefined) return '返回数据为空'
  if (Array.isArray(value)) return `返回了数组，长度 ${value.length}`
  if (isRecord(value)) {
    const keys = Object.keys(value).filter((key) => /^[a-zA-Z0-9_-]{1,64}$/.test(key))
    return keys.length > 0
      ? `返回字段：${keys.slice(0, 12).join('、')}`
      : '返回了空对象'
  }
  return `返回类型：${typeof value}`
}
