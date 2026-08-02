import type { GameId } from '../../shared/contracts'

export type InitialSyncSource = 'personal_data' | 'public_schedule'

export interface PendingInitialSyncSetup {
  gameId: GameId
  source: InitialSyncSource
  allowWithoutCodexPlugin: boolean
}

export type InitialSyncSetupStep = 'codex_plugin' | 'credential' | 'start'

export function claimInitialSyncSetup(
  current: PendingInitialSyncSetup | null,
  gameId: GameId,
  source: InitialSyncSource
): { accepted: boolean; setup: PendingInitialSyncSetup } {
  if (current) return { accepted: false, setup: current }
  return {
    accepted: true,
    setup: { gameId, source, allowWithoutCodexPlugin: false }
  }
}

export function resolveInitialSyncSetupStep(
  setup: PendingInitialSyncSetup,
  codexPluginInstalled: boolean,
  credentialStored: boolean
): InitialSyncSetupStep {
  if (!codexPluginInstalled && !setup.allowWithoutCodexPlugin) return 'codex_plugin'
  if (setup.source === 'personal_data' && !credentialStored) return 'credential'
  return 'start'
}
