import { describe, expect, it } from 'vitest'
import { giteeResourceId, isMissingGiteeRelease } from '../scripts/gitee-release-api.mjs'

describe('Gitee release API compatibility', () => {
  it('treats both documented 404 and Gitee 200-null responses as missing releases', () => {
    expect(isMissingGiteeRelease(404, { message: 'Not Found' })).toBe(true)
    expect(isMissingGiteeRelease(200, null)).toBe(true)
    expect(isMissingGiteeRelease(200, { id: 42 })).toBe(false)
  })

  it('accepts numeric and string resource ids without losing large identifiers', () => {
    expect(giteeResourceId(42)).toBe('42')
    expect(giteeResourceId('9223372036854775807')).toBe('9223372036854775807')
    expect(giteeResourceId(0)).toBeNull()
    expect(giteeResourceId('not-an-id')).toBeNull()
  })
})
