import { createHash, randomInt } from 'node:crypto'
import type { CredentialPayload } from '../credential-vault'
import {
  SyncCancelledError,
  SyncVerificationRequiredError,
  throwIfSyncCancelled
} from './types'
import type { SyncProgressReporter } from './types'
import { ZenlessPersonalAdapter, type ZenlessBattleChronicleClient } from './zenless-personal-adapter'
import { GenshinPersonalAdapter, type GenshinBattleChronicleClient } from './genshin-personal-adapter'
import { StarRailPersonalAdapter, type StarRailBattleChronicleClient } from './star-rail-personal-adapter'

const ACCOUNT_ROLES_URL = 'https://api-takumi.mihoyo.com/binding/api/getUserGameRolesByCookie'
const ZENLESS_RECORD_BASE = 'https://api-takumi-record.mihoyo.com/event/game_record_zzz/api/zzz'
const GENSHIN_RECORD_BASE = 'https://api-takumi-record.mihoyo.com/game_record/app/genshin/api'
const STAR_RAIL_RECORD_BASE = 'https://api-takumi-record.mihoyo.com/game_record/app/hkrpg/api'
const DEVICE_FP_URL = 'https://public-data-api.mihoyo.com/device-fp/api/getFp'
const CREATE_VERIFICATION_URL = 'https://bbs-api.miyoushe.com/misc/api/createVerification?is_high=true'
const VERIFY_VERIFICATION_URL = 'https://bbs-api.miyoushe.com/misc/api/verifyVerification'
const CN_DS_SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'
const BBS_DS_SALT = '9ttJY72HxbjwWRNHJvn0n2AYue47nYsK'
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

export interface MiyousheGeetestV3Challenge {
  gt: string
  challenge: string
  newCaptcha: number
  success: number
  sessionId?: string
  version?: 3
}

export interface MiyousheGeetestV4Challenge {
  gt: string
  riskType: string
  sessionId: string
  version: 4
}

export type MiyousheGeetestChallenge = MiyousheGeetestV3Challenge | MiyousheGeetestV4Challenge

export interface MiyousheGeetestV3Result {
  geetest_challenge: string
  geetest_validate: string
  geetest_seccode: string
  sessionId?: string
  version?: 3
}

export interface MiyousheGeetestV4Result {
  captcha_id: string
  lot_number: string
  pass_token: string
  gen_time: string
  captcha_output: string
  sessionId?: string
  version: 4
}

export type MiyousheGeetestResult = MiyousheGeetestV3Result | MiyousheGeetestV4Result

export type MiyousheGeetestSolver = (
  challenge: MiyousheGeetestChallenge
) => Promise<MiyousheGeetestResult | null>

class MiyousheChronicleClient {
  private readonly accounts = new Map<string, { uid: string; region: string }>()
  private verificationAttempted = false
  private readonly deviceId: string | null
  private deviceFp: string | null = null
  private deviceFpPromise: Promise<void> | null = null

  constructor(
    private readonly cookie: string,
    private readonly fetcher: typeof fetch,
    private readonly solveGeetest?: MiyousheGeetestSolver,
    private readonly reuseLoginDevice = false,
    private readonly reportProgress?: SyncProgressReporter,
    private readonly externalSignal?: AbortSignal
  ) {
    if (!cookie.trim()) throw new Error('米游社登录凭据为空')
    const accountId = readCookieValue(cookie, 'account_id_v2') ?? readCookieValue(cookie, 'ltuid_v2')
    this.deviceId = reuseLoginDevice && accountId ? createStableDeviceId(accountId) : null
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

  async getZenlessExploration(): Promise<unknown> {
    const account = await this.getAccount('nap_cn', '绝区零')
    return await this.request(`${ZENLESS_RECORD_BASE}/exploration_detail`, {
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
    throwIfSyncCancelled(this.externalSignal)
    const controller = new AbortController()
    const cancelRequest = (): void => controller.abort()
    this.externalSignal?.addEventListener('abort', cancelRequest, { once: true })
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      if (this.deviceId && url.startsWith('https://api-takumi-record.mihoyo.com/')) {
        await this.ensureDeviceFingerprint()
      }
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
          ...(this.deviceId ? { 'x-rpc-device_id': this.deviceId } : {}),
          ...(this.deviceFp ? { 'x-rpc-device_fp': this.deviceFp } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(verification?.sessionId ? {
            'x-rpc-aigis': buildAigisHeader(verification)
          } : verification && 'geetest_challenge' in verification ? {
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
        if (!verification && this.solveGeetest && !this.verificationAttempted) {
          this.verificationAttempted = true
          this.reportProgress?.({
            phase: 'verification',
            status: 'verification_required',
            message: '米游社要求人工验证，等待你完成滑块',
            current: null,
            total: null
          })
          const challenge = parseAigisChallenge(response.headers.get('x-rpc-aigis'))
            ?? await this.createGeetestChallenge()
          const result = await this.solveGeetest(challenge)
          if (!result) throw new SyncVerificationRequiredError('米游社滑块验证已取消')
          this.reportProgress?.({
            phase: 'retrying',
            message: '验证完成，正在重试战绩接口（1/1）',
            current: 1,
            total: 1
          })
          if (!challenge.sessionId) {
            if (challenge.version === 4 || result.version === 4) {
              throw new SyncVerificationRequiredError('米游社兼容验证服务返回了无法提交的 V4 票据')
            }
            await this.verifyGeetestChallenge(challenge, result)
            return await this.request(url, query, undefined, method, body)
          }
          return await this.request(
            url,
            query,
            challenge.sessionId ? { ...result, sessionId: challenge.sessionId } : result,
            method,
            body
          )
        }
        const verificationMode = verification?.version === 4
          ? 'Geetest V4 Aigis'
          : verification?.sessionId
            ? 'Geetest V3 Aigis'
            : verification
              ? 'Geetest V3 兼容模式'
              : '未取得验证票据'
        throw new SyncVerificationRequiredError(
          `米游社验证票据未被战绩接口接受（${verificationMode}，返回代码 ${retcode}）`
        )
      }
      if (retcode === -100 || retcode === 10001) {
        throw new SyncVerificationRequiredError('米游社登录已失效，请重新登录')
      }
      if (retcode !== 0) throw new Error(envelope.message || `米游社返回错误（${retcode}）`)
      if (envelope.data === undefined || envelope.data === null) throw new Error('米游社未返回个人数据')
      return envelope.data
    } catch (error) {
      if (this.externalSignal?.aborted) throw new SyncCancelledError()
      if (error instanceof Error && error.name === 'AbortError') throw new Error('米游社个人数据请求超时')
      throw error
    } finally {
      clearTimeout(timeout)
      this.externalSignal?.removeEventListener('abort', cancelRequest)
    }
  }

  private async ensureDeviceFingerprint(): Promise<void> {
    if (!this.deviceId || this.deviceFp) return
    if (this.deviceFpPromise) return await this.deviceFpPromise
    this.deviceFpPromise = (async () => {
      const seedId = randomString(16)
      const body = {
        seed_id: seedId,
        device_id: this.deviceId!.toUpperCase(),
        platform: '1',
        seed_time: String(Date.now()),
        ext_fields: JSON.stringify({
          proxyStatus: '0',
          IDFV: this.deviceId!.toUpperCase(),
          isJailBreak: '0',
          model: 'iPhone12,5',
          osVersion: '17.0.2',
          networkType: 'WIFI',
          screenSize: '414x896',
          cpuCores: '6',
          cpuType: 'CPU_TYPE_ARM64'
        }),
        app_name: 'bbs_cn',
        device_fp: '38d7ee834d1e9'
      }
      try {
        throwIfSyncCancelled(this.externalSignal)
        const response = await this.fetcher(DEVICE_FP_URL, {
          method: 'POST',
          redirect: 'error',
          signal: this.externalSignal,
          headers: {
            'content-type': 'application/json',
            ds: generateCnDynamicSecret({}, body),
            'x-rpc-app_version': '2.40.1',
            'x-rpc-client_type': '5',
            'user-agent': `Mozilla/5.0 (Linux; Android 12; ${this.deviceId}) AppleWebKit/537.36 Chrome/99.0.4844.73 Mobile Safari/537.36 miHoYoBBS/2.40.1`,
            referer: 'https://webstatic.mihoyo.com/'
          },
          body: JSON.stringify(body)
        })
        if (!response.ok) return
        const envelope = await response.json() as MiyousheEnvelope
        const fp = toNonEmptyString(asRecord(envelope.data).device_fp)
        if ((envelope.retcode ?? 0) === 0 && fp) this.deviceFp = fp
      } catch {
        if (this.externalSignal?.aborted) throw new SyncCancelledError()
        // Fingerprint registration is an optimization. The battle-chronicle
        // request can still proceed without it and surface its own result.
      }
    })()
    await this.deviceFpPromise
  }

  private async createGeetestChallenge(): Promise<MiyousheGeetestChallenge> {
    throwIfSyncCancelled(this.externalSignal)
    const controller = new AbortController()
    const cancelRequest = (): void => controller.abort()
    this.externalSignal?.addEventListener('abort', cancelRequest, { once: true })
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await this.fetcher(CREATE_VERIFICATION_URL, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          cookie: this.cookie,
          ...createBbsVerificationHeaders(this.deviceId, this.deviceFp)
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
      if (this.externalSignal?.aborted) throw new SyncCancelledError()
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SyncVerificationRequiredError('米游社验证服务请求超时')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      this.externalSignal?.removeEventListener('abort', cancelRequest)
    }
  }

  private async verifyGeetestChallenge(
    challenge: MiyousheGeetestV3Challenge,
    result: MiyousheGeetestV3Result
  ): Promise<void> {
    throwIfSyncCancelled(this.externalSignal)
    const controller = new AbortController()
    const cancelRequest = (): void => controller.abort()
    this.externalSignal?.addEventListener('abort', cancelRequest, { once: true })
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const body = {
        geetest_seccode: result.geetest_seccode,
        geetest_challenge: challenge.challenge,
        geetest_validate: result.geetest_validate
      }
      const response = await this.fetcher(VERIFY_VERIFICATION_URL, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          cookie: this.cookie,
          'content-type': 'application/json; charset=UTF-8',
          ...createBbsVerificationHeaders(this.deviceId, this.deviceFp)
        },
        body: JSON.stringify(body)
      })
      if (!response.ok) throw new Error(`米游社验证确认请求失败（HTTP ${response.status}）`)
      const envelope = await response.json() as MiyousheEnvelope
      if ((envelope.retcode ?? 0) !== 0) {
        throw new SyncVerificationRequiredError(
          envelope.message || `米游社未接受滑块验证结果（${envelope.retcode}）`
        )
      }
    } catch (error) {
      if (this.externalSignal?.aborted) throw new SyncCancelledError()
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SyncVerificationRequiredError('米游社验证确认请求超时')
      }
      throw error
    } finally {
      clearTimeout(timeout)
      this.externalSignal?.removeEventListener('abort', cancelRequest)
    }
  }
}

export class MiyousheZenlessClient extends MiyousheChronicleClient implements ZenlessBattleChronicleClient {
  constructor(
    cookie: string,
    fetcher: typeof fetch,
    solveGeetest?: MiyousheGeetestSolver,
    reportProgress?: SyncProgressReporter,
    signal?: AbortSignal
  ) {
    // The verification ticket is bound to the same stable device identity as
    // the battle-record request. Without it, ZZZ commonly accepts the slider
    // but rejects the immediate retry with retcode 10035.
    super(cookie, fetcher, solveGeetest, true, reportProgress, signal)
  }
}

export class MiyousheGenshinClient extends MiyousheChronicleClient implements GenshinBattleChronicleClient {
  constructor(
    cookie: string,
    fetcher: typeof fetch,
    solveGeetest?: MiyousheGeetestSolver,
    reportProgress?: SyncProgressReporter,
    signal?: AbortSignal
  ) {
    super(cookie, fetcher, solveGeetest, true, reportProgress, signal)
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
  constructor(
    cookie: string,
    fetcher: typeof fetch,
    solveGeetest?: MiyousheGeetestSolver,
    reportProgress?: SyncProgressReporter,
    signal?: AbortSignal
  ) {
    super(cookie, fetcher, solveGeetest, true, reportProgress, signal)
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
  solveGeetest?: MiyousheGeetestSolver,
  reportProgress?: SyncProgressReporter,
  signal?: AbortSignal
): ZenlessPersonalAdapter {
  if (credential.kind !== 'cookie') {
    throw new SyncVerificationRequiredError('米游社凭据格式已过期，请重新登录')
  }
  return new ZenlessPersonalAdapter(
    new MiyousheZenlessClient(
      credential.value,
      fetcher,
      solveGeetest,
      reportProgress,
      signal
    )
  )
}

export function createMiyousheGenshinPersonalAdapter(
  credential: CredentialPayload,
  fetcher: typeof fetch,
  solveGeetest?: MiyousheGeetestSolver,
  reportProgress?: SyncProgressReporter,
  signal?: AbortSignal
): GenshinPersonalAdapter {
  if (credential.kind !== 'cookie') {
    throw new SyncVerificationRequiredError('米游社凭据格式已过期，请重新登录')
  }
  return new GenshinPersonalAdapter(
    new MiyousheGenshinClient(
      credential.value,
      fetcher,
      solveGeetest,
      reportProgress,
      signal
    )
  )
}

export function createMiyousheStarRailPersonalAdapter(
  credential: CredentialPayload,
  fetcher: typeof fetch,
  solveGeetest?: MiyousheGeetestSolver,
  reportProgress?: SyncProgressReporter,
  signal?: AbortSignal
): StarRailPersonalAdapter {
  if (credential.kind !== 'cookie') {
    throw new SyncVerificationRequiredError('米游社凭据格式已过期，请重新登录')
  }
  return new StarRailPersonalAdapter(
    new MiyousheStarRailClient(
      credential.value,
      fetcher,
      solveGeetest,
      reportProgress,
      signal
    )
  )
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

function createBbsVerificationHeaders(
  deviceId: string | null,
  deviceFp: string | null
): Record<string, string> {
  return {
    ds: generateBbsDynamicSecret(),
    'x-rpc-verify_key': 'bll8iq97cem8',
    'x-rpc-client_type': '1',
    'x-rpc-channel': 'appstore',
    'x-rpc-app_version': '2.63.1',
    'x-rpc-sys_version': '16.2',
    'x-rpc-device_name': 'iPhone',
    'x-rpc-device_model': 'iPhone10,2',
    'user-agent': 'Hyperion/275 CFNetwork/1402.0.8 Darwin/22.2.0',
    referer: 'https://app.mihoyo.com',
    ...(deviceId ? { 'x-rpc-device_id': deviceId } : {}),
    ...(deviceFp ? { 'x-rpc-device_fp': deviceFp } : {})
  }
}

function generateBbsDynamicSecret(): string {
  const timestamp = Math.floor(Date.now() / 1000)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let random = ''
  for (let index = 0; index < 6; index += 1) random += alphabet[randomInt(0, alphabet.length)]
  const hash = createHash('md5')
    .update(`salt=${BBS_DS_SALT}&t=${timestamp}&r=${random}`)
    .digest('hex')
  return `${timestamp},${random},${hash}`
}

function randomString(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let index = 0; index < length; index += 1) result += alphabet[randomInt(0, alphabet.length)]
  return result
}

function readCookieValue(cookie: string, name: string): string | null {
  const part = cookie.split(';').find((candidate) => candidate.trim().startsWith(`${name}=`))
  return part ? part.slice(part.indexOf('=') + 1).trim() || null : null
}

function createStableDeviceId(accountId: string): string {
  const hex = createHash('sha256').update(`gacha-task-manager:${accountId}`).digest('hex').slice(0, 32)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
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
    const riskType = toNonEmptyString(challenge.risk_type)
    if (sessionId && gt && (challenge.use_v4 === true || riskType)) {
      return {
        gt,
        riskType: riskType ?? 'slide',
        sessionId,
        version: 4
      }
    }
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
  const payload = JSON.stringify(result.version === 4 ? {
    captcha_id: result.captcha_id,
    lot_number: result.lot_number,
    pass_token: result.pass_token,
    gen_time: result.gen_time,
    captcha_output: result.captcha_output
  } : {
    geetest_challenge: result.geetest_challenge,
    geetest_validate: result.geetest_validate,
    geetest_seccode: result.geetest_seccode
  })
  return `${sessionId};${Buffer.from(payload, 'utf8').toString('base64')}`
}
