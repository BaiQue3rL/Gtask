import { describe, expect, it } from 'vitest'
import {
  claimInitialSyncSetup,
  resolveInitialSyncSetupStep
} from '../src/renderer/src/initial-onboarding'

describe('initial onboarding flow', () => {
  it('accepts only the first source choice while setup is pending', () => {
    const first = claimInitialSyncSetup(null, 'genshin', 'personal_data')
    const second = claimInitialSyncSetup(first.setup, 'genshin', 'public_schedule')

    expect(first.accepted).toBe(true)
    expect(second).toEqual({ accepted: false, setup: first.setup })
  })

  it('does not start personal requests before plugin and credential checks finish', () => {
    const setup = claimInitialSyncSetup(null, 'genshin', 'personal_data').setup
    expect(resolveInitialSyncSetupStep(setup, false, false)).toBe('codex_plugin')
    expect(resolveInitialSyncSetupStep(setup, true, false)).toBe('credential')
    expect(resolveInitialSyncSetupStep(setup, true, true)).toBe('start')
  })

  it('allows personal mechanical sync after explicitly postponing plugin setup', () => {
    const setup = {
      ...claimInitialSyncSetup(null, 'genshin', 'personal_data').setup,
      allowWithoutCodexPlugin: true
    }
    expect(resolveInitialSyncSetupStep(setup, false, false)).toBe('credential')
    expect(resolveInitialSyncSetupStep(setup, false, true)).toBe('start')
  })

  it('requires the plugin before public data sync can start', () => {
    const setup = claimInitialSyncSetup(null, 'genshin', 'public_schedule').setup
    expect(resolveInitialSyncSetupStep(setup, false, true)).toBe('codex_plugin')
    expect(resolveInitialSyncSetupStep(setup, true, false)).toBe('start')
  })
})
