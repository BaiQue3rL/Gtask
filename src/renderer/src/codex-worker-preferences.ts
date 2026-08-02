import type { CodexWorkerPreferences } from '../../shared/contracts'

/**
 * Electron cannot structured-clone Vue reactive proxies across contextBridge.
 * Copy scalar fields into a fresh plain object before invoking preload.
 */
export function toCodexWorkerPreferencesIpcPayload(
  preferences: CodexWorkerPreferences
): CodexWorkerPreferences {
  return {
    strategy: preferences.strategy,
    model: preferences.model,
    reasoningEffort: preferences.reasoningEffort
  }
}
