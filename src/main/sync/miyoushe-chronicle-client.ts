import { createHash, randomInt } from 'node:crypto'
import type { CredentialPayload } from '../credential-vault'
import { SyncVerificationRequiredError } from './types'
import { ZenlessPersonalAdapter, type ZenlessBattleChronicleClient } from './zenless-personal-adapter'

const ACCOUNT_ROLES_URL = 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie'
const ZENLESS_RECORD_BASE = 'https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz'
const CREATE_VERIFICATION_URL = 'https://api-takumi-record.mihoyo.com/game_record/app/card/wapi/createVerification?is_high=false'
const CN_DS_SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
const GEETEST_RETCODES = new Set([10035, 5003, 10041, 1034])

interface MiyousheEnvelope {
  retcode?: number
  message?: string
  data?: unknown
}

interface MiyousheGameAccount {
  game_biz?: unknown
  game_uid?: unknown
  region?: unknown
}

export interface MiyousheGeetestChallenge {
  gt: string
  challenge: string
  newCaptcha: number
  success: number
}

export interface MiyousheGeetestResult {
  geetest_challenge: string
  geetest_validate: string
  geetest_seccode: string
}

export type MiyousheGeetestSolver = (
  challenge: MiyousheGeetestChallenge
) => Promise<MiyousheGeetestResult | null>

export class MiyousheZenlessClient implements ZenlessBattleChronicleClient {
  private account: { uid: string; region: string } | null = null

  constructor(
    private readonly cookie: string,
    private readonly fetcher: typeof fetch,
    private readonly solveGeetest?: MiyousheGeetestSolver
  ) {
    if (!cookie.trim()) throw new Error('米游社登录凭据为空')
  }

  async getShiyuDefense(): Promise<unknown> {
    const account = await this.getAccount()
    const data = await this.request(`${ZENLESS_RECORD_BASE}/hadal_info_v2`, {
      role_id: account.uid,
      server: account.region,
      schedule_type: '1'
    })
    return normalizeShiyuDefense(data)
  }

  async getDeadlyAssault(): Promise<unknown> {
    const account = await this.getAccount()
    const data = await this.request(`${ZENLESS_RECORD_BASE}/mem_detail`, {
      uid: account.uid,
      region: account.region,
      schedule_type: '1'
    })
    return normalizeDeadlyAssault(data)
  }

  private async getAccount(): Promise<{ uid: string; region: string }> {
    if (this.account) return this.account
    const data = await this.request(ACCOUNT_ROLES_URL, {})
    const record = asRecord(data)
    const accounts = Array.isArray(record.list) ? record.list.filter(isRecord) as MiyousheGameAccount[] : []
    const zenless = accounts.find((account) => account.game_biz === 'nap_cn')
    const uid = toNonEmptyString(zenless?.game_uid)
    const region = toNonEmptyString(zenless?.region)
    if (!uid || !region) throw new SyncVerificationRequiredError('米游社账号未绑定绝区零国服角色')
    this.account = { uid, region }
    return this.account
  }

  private async request(
    url: string,
    query: Record<string, string>,
    verification?: MiyousheGeetestResult
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const requestUrl = new URL(url)
      for (const [key, value] of Object.entries(query)) requestUrl.searchParams.set(key, value)
      const response = await this.fetcher(requestUrl, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          cookie: this.cookie,
          ds: generateCnDynamicSecret(query),
          'x-rpc-app_version': '2.11.1',
          'x-rpc-client_type': '5',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/58.0.3029.110 Safari/537.36',
          ...(verification ? {
            'x-rpc-challenge': verification.geetest_challenge,
            'x-rpc-validate': verification.geetest_validate,
            'x-rpc-seccode': verification.geetest_seccode
          } : {})
        }
      })
      if (!response.ok) throw new Error(`米游社个人数据请求失败（HTTP ${response.status}）`)
      const envelope = await response.json() as MiyousheEnvelope
      const retcode = envelope.retcode ?? 0
      if (GEETEST_RETCODES.has(retcode) || response.headers.has('x-rpc-aigis')) {
        if (!verification && this.solveGeetest) {
          const challenge = await this.createGeetestChallenge()
          const result = await this.solveGeetest(challenge)
          if (!result) throw new SyncVerificationRequiredError('米游社滑块验证已取消')
          return await this.request(url, query, result)
        }
        throw new SyncVerificationRequiredError('米游社需要完成滑块或设备验证')
      }
      if (retcode === -100 || retcode === 10001) {
        throw new SyncVerificationRequiredError('米游社登录已失效，请重新登录')
      }
      if (retcode !== 0) throw new Error(envelope.message || `米游社返回错误（${retcode}）`)
      if (envelope.data === undefined || envelope.data === null) throw new Error('米游社未返回个人数据')
      return envelope.data
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('米游社个人数据请求超时')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private async createGeetestChallenge(): Promise<MiyousheGeetestChallenge> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await this.fetcher(CREATE_VERIFICATION_URL, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          cookie: this.cookie,
          ds: generateGeetestDynamicSecret(),
          'x-rpc-app_version': '2.60.1',
          'x-rpc-client_type': '5',
          'x-rpc-challenge_game': '6',
          'x-rpc-page': 'v1.4.1-rpg_#/rpg',
          'x-rpc-tool-version': 'v1.4.1-rpg'
        }
      })
      if (!response.ok) throw new Error(`米游社验证服务请求失败（HTTP ${response.status}）`)
      const envelope = await response.json() as MiyousheEnvelope
      if ((envelope.retcode ?? 0) !== 0) {
        throw new SyncVerificationRequiredError(envelope.message || '米游社无法创建滑块验证')
      }
      const data = asRecord(envelope.data)
      const gt = toNonEmptyString(data.gt)
      const challenge = toNonEmptyString(data.challenge)
      if (!gt || !challenge) throw new SyncVerificationRequiredError('米游社未返回完整的滑块验证参数')
      return {
        gt,
        challenge,
        newCaptcha: Number(data.new_captcha ?? 1),
        success: Number(data.success ?? 1)
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SyncVerificationRequiredError('米游社验证服务请求超时')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }
}

export function createMiyousheZenlessPersonalAdapter(
  credential: CredentialPayload,
  fetcher: typeof fetch,
  solveGeetest?: MiyousheGeetestSolver
): ZenlessPersonalAdapter {
  if (credential.kind !== 'cookie') {
    throw new SyncVerificationRequiredError('米游社凭据格式已过期，请重新登录')
  }
  return new ZenlessPersonalAdapter(new MiyousheZenlessClient(credential.value, fetcher, solveGeetest))
}

function generateCnDynamicSecret(query: Record<string, string>): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const random = randomInt(100001, 200001)
  const normalizedQuery = Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const hash = createHash('md5')
    .update(`salt=${CN_DS_SALT}&t=${timestamp}&r=${random}&b=&q=${normalizedQuery}`)
    .digest('hex')
  return `${timestamp},${random},${hash}`
}

function generateGeetestDynamicSecret(): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const random = randomInt(100000, 200001)
  const hash = createHash('md5')
    .update(`salt=${CN_DS_SALT}&t=${timestamp}&r=${random}&b=&q=is_high=false`)
    .digest('hex')
  return `${timestamp},${random},${hash}`
}

function normalizeShiyuDefense(value: unknown): Record<string, unknown> {
  const root = asRecord(value)
  const version = toNonEmptyString(root.hadal_ver)
  const versionData = version ? asRecord(root[`hadal_info_${version}`]) : root
  return {
    schedule_id: versionData.zone_id ?? versionData.schedule_id,
    begin_time: versionData.hadal_begin_time ?? versionData.begin_time,
    end_time: versionData.hadal_end_time ?? versionData.end_time,
    passed_fifth_floor: versionData.pass_fifth_floor ?? versionData.passed_fifth_floor,
    brief_info: versionData.brief ?? versionData.brief_info
  }
}

function normalizeDeadlyAssault(value: unknown): Record<string, unknown> {
  const data = asRecord(value)
  return {
    id: data.zone_id ?? data.id,
    start_time: data.start_time,
    end_time: data.end_time,
    challenges: data.list ?? data.challenges,
    has_data: data.has_data,
    total_star: data.total_star
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('米游社个人数据格式不正确')
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toNonEmptyString(value: unknown): string | null {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) return null
  return String(value)
}
