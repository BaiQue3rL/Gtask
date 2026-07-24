import { randomUUID } from 'node:crypto'
import type { KuroCommunityCredential } from '../sync/kuro-community-credential'

const BASE_URL = 'https://api.kurobbs.com'
const KURO_CAPTCHA_ID = 'ec4aa4174277d822d73f2442a165a2cd'
const IOS_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) ' +
  'AppleWebKit/605.1.15 (KHTML, like Gecko) KuroGameBox/3.1.3'
const LOGIN_TTL_MS = 10 * 60 * 1000

export interface KuroGeetestResult {
  captcha_id: string
  lot_number: string
  pass_token: string
  gen_time: string
  captcha_output: string
}

interface PendingLogin {
  did: string
  expiresAt: number
}

interface KuroEnvelope {
  code?: number
  msg?: string
  success?: boolean
  data?: unknown
}

export class KuroCommunityLoginService {
  private readonly pending = new Map<string, PendingLogin>()

  constructor(
    private readonly fetcher: typeof fetch,
    private readonly solveCaptcha: (
      captchaId: string
    ) => Promise<KuroGeetestResult | null>,
    private readonly now: () => number = Date.now
  ) {}

  async requestSmsCode(phone: string): Promise<{ message: string; phoneMasked: string }> {
    const normalizedPhone = normalizePhone(phone)
    const captcha = await this.solveCaptcha(KURO_CAPTCHA_ID)
    if (!captcha) throw new Error('已取消库街区安全验证')
    const did = randomUUID().toUpperCase()
    await this.request('/user/getSmsCodeForH5', {
      mobile: normalizedPhone,
      geeTestData: JSON.stringify(captcha)
    }, {
      source: 'h5',
      devCode: did
    })
    this.pending.set(normalizedPhone, { did, expiresAt: this.now() + LOGIN_TTL_MS })
    this.pruneExpired()
    return {
      message: '验证码已发送，请输入短信验证码',
      phoneMasked: maskPhone(normalizedPhone)
    }
  }

  async completeLogin(phone: string, code: string): Promise<KuroCommunityCredential> {
    const normalizedPhone = normalizePhone(phone)
    const normalizedCode = normalizeCode(code)
    const pending = this.pending.get(normalizedPhone)
    if (!pending || pending.expiresAt <= this.now()) {
      this.pending.delete(normalizedPhone)
      throw new Error('短信登录会话已过期，请重新获取验证码')
    }
    const loginData = await this.request('/user/sdkLogin', {
      mobile: normalizedPhone,
      code: normalizedCode,
      devCode: pending.did
    }, this.iosHeaders(pending.did))
    const login = requiredRecord(loginData, '库街区登录结果')
    const token = requiredString(login.token, '库街区 Token')
    const credential = await this.createCredential(token, pending.did)
    this.pending.delete(normalizedPhone)
    return credential
  }

  async completeWebLogin(token: string): Promise<KuroCommunityCredential> {
    return await this.createCredential(
      requiredString(token, '库街区网页登录令牌'),
      randomUUID().toUpperCase()
    )
  }

  private async createCredential(token: string, did: string): Promise<KuroCommunityCredential> {
    const roleData = await this.request('/gamer/role/list', {
      gameId: '3'
    }, {
      ...this.iosHeaders(did),
      token
    })
    const roles = Array.isArray(roleData) ? roleData.filter(isRecord) : []
    const role = roles.find((item) => Number(item.gameId) === 3) ?? roles[0]
    if (!role) throw new Error('库街区账号没有找到已绑定的鸣潮角色')
    const credential: KuroCommunityCredential = {
      token,
      did,
      roleId: requiredString(role.roleId, '鸣潮特征码'),
      serverId: requiredString(role.serverId, '鸣潮服务器标识'),
      roleName: optionalString(role.roleName) ?? undefined
    }

    const tokenData = await this.request('/aki/roleBox/requestToken', {
      serverId: credential.serverId,
      roleId: credential.roleId
    }, {
      ...this.iosHeaders(did),
      token,
      did,
      'b-at': ''
    })
    const tokenRecord = requiredRecord(tokenData, '库街区数据令牌')
    requiredString(tokenRecord.accessToken, '库街区数据令牌')
    return credential
  }

  private async request(
    path: string,
    body: Record<string, string>,
    headers: Record<string, string>
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await this.fetcher(`${BASE_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
          ...headers
        },
        body: new URLSearchParams(body).toString()
      })
      if (!response.ok) throw new Error(`库街区登录服务请求失败（HTTP ${response.status}）`)
      const envelope = await response.json() as KuroEnvelope
      const status = typeof envelope.code === 'number'
        ? envelope.code
        : envelope.success === true
          ? 200
          : -1
      if (status !== 0 && status !== 200) {
        throw new Error(envelope.msg?.trim() || `库街区登录失败（${status}）`)
      }
      return envelope.data
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('库街区登录请求超时，请稍后重试')
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private iosHeaders(did: string): Record<string, string> {
    return {
      source: 'ios',
      version: '3.1.3',
      devCode: did,
      'user-agent': IOS_USER_AGENT
    }
  }

  private pruneExpired(): void {
    const now = this.now()
    for (const [phone, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(phone)
    }
  }
}

function normalizePhone(value: string): string {
  const normalized = value.trim()
  if (!/^1\d{10}$/.test(normalized)) throw new Error('请输入正确的中国大陆手机号')
  return normalized
}

function normalizeCode(value: string): string {
  const normalized = value.trim()
  if (!/^\d{4,8}$/.test(normalized)) throw new Error('请输入正确的短信验证码')
  return normalized
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${field}格式不正确`)
  return value
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value)
  if (!normalized) throw new Error(`${field}不能为空`)
  return normalized
}

function optionalString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function maskPhone(value: string): string {
  return `${value.slice(0, 3)}****${value.slice(-4)}`
}
