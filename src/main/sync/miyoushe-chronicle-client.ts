import { createHash, randomInt } from 'node:crypto'
import type { CredentialPayload } from '../credential-vault'
import { MIYOUSHE_WEB_DEVICE_PROFILE } from '../auth/miyoushe-device-profile'
import { SyncVerificationRequiredError } from './types'
import { ZenlessPersonalAdapter, type ZenlessBattleChronicleClient } from './zenless-personal-adapter'
import { GenshinPersonalAdapter, type GenshinBattleChronicleClient } from './genshin-personal-adapter'
import { StarRailPersonalAdapter, type StarRailBattleChronicleClient } from './star-rail-personal-adapter'

const ACCOUNT_ROLES_URL = 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie'
const ZENLESS_RECORD_BASE = 'https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz'
const GENSHIN_RECORD_BASE = 'https://api-takumi-record.mihoyo.com/game_record/app/genshin/api'
const STAR_RAIL_RECORD_BASE = 'https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api'
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
  sessionId?: string
}

export interface MiyousheGeetestResult {
  geetest_challenge: string
  geetest_validate: string
  geetest_seccode: string
  sessionId?: string
}

export type MiyousheGeetestSolver = (
  challenge: MiyousheGeetestChallenge
) => Promise<MiyousheGeetestResult | null>

class MiyousheChronicleClient {
  private readonly accounts = new Map<string, { uid: string; region: string }>()

  constructor(
    private readonly cookie: string,
    private readonly fetcher: typeof fetch,
    private readonly solveGeetest?: MiyousheGeetestSolver,
    private readonly reuseLoginDevice = false
  ) {
    if (!cookie.trim()) throw new Error('米游社登录凭据为空')
  }

  async getShiyuDefense(): Promise<unknown> {
    const account = await this.getAccount('nap_cn', '绝区零')
    const data = await this.request(`${ZENLESS_RECORD_BASE}/hadal_info_v2`, {
      role_id: account.uid,
      server: account.region,
      schedule_type: '1'
    })
    return normalizeShiyuDefense(data)
  }

  async getDeadlyAssault(): Promise<unknown> {
    const account = await this.getAccount('nap_cn', '绝区零')
    const data = await this.request(`${ZENLESS_RECORD_BASE}/mem_detail`, {
      uid: account.uid,
      region: account.region,
      schedule_type: '1'
    })
    return normalizeDeadlyAssault(data)
  }

  async getZenlessEventCalendar(): Promise<unknown> {
    const account = await this.getAccount('nap_cn', '绝区零')
    return await this.request(`${ZENLESS_RECORD_BASE}/activity_calendar`, {
      uid: account.uid,
      region: account.region
    })
  }

  protected async getAccount(gameBiz: string, gameLabel: string): Promise<{ uid: string; region: string }> {
    const cached = this.accounts.get(gameBiz)
    if (cached) return cached
    const data = await this.request(ACCOUNT_ROLES_URL, {})
    const record = asRecord(data)
    const accounts = Array.isArray(record.list) ? record.list.filter(isRecord) as MiyousheGameAccount[] : []
    const account = accounts.find((candidate) => candidate.game_biz === gameBiz)
    const uid = toNonEmptyString(account?.game_uid)
    const region = toNonEmptyString(account?.region)
    if (!uid || !region) throw new SyncVerificationRequiredError(`米游社账号未绑定${gameLabel}国服角色`)
    const result = { uid, region }
    this.accounts.set(gameBiz, result)
    return result
  }

  protected async request(
    url: string,
    query: Record<string, string>,
    verification?: MiyousheGeetestResult,
    method: 'GET' | 'POST' = 'GET',
    body?: Record<string, string>
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const requestUrl = new URL(url)
      for (const [key, value] of Object.entries(query)) requestUrl.searchParams.set(key, value)
      const response = await this.fetcher(requestUrl, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          cookie: this.cookie,
          ds: generateCnDynamicSecret(query, body),
          'x-rpc-app_version': '2.11.1',
          'x-rpc-client_type': '5',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/58.0.3029.110 Safari/537.36',
          ...(this.reuseLoginDevice ? MIYOUSHE_WEB_DEVICE_PROFILE : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(verification?.sessionId ? {
            'x-rpc-aigis': buildAigisHeader(verification)
          } : verification ? {
            'x-rpc-challenge': verification.geetest_challenge,
            'x-rpc-validate': verification.geetest_validate,
            'x-rpc-seccode': verification.geetest_seccode
          } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {})
      })
      if (!response.ok) throw new Error(`米游社个人数据请求失败（HTTP ${response.status}）`)
      const envelope = await response.json() as MiyousheEnvelope
      const retcode = envelope.retcode ?? 0
      // Battle Chronicle responses can keep echoing x-rpc-aigis after a valid
      // verification. Only the documented risk retcodes mean the request was
      // rejected; treating the header alone as failure discards successful data.
      if (GEETEST_RETCODES.has(retcode)) {
        if (!verification && this.solveGeetest) {
          const challenge = parseAigisChallenge(response.headers.get('x-rpc-aigis'))
            ?? await this.createGeetestChallenge()
          const result = await this.solveGeetest(challenge)
          if (!result) throw new SyncVerificationRequiredError('米游社滑块验证已取消')
          return await this.request(
            url,
            query,
            challenge.sessionId ? { ...result, sessionId: challenge.sessionId } : result,
            method,
            body
          )
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

export class MiyousheZenlessClient extends MiyousheChronicleClient implements ZenlessBattleChronicleClient {}

export class MiyousheGenshinClient extends MiyousheChronicleClient implements GenshinBattleChronicleClient {
  constructor(cookie: string, fetcher: typeof fetch, solveGeetest?: MiyousheGeetestSolver) {
    super(cookie, fetcher, solveGeetest, true)
  }

  async getProfile(): Promise<unknown> {
    const account = await this.getAccount('hk4e_cn', '原神')
    return await this.request(`${GENSHIN_RECORD_BASE}/index`, {
      role_id: account.uid,
      server: account.region
    })
  }

  async getSpiralAbyss(): Promise<unknown> {
    const account = await this.getAccount('hk4e_cn', '原神')
    return await this.request(`${GENSHIN_RECORD_BASE}/spiralAbyss`, {
      role_id: account.uid,
      server: account.region,
      schedule_type: '1'
    })
  }

  async getImaginariumTheater(): Promise<unknown> {
    const account = await this.getAccount('hk4e_cn', '原神')
    return await this.request(`${GENSHIN_RECORD_BASE}/role_combat`, {
      role_id: account.uid,
      server: account.region,
      need_detail: 'true'
    })
  }

  async getStygianOnslaught(): Promise<unknown> {
    const account = await this.getAccount('hk4e_cn', '原神')
    return await this.request(`${GENSHIN_RECORD_BASE}/hard_challenge`, {
      role_id: account.uid,
      server: account.region,
      need_detail: 'true'
    })
  }

  async getEventCalendar(): Promise<unknown> {
    const account = await this.getAccount('hk4e_cn', '原神')
    return await this.request(
      `${GENSHIN_RECORD_BASE}/act_calendar`,
      {},
      undefined,
      'POST',
      { role_id: account.uid, server: account.region }
    )
  }
}

export class MiyousheStarRailClient extends MiyousheChronicleClient implements StarRailBattleChronicleClient {
  constructor(cookie: string, fetcher: typeof fetch, solveGeetest?: MiyousheGeetestSolver) {
    super(cookie, fetcher, solveGeetest, true)
  }

  private async getChallenge(endpoint: string, extraQuery: Record<string, string> = {}): Promise<unknown> {
    const account = await this.getAccount('hkrpg_cn', '崩坏：星穹铁道')
    return await this.request(`${STAR_RAIL_RECORD_BASE}/${endpoint}`, {
      role_id: account.uid,
      server: account.region,
      schedule_type: '1',
      ...extraQuery
    })
  }

  async getMemoryOfChaos(): Promise<unknown> {
    return await this.getChallenge('challenge', { need_all: 'true' })
  }

  async getPureFiction(): Promise<unknown> {
    return await this.getChallenge('challenge_story', { need_all: 'true' })
  }

  async getApocalypticShadow(): Promise<unknown> {
    return await this.getChallenge('challenge_boss', { need_all: 'true' })
  }

  async getAnomalyArbitration(): Promise<unknown> {
    // 新接口返回最近三期，解析器会优先选择当前状态记录。
    return await this.getChallenge('challenge_peak', { schedule_type: '3' })
  }

  async getEventCalendar(): Promise<unknown> {
    const account = await this.getAccount('hkrpg_cn', '崩坏：星穹铁道')
    return await this.request(`${STAR_RAIL_RECORD_BASE}/get_act_calender`, {
      role_id: account.uid,
      server: account.region
    })
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

export function createMiyousheGenshinPersonalAdapter(
  credential: CredentialPayload,
  fetcher: typeof fetch,
  solveGeetest?: MiyousheGeetestSolver
): GenshinPersonalAdapter {
  if (credential.kind !== 'cookie') {
    throw new SyncVerificationRequiredError('米游社凭据格式已过期，请重新登录')
  }
  return new GenshinPersonalAdapter(new MiyousheGenshinClient(credential.value, fetcher, solveGeetest))
}

export function createMiyousheStarRailPersonalAdapter(
  credential: CredentialPayload,
  fetcher: typeof fetch,
  solveGeetest?: MiyousheGeetestSolver
): StarRailPersonalAdapter {
  if (credential.kind !== 'cookie') {
    throw new SyncVerificationRequiredError('米游社凭据格式已过期，请重新登录')
  }
  return new StarRailPersonalAdapter(new MiyousheStarRailClient(credential.value, fetcher, solveGeetest))
}

function generateCnDynamicSecret(
  query: Record<string, string>,
  body?: Record<string, string>
): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const random = randomInt(100001, 200001)
  const normalizedQuery = Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const hash = createHash('md5')
    .update(`salt=${CN_DS_SALT}&t=${timestamp}&r=${random}&b=${body ? JSON.stringify(body) : ''}&q=${normalizedQuery}`)
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

function parseAigisChallenge(value: string | null): MiyousheGeetestChallenge | null {
  if (!value) return null
  try {
    const root = asRecord(JSON.parse(value))
    const sessionId = toNonEmptyString(root.session_id)
    let data: unknown = root.data
    if (typeof data === 'string') data = JSON.parse(data)
    const challenge = asRecord(data)
    const gt = toNonEmptyString(challenge.gt)
    const challengeId = toNonEmptyString(challenge.challenge)
    if (!sessionId || !gt || !challengeId) return null
    return {
      gt,
      challenge: challengeId,
      newCaptcha: Number(challenge.new_captcha ?? 1),
      success: Number(challenge.success ?? 1),
      sessionId
    }
  } catch {
    return null
  }
}

function buildAigisHeader(result: MiyousheGeetestResult): string {
  const sessionId = toNonEmptyString(result.sessionId)
  if (!sessionId) throw new Error('米游社 Aigis 验证缺少会话标识')
  const payload = JSON.stringify({
    geetest_challenge: result.geetest_challenge,
    geetest_validate: result.geetest_validate,
    geetest_seccode: result.geetest_seccode
  })
  return `${sessionId};${Buffer.from(payload, 'utf8').toString('base64')}`
}
