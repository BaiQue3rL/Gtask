import { describe, expect, it } from 'vitest'
import {
  getPersonalSyncTargets,
  supportsPersonalSyncTarget
} from '../src/main/sync/personal-sync-capabilities'

describe('个人进度同步能力', () => {
  it('只开放个人接口实际提供的版块', () => {
    expect(getPersonalSyncTargets('genshin')).toEqual(['events', 'cycles', 'exploration'])
    expect(getPersonalSyncTargets('star-rail')).toEqual(['events', 'cycles'])
    expect(getPersonalSyncTargets('zenless')).toEqual(['events', 'cycles'])
    expect(getPersonalSyncTargets('wuthering-waves')).toEqual(['cycles', 'exploration'])
    expect(supportsPersonalSyncTarget('star-rail', 'exploration')).toBe(false)
    expect(supportsPersonalSyncTarget('star-rail', 'events')).toBe(true)
    expect(supportsPersonalSyncTarget('genshin', 'exploration')).toBe(true)
    expect(supportsPersonalSyncTarget('wuthering-waves', 'events')).toBe(false)
  })
})
