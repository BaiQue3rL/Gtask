import type { CodexWorkerPreferences } from '../../shared/contracts'

/**
 * Electron cannot structured-clone Vue reactive proxies across contextBridge.
 * Copy the two scalar fields into a fresh plain object before invoking preload.
 */
export function toCodexWorkerPreferencesIpcPayload(
  preferences: CodexWorkerPreferences
): CodexWorkerPreferences {
  return {
    model: preferences.model,
    reasoningEffort: preferences.reasoningEffort
  }
}
