import { describe, expect, it } from 'vitest'
import { kuroRoleKey } from '../src/renderer/src/kuro-role-key'

describe('kuroRoleKey', () => {
  it('uses a printable HTML option value and keeps both identifiers distinct', () => {
    const key = kuroRoleKey({
      serverId: 'server:cn',
      roleId: '107489414'
    })

    expect(key).toBe('["server:cn","107489414"]')
    expect(key).not.toMatch(/[\u0000-\u001f]/)
    expect(key).not.toBe(kuroRoleKey({
      serverId: 'server',
      roleId: 'cn:107489414'
    }))
  })
})
