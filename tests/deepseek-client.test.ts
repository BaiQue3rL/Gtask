import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_API_URL,
  testDeepSeekApiKey
} from '../src/main/ai/deepseek-client'

describe('DeepSeek API 连接器', () => {
  it('显式关闭思考并校验结构化响应', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      model: DEFAULT_DEEPSEEK_MODEL,
      choices: [{
        finish_reason: 'stop',
        message: { content: '{"status":"connected","capability":"schedule_normalization"}' }
      }]
    }), { status: 200 }))

    await expect(testDeepSeekApiKey('sk-test-secret-that-is-long-enough', fetcher)).resolves.toMatchObject({
      connected: true,
      provider: 'deepseek',
      model: DEFAULT_DEEPSEEK_MODEL
    })
    const [url, init] = (fetcher.mock.calls as unknown as Array<[
      string | URL | Request,
      RequestInit | undefined
    ]>)[0]
    expect(url).toBe(DEEPSEEK_API_URL)
    expect(init?.headers).toMatchObject({ authorization: 'Bearer sk-test-secret-that-is-long-enough' })
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: DEFAULT_DEEPSEEK_MODEL,
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      stream: false
    })
  })

  it('拒绝无效密钥、HTTP 错误和不完整响应', async () => {
    await expect(testDeepSeekApiKey('short', vi.fn())).rejects.toThrow('密钥格式')
    await expect(testDeepSeekApiKey(
      'sk-test-secret-that-is-long-enough',
      vi.fn(async () => new Response('{"error":"denied"}', { status: 401 }))
    )).rejects.toThrow('HTTP 401')
    await expect(testDeepSeekApiKey(
      'sk-test-secret-that-is-long-enough',
      vi.fn(async () => new Response(JSON.stringify({
        choices: [{ finish_reason: 'length', message: { content: '' } }]
      }), { status: 200 }))
    )).rejects.toThrow('未返回完整')
  })
})
