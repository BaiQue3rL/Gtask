import { contextBridge, ipcRenderer } from 'electron'
import type { GachaApi } from '../shared/contracts'

const gachaApi: GachaApi = {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  openDataDirectory: () => ipcRenderer.invoke('app:open-data-directory'),
  openExternalUrl: (url) => ipcRenderer.invoke('app:open-external-url', url),
  listBackups: () => ipcRenderer.invoke('backups:list'),
  createBackup: () => ipcRenderer.invoke('backups:create'),
  restoreBackup: (fileName) => ipcRenderer.invoke('backups:restore', fileName),
  getAiScheduleAgentStatus: () => ipcRenderer.invoke('ai-schedule:get-agent-status'),
  getActiveAiScheduleJob: (gameId) => ipcRenderer.invoke('ai-schedule:get-active-job', gameId),
  getSemanticReviewSummary: (gameId) => ipcRenderer.invoke('semantic-review:get-summary', gameId),
  openCodexPlugin: () => ipcRenderer.invoke('codex-plugin:open'),
  listGames: () => ipcRenderer.invoke('games:list'),
  listChecklistItems: (gameId) => ipcRenderer.invoke('checklist:list', gameId),
  listArchivedChecklistItems: (gameId) => ipcRenderer.invoke('checklist:list-archived', gameId),
  createChecklistItem: (input) => ipcRenderer.invoke('checklist:create', input),
  updateChecklistItem: (input) => ipcRenderer.invoke('checklist:update', input),
  archiveChecklistItem: (id) => ipcRenderer.invoke('checklist:archive', id),
  restoreChecklistItem: (id) => ipcRenderer.invoke('checklist:restore', id),
  archiveCompletedSection: (input) => ipcRenderer.invoke('checklist:archive-completed-section', input),
  getSyncSettings: (gameId) => ipcRenderer.invoke('sync:get-settings', gameId),
  getSyncTargetStates: (gameId) => ipcRenderer.invoke('sync:get-target-states', gameId),
  getPersonalSyncTargets: (gameId) => ipcRenderer.invoke('sync:get-personal-targets', gameId),
  syncGame: (gameId, scope, target = 'all') => ipcRenderer.invoke('sync:run', gameId, scope, target),
  syncPersonalData: (gameId, target = 'all') => ipcRenderer.invoke('sync:run-personal', gameId, target),
  listCredentialStatuses: () => ipcRenderer.invoke('credentials:list-status'),
  startMiyousheQrLogin: () => ipcRenderer.invoke('miyoushe-login:start'),
  pollMiyousheQrLogin: (sessionId) => ipcRenderer.invoke('miyoushe-login:poll', sessionId),
  cancelMiyousheQrLogin: (sessionId) => ipcRenderer.invoke('miyoushe-login:cancel', sessionId),
  sendKuroCommunitySms: (phone) =>
    ipcRenderer.invoke('kuro-login:send-sms', phone),
  completeKuroCommunityLogin: (sessionId, code) =>
    ipcRenderer.invoke('kuro-login:complete', sessionId, code),
  storeKuroCommunityLogin: (sessionId, roleId, serverId) =>
    ipcRenderer.invoke('kuro-login:store', sessionId, roleId, serverId),
  cancelKuroCommunityLogin: (sessionId) =>
    ipcRenderer.invoke('kuro-login:cancel', sessionId),
  clearCredential: (provider) => ipcRenderer.invoke('credentials:clear', provider),
  onSyncCompleted: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, result: Parameters<typeof callback>[0]): void => callback(result)
    ipcRenderer.on('sync:completed', listener)
    return () => ipcRenderer.removeListener('sync:completed', listener)
  },
  onSyncProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: Parameters<typeof callback>[0]): void => callback(progress)
    ipcRenderer.on('sync:progress', listener)
    return () => ipcRenderer.removeListener('sync:progress', listener)
  },
  onChecklistChanged: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('checklist:changed', listener)
    return () => ipcRenderer.removeListener('checklist:changed', listener)
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('gacha', gachaApi)
} else {
  Object.assign(window, { gacha: gachaApi })
}
