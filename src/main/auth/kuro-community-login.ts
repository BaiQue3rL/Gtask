import { randomUUID } from 'node:crypto'
import type {
  KuroCommunityLoginResult,
  KuroCommunityRole,
  KuroCommunitySmsState
} from '../../shared/contracts'
import type { MiyousheGeetestV4Result } from '../sync/miyoushe-chronicle-client'
import type { KuroCommunityCredential } from '../sync/kuro-community-credential'
import { KuroCommunityCredentialService } from './kuro-community-credential'
import {
  KURO_IOS_USER_AGENT,
  resolveKuroIosDevCode
} from './kuro-community-device'

const BASE_URL = 'https://api.kurobbs.com'
const SESSION_TTL_MS = 5 * 60 * 1000

export const KURO_COMMUNITY_CAPTCHA_ID = 'ec4aa4174277d822d73f2442a165a2cd'

interface KuroEnvelope {
  code?: number
  msg?: string
  success?: boolean
  data?: unknown
}

interface PendingLogin {
  phone: string
  did: string
  expiresAt: number
  token?: string
  roles?: KuroCommunityRole[]
}

export class KuroCommunityLoginService {
  private readonly sessions = new Map<string, PendingLogin>()

  constructor(
    private readonly credentialService: KuroCommunityCredentialService,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly resolveIosDevCode: () => Promise<string> =
      () => resolveKuroIosDevCode(fetcher)
  ) {}

  async sendSms(
    phone: unknown,
    geetest: MiyousheGeetestV4Result
  ): Promise<KuroCommunitySmsState> {
    const normalizedPhone = normalizePhone(phone)
    const validation = normalizeGeetest(geetest)
    const did = randomUUID().toUpperCase()

    await this.request(
      '/user/getSmsCodeForH5',
      {
        mobile: normalizedPhone,
        geeTestData: JSON.stringify(validation)
      },
      did,
      'h5'
    )

    const sessionId = randomUUID()
    const expiresAt = this.now() + SESSION_TTL_MS
    this.sessions.set(sessionId, {
      phone: normalizedPhone,
      did,
      expiresAt
    })
    this.pruneExpired()
    return {
      sessionId,
      expiresAt: new Date(expiresAt).toISOString(),
      message: '验证码已发送，请查看短信'
    }
  }

  async complete(sessionId: unknown, code: unknown): Promise<KuroCommunityLoginResult> {
    const session = this.getSession(sessionId)
    const normalizedCode = normalizeCode(code)
    const data = await this.request(
      '/user/sdkLogin',
      {
        mobile: session.phone,
        code: normalizedCode,
        devCode: session.did
      },
      session.did,
      'ios',
      await this.resolveIosDevCode()
    )
    if (!isRecord(data) || typeof data.token !== 'string' || !data.token.trim()) {
      throw new Error('库街区登录成功，但未返回有效凭据，请重试')
    }

    const token = data.token.trim()
    const roles = await this.credentialService.listRoles(token, session.did)
    session.token = token
    session.roles = roles
    return {
      sessionId: requiredSessionId(sessionId),
      roles
    }
  }

  async finish(
    sessionId: unknown,
    roleId: unknown,
    serverId: unknown
  ): Promise<KuroCommunityCredential> {
    const normalizedSessionId = requiredSessionId(sessionId)
    const session = this.getSession(normalizedSessionId)
    if (!session.token || !session.roles) {
      throw new Error('请先完成短信验证码登录')
    }
    const role = session.roles.find(
      (candidate) => candidate.roleId === roleId && candidate.serverId === serverId
    )
    if (!role) throw new Error('所选鸣潮角色不属于本次登录账号')

    const credential = await this.credentialService.validateCredential({
      token: session.token,
      did: session.did,
      roleId: role.roleId,
      serverId: role.serverId,
      roleName: role.roleName
    })
    this.sessions.delete(normalizedSessionId)
    return credential
  }

  cancel(sessionId: unknown): boolean {
    return this.sessions.delete(requiredSessionId(sessionId))
  }

  private getSession(value: unknown): PendingLogin {
    const sessionId = requiredSessionId(value)
    const session = this.sessions.get(sessionId)
    if (!session) throw new Error('库街区登录会话不存在或已结束，请重新登录')
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(sessionId)
      throw new Error('短信验证码登录已超时，请重新获取验证码')
    }
    return session
  }

  private pruneExpired(): void {
    const current = this.now()
    for (const [sessionId, session] of this.sessions) {
      if (session.expiresAt <= current) this.sessions.delete(sessionId)
    }
  }

  private async request(
    path: string,
    body: Record<string, string>,
    did: string,
    source: 'h5' | 'ios',
    headerDevCode: string = did
  ): Promise<unknown> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      const response = await this.fetcher(`${BASE_URL}${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          source,
          version: '3.1.3',
          devCode: headerDevCode,
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
          'user-agent': KURO_IOS_USER_AGENT
        },
        body: new URLSearchParams(body).toString()
      })
      if (!response.ok) throw new Error(`库街区登录请求失败（HTTP ${response.status}）`)
      const envelope = await response.json() as KuroEnvelope
      const code = typeof envelope.code === 'number'
        ? envelope.code
        : envelope.success === true
          ? 200
          : -1
      if (code === 130) throw new Error('短信验证码错误，请重新输入')
      if (code === 132) throw new Error('短信验证码已过期，请重新获取')
      if (code === 270) throw new Error('库街区判定当前网络环境存在风险，请稍后重试')
      if (code !== 0 && code !== 200) {
        throw new Error(envelope.msg?.trim() || `库街区登录失败（${code}）`)
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
}

function normalizePhone(value: unknown): string {
  if (typeof value !== 'string' || !/^1\d{10}$/.test(value.trim())) {
    throw new Error('请输入正确的 11 位中国大陆手机号')
  }
  return value.trim()
}

function normalizeCode(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{6}$/.test(value.trim())) {
    throw new Error('请输入 6 位短信验证码')
  }
  return value.trim()
}

function normalizeGeetest(value: MiyousheGeetestV4Result): Record<string, string> {
  const result = {
    captcha_id: value.captcha_id,
    lot_number: value.lot_number,
    pass_token: value.pass_token,
    gen_time: value.gen_time,
    captcha_output: value.captcha_output
  }
  if (Object.values(result).some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('库街区滑块验证结果不完整，请重试')
  }
  return result
}

function requiredSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error('库街区登录会话格式不正确')
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
