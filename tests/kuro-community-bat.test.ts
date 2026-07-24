import { describe, expect, it } from 'vitest'
import { extractKuroBatToken } from '../src/main/sync/kuro-community-bat'

describe('extractKuroBatToken', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature'

  it('accepts both legacy object and current direct-string responses', () => {
    expect(extractKuroBatToken({ accessToken: token })).toBe(token)
    expect(extractKuroBatToken(token)).toBe(token)
  })

  it('rejects ordinary messages and non-ASCII response text', () => {
    expect(extractKuroBatToken('请求成功')).toBeNull()
    expect(extractKuroBatToken('token expired, please login')).toBeNull()
    expect(extractKuroBatToken({ accessToken: '' })).toBeNull()
    expect(extractKuroBatToken(null)).toBeNull()
  })
})
