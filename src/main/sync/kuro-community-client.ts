import type { CredentialPayload } from '../credential-vault'
import {
  KURO_IOS_USER_AGENT,
  resolveKuroIosDevCode
} from '../auth/kuro-community-device'
import { decodeKuroCommunityCredential, type KuroCommunityCredential } from './kuro-community-credential'
import { SyncVerificationRequiredError, type SyncProgressReporter } from './types'
import {
  WutheringWavesPersonalAdapter
} from './wuthering-waves-personal-adapter'
import { extractKuroBatToken } from './kuro-community-bat'

const BASE_URL = 'https://api.kurobbs.com'
const MAX_ATTEMPTS = 3
const RETRYABLE_CODES = new Set([102, 1005, 429, 500, 502, 503, 504])

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
    private readonly fetcher: typeof fetch = fetch,
    private readonly reportProgress?: SyncProgressReporter,
    private readonly wait: (milliseconds: number) => Promise<void> = delay,
    private readonly resolveIosDevCode: () => Promise<string> =
      () => resolveKuroIosDevCode(fetcher)
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
    const bat = extractKuroBatToken(data)
    if (!bat) {
      throw new SyncVerificationRequiredError('库街区未返回有效的数据令牌，请重新登录')
    }
    this.bat = bat
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
    isBatRetry = false,
    attempt = 1
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      source: 'ios',
      version: '3.1.3',
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
      'user-agent': KURO_IOS_USER_AGENT,
      devCode: await this.resolveIosDevCode()
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
      if (!response.ok) {
        if (RETRYABLE_CODES.has(response.status)) {
          throw new KuroTransientError(`库街区请求暂时失败（HTTP ${response.status}）`)
        }
        throw new Error(`库街区请求失败（HTTP ${response.status}）`)
      }
      const envelope = await response.json() as KuroEnvelope
      const code = typeof envelope.code === 'number'
        ? envelope.code
        : envelope.success === true
          ? 200
          : -1
      if (code === 10903 && options.retryBat && !isBatRetry) {
        this.reportProgress?.({
          phase: 'retrying',
          message: '库街区数据令牌已失效，正在刷新后重试（1/1）',
          current: 1,
          total: 1
        })
        await this.refreshBat()
        return await this.request(path, body, options, true, attempt)
      }
      if (code === 220) {
        throw new SyncVerificationRequiredError('库街区登录已过期，请重新登录')
      }
      if (code === 270) {
        throw new SyncVerificationRequiredError('库街区判定当前网络环境存在风险，请稍后手动重试')
      }
      if (RETRYABLE_CODES.has(code)) {
        throw new KuroTransientError(envelope.msg?.trim() || `库街区服务暂时不可用（${code}）`)
      }
      if (code !== 0 && code !== 200) {
        throw new Error(envelope.msg?.trim() || `库街区请求失败（${code}）`)
      }
      return envelope.data
    } catch (error) {
      const retryable =
        error instanceof KuroTransientError ||
        (error instanceof Error && ['AbortError', 'TypeError'].includes(error.name))
      if (retryable && attempt < MAX_ATTEMPTS) {
        const nextAttempt = attempt + 1
        this.reportProgress?.({
          phase: 'retrying',
          message: `${requestLabel(path)}暂时失败，正在重试 ${nextAttempt}/${MAX_ATTEMPTS}`,
          current: nextAttempt,
          total: MAX_ATTEMPTS
        })
        await this.wait(250 * 2 ** (attempt - 1))
        return await this.request(path, body, options, isBatRetry, nextAttempt)
      }
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
  reportProgress?: SyncProgressReporter
): WutheringWavesPersonalAdapter {
  return new WutheringWavesPersonalAdapter(
    new KuroCommunityClient(
      decodeKuroCommunityCredential(credential),
      fetcher,
      reportProgress
    )
  )
}

class KuroTransientError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KuroTransientError'
  }
}

function requestLabel(path: string): string {
  if (path.endsWith('/requestToken')) return '库街区数据令牌'
  if (path.endsWith('/refreshData')) return '鸣潮角色数据刷新'
  if (path.endsWith('/exploreIndex')) return '鸣潮地图探索'
  if (path.endsWith('/towerDataDetail')) return '逆境深塔战绩'
  if (path.endsWith('/slashDetail')) return '冥歌海墟战绩'
  if (path.endsWith('/newTowerDetail')) return '终焉矩阵战绩'
  return '库街区请求'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
