import type { AiProviderConnectionResult } from '../../shared/contracts'

export const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-flash'

interface DeepSeekResponse {
  model?: unknown
  choices?: Array<{
    finish_reason?: unknown
    message?: { content?: unknown }
  }>
}

export async function testDeepSeekApiKey(
  apiKey: string,
  fetcher: typeof fetch = fetch
): Promise<AiProviderConnectionResult> {
  const normalizedKey = apiKey.trim()
  if (normalizedKey.length < 20 || normalizedKey.length > 500) {
    throw new Error('DeepSeek API 密钥格式不正确')
  }

  const response = await fetcher(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${normalizedKey}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      model: DEFAULT_DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: 'Return one valid JSON object only.' },
        {
          role: 'user',
          content: 'Return this JSON object: {"status":"connected","capability":"schedule_normalization"}'
        }
      ],
      thinking: { type: 'disabled' },
      response_format: { type: 'json_object' },
      max_tokens: 64,
      stream: false
    })
  })

  if (!response.ok) {
    throw new Error(`DeepSeek API 连接失败（HTTP ${response.status}）`)
  }

  const payload = await response.json() as DeepSeekResponse
  const content = payload.choices?.[0]?.message?.content
  const finishReason = payload.choices?.[0]?.finish_reason
  if (typeof content !== 'string' || finishReason !== 'stop') {
    throw new Error('DeepSeek API 未返回完整的结构化结果')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('DeepSeek API 返回的 JSON 无法解析')
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('status' in parsed) ||
    parsed.status !== 'connected' ||
    !('capability' in parsed) ||
    parsed.capability !== 'schedule_normalization'
  ) {
    throw new Error('DeepSeek API 结构化响应校验失败')
  }

  const model = typeof payload.model === 'string' ? payload.model : DEFAULT_DEEPSEEK_MODEL
  return {
    connected: true,
    provider: 'deepseek',
    model,
    message: `DeepSeek 连接正常（${model}）`,
    testedAt: new Date().toISOString()
  }
}
