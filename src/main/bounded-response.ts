export type BoundedResponse = Pick<Response, 'ok' | 'status' | 'headers' | 'body'>

/** Limit bytes while reading, including decompressed/chunked responses. */
export async function readBoundedJson(response: BoundedResponse, limit: number, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get('content-length')) > limit) {
    void response.body?.cancel().catch(() => {})
    throw new Error('更新数据超过大小限制')
  }
  signal.throwIfAborted()
  if (!response.body) throw new Error('更新数据为空')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  const cancel = (): void => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    for (;;) {
      signal.throwIfAborted()
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) break
      length += value.byteLength
      if (length > limit) throw new Error('更新数据超过大小限制')
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
  } finally {
    signal.removeEventListener('abort', cancel)
    // Do not wait for an uncooperative server to acknowledge cancellation.
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
