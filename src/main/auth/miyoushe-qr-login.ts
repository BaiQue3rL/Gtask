import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import type { MiyousheQrLoginState, MiyousheQrLoginStatus } from '../../shared/contracts'

const CREATE_QR_URL = 'https://passport-api.miyoushe.com/account/ma-cn-passport/web/createQRLogin'
const CHECK_QR_URL = 'https://passport-api.miyoushe.com/account/ma-cn-passport/web/queryQRLoginStatus'
const QR_TTL_MS = 5 * 60 * 1000
const REQUIRED_COOKIE_NAMES = [
  'cookie_token_v2',
  'account_mid_v2',
  'account_id_v2',
  'ltoken_v2',
  'ltmid_v2',
  'ltuid_v2'
] as const

interface PendingQrLogin {
  ticket: string
  qrCodeDataUrl: string
  expiresAt: number
}

interface JsonEnvelope {
  retcode?: number
  message?: string
  data?: Record<string, unknown> | null
}

export interface MiyousheQrLoginCredential {
  cookie: string
  accountLabel: string
}

export interface MiyousheQrPollResult {
  state: MiyousheQrLoginState
  credential: MiyousheQrLoginCredential | null
}

export class MiyousheQrLoginService {
  private readonly sessions = new Map<string, PendingQrLogin>()

  constructor(
    private readonly fetcher: typeof fetch,
    private readonly now: () => number = Date.now
  ) {}

  async start(): Promise<MiyousheQrLoginState> {
    const response = await this.request(CREATE_QR_URL)
    const ticket = readNonEmptyString(response.body.data?.ticket, '米游社未返回二维码票据')
    const url = readNonEmptyString(response.body.data?.url, '米游社未返回二维码地址')
    const sessionId = randomUUID()
    const expiresAt = this.now() + QR_TTL_MS
    const qrCodeDataUrl = await QRCode.toDataURL(url, {
      errorCorrectionLevel: 'L',
      margin: 2,
      width: 280,
      color: { dark: '#07152d', light: '#ffffffff' }
    })
    this.sessions.set(sessionId, { ticket, qrCodeDataUrl, expiresAt })
    this.pruneExpired()
    return this.toState(sessionId, 'waiting_scan', '请使用米游社 App 扫描二维码', qrCodeDataUrl, expiresAt)
  }

  async poll(sessionId: string): Promise<MiyousheQrPollResult> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('二维码登录会话不存在或已结束，请重新获取')
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(sessionId)
      return {
        state: this.toState(sessionId, 'expired', '二维码已过期，请重新获取', null, session.expiresAt),
        credential: null
      }
    }

    const response = await this.request(CHECK_QR_URL, { ticket: session.ticket })
    const status = readNonEmptyString(response.body.data?.status, '米游社未返回扫码状态')
    if (status === 'Created') {
      return {
        state: this.toState(sessionId, 'waiting_scan', '请使用米游社 App 扫描二维码', session.qrCodeDataUrl, session.expiresAt),
        credential: null
      }
    }
    if (status === 'Scanned') {
      return {
        state: this.toState(sessionId, 'waiting_confirmation', '已扫码，请在手机上确认登录', session.qrCodeDataUrl, session.expiresAt),
        credential: null
      }
    }
    if (status !== 'Confirmed') throw new Error(`无法识别的米游社扫码状态：${status}`)

    const cookies = parseSetCookieHeaders(response.response.headers)
    for (const name of REQUIRED_COOKIE_NAMES) {
      if (!cookies[name]) throw new Error('米游社登录已确认，但返回的登录凭据不完整，请重新登录')
    }
    this.sessions.delete(sessionId)
    return {
      state: this.toState(sessionId, 'confirmed', '米游社登录成功', null, session.expiresAt),
      credential: {
        cookie: REQUIRED_COOKIE_NAMES.map((name) => `${name}=${cookies[name]}`).join('; '),
        accountLabel: cookies.account_id_v2
      }
    }
  }

  cancel(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  private async request(url: string, body?: Record<string, string>): Promise<{ response: Response; body: JsonEnvelope }> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await this.fetcher(url, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-rpc-app_id': 'bll8iq97cem8',
          'x-rpc-client_type': '4',
          'x-rpc-game_biz': 'bbs_cn',
          'x-rpc-device_fp': '38d7fa104e5d7',
          'x-rpc-device_id': '586f1440-856a-4243-8076-2b0a12314197'
        },
        body: body ? JSON.stringify(body) : undefined
      })
      if (!response.ok) throw new Error(`米游社登录服务请求失败（HTTP ${response.status}）`)
      const parsed = await response.json() as JsonEnvelope
      if (parsed.retcode !== undefined && parsed.retcode !== 0) {
        throw new Error(parsed.message || `米游社登录失败（${parsed.retcode}）`)
      }
      if (!parsed.data) throw new Error('米游社登录服务未返回有效数据')
      return { response, body: parsed }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('米游社登录请求超时，请稍后重试')
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private toState(
    sessionId: string,
    status: MiyousheQrLoginStatus,
    message: string,
    qrCodeDataUrl: string | null,
    expiresAt: number
  ): MiyousheQrLoginState {
    return { sessionId, status, message, qrCodeDataUrl, expiresAt: new Date(expiresAt).toISOString() }
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(sessionId)
    }
  }
}

function readNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(message)
  return value
}

function parseSetCookieHeaders(headers: Headers): Record<string, string> {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const values = (getSetCookie?.call(headers) ?? [headers.get('set-cookie')])
    .flatMap((value) => splitCombinedSetCookie(value))
  const cookies: Record<string, string> = {}
  for (const value of values) {
    const pair = value.split(';', 1)[0]
    const separator = pair.indexOf('=')
    if (separator <= 0) continue
    cookies[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim()
  }
  return cookies
}

function splitCombinedSetCookie(value: string | null): string[] {
  return value ? value.split(/,(?=\s*[^;,\s]+=)/).map((part) => part.trim()) : []
}
