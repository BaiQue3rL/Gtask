import type { CredentialPayload } from '../credential-vault'
import { decodeKuroCommunityCredential, type KuroCommunityCredential } from './kuro-community-credential'
import { SyncVerificationRequiredError, type SyncProgressReporter } from './types'
import {
  WutheringWavesPersonalAdapter
} from './wuthering-waves-personal-adapter'

const BASE_URL = 'https://api.kurobbs.com'
const IOS_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) KuroGameBox/3.1.3'

interface KuroEnvelope {
  code?: number
  msg?: string
  success?: boolean
  data?: unknown
}

export class KuroCommunityClient {
  private bat = ''
  private preparation: Promise<void> | null = null

  constructor(
    private readonly credential: KuroCommunityCredential,
    private readonly fetcher: typeof fetch = fetch
  ) {}

  async getExploration(): Promise<unknown> {
    await this.prepare()
    return await this.requestRoleData('/aki/roleBox/akiBox/exploreIndex', {
      countryCode: '1'
    })
  }

  async getTower(): Promise<unknown> {
    await this.prepare()
    return await this.requestRoleData('/aki/roleBox/akiBox/towerDataDetail')
  }

  async getSlash(): Promise<unknown> {
    await this.prepare()
    return await this.requestRoleData('/aki/roleBox/akiBox/slashDetail')
  }

  async getMatrix(): Promise<unknown> {
    await this.prepare()
    return await this.requestRoleData('/aki/roleBox/akiBox/newTowerDetail')
  }

  private async prepare(): Promise<void> {
    this.preparation ??= (async () => {
      await this.refreshBat()
      await this.request('/aki/roleBox/akiBox/refreshData', this.roleBody(), {
        includeBat: true,
        retryBat: true
      })
    })()
    try {
      await this.preparation
    } catch (error) {
      this.preparation = null
      throw error
    }
  }

  private async requestRoleData(
    path: string,
    extra: Record<string, string> = {}
  ): Promise<unknown> {
    return await this.request(path, { ...this.roleBody(), ...extra }, {
      includeBat: true,
      retryBat: true
    })
  }

  private async refreshBat(): Promise<void> {
    const data = await this.request('/aki/roleBox/requestToken', {
      serverId: this.credential.serverId,
      roleId: this.credential.roleId
    }, {
      includeToken: true,
      includeDid: true,
      includeEmptyBat: true
    })
    if (!isRecord(data) || typeof data.accessToken !== 'string' || !data.accessToken.trim()) {
      throw new SyncVerificationRequiredError('库街区未返回有效的数据令牌，请重新登录')
    }
    this.bat = data.accessToken
  }

  private async request(
    path: string,
    body: Record<string, string>,
    options: {
      includeToken?: boolean
      includeDid?: boolean
      includeBat?: boolean
      includeEmptyBat?: boolean
      retryBat?: boolean
    },
    isRetry = false
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      source: 'ios',
      version: '3.1.3',
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'user-agent': IOS_USER_AGENT,
      devCode: this.credential.did
    }
    if (options.includeToken) headers.token = this.credential.token
    if (options.includeDid) headers.did = this.credential.did
    if (options.includeBat) {
      headers.did = this.credential.did
      headers['b-at'] = this.bat
    }
    if (options.includeEmptyBat) headers['b-at'] = ''

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
      if (!response.ok) throw new Error(`库街区请求失败（HTTP ${response.status}）`)
      const envelope = await response.json() as KuroEnvelope
      const code = typeof envelope.code === 'number'
        ? envelope.code
        : envelope.success === true
          ? 200
          : -1
      if (code === 10903 && options.retryBat && !isRetry) {
        await this.refreshBat()
        return await this.request(path, body, options, true)
      }
      if (code === 220) {
        throw new SyncVerificationRequiredError('库街区登录已过期，请重新登录')
      }
      if (code === 270) {
        throw new SyncVerificationRequiredError('库街区判定当前网络环境存在风险，请稍后手动重试')
      }
      if (code !== 0 && code !== 200) {
        throw new Error(envelope.msg?.trim() || `库街区请求失败（${code}）`)
      }
      return envelope.data
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('库街区请求超时，请稍后重试')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private roleBody(): Record<string, string> {
    return {
      gameId: '3',
      serverId: this.credential.serverId,
      roleId: this.credential.roleId
    }
  }
}

export function createKuroCommunityPersonalAdapter(
  credential: CredentialPayload,
  fetcher: typeof fetch,
  _reportProgress?: SyncProgressReporter
): WutheringWavesPersonalAdapter {
  return new WutheringWavesPersonalAdapter(
    new KuroCommunityClient(decodeKuroCommunityCredential(credential), fetcher)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
