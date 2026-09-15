import { describe, expect, it, vi } from 'vitest'
import { readBoundedJson } from '../src/main/bounded-response'

describe('bounded update responses', () => {
  it('stops an oversized chunked stream before buffering it and cancels the source', async () => {
    const cancel = vi.fn()
    let reads = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { reads++; controller.enqueue(new Uint8Array(16)) }, cancel
    }, { highWaterMark: 0 })
    await expect(readBoundedJson(new Response(body), 32, new AbortController().signal)).rejects.toThrow('大小限制')
    expect(reads).toBe(3)
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('aborts a body stalled after response headers', async () => {
    const cancel = vi.fn()
    const controller = new AbortController()
    const pending = readBoundedJson(new Response(new ReadableStream({ cancel })), 32, controller.signal)
    controller.abort(new Error('cancelled'))
    await expect(pending).rejects.toThrow('cancelled')
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('preserves UTF-8 split between chunks and rejects dishonest length headers', async () => {
    const bytes = Buffer.from('{"name":"原神"}')
    const body = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
      controller.close()
    } })
    await expect(readBoundedJson(new Response(body), 64, new AbortController().signal)).resolves.toEqual({ name: '原神' })
    await expect(readBoundedJson(new Response('x'.repeat(100), { headers: { 'content-length': '1' } }), 32,
      new AbortController().signal)).rejects.toThrow('大小限制')
  })
})
