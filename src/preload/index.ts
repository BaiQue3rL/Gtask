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
  updateSyncSettings: (input) => ipcRenderer.invoke('sync:update-settings', input),
  syncGame: (gameId, scope) => ipcRenderer.invoke('sync:run', gameId, scope),
  listCredentialStatuses: () => ipcRenderer.invoke('credentials:list-status'),
  startMiyousheQrLogin: () => ipcRenderer.invoke('miyoushe-login:start'),
  pollMiyousheQrLogin: (sessionId) => ipcRenderer.invoke('miyoushe-login:poll', sessionId),
  cancelMiyousheQrLogin: (sessionId) => ipcRenderer.invoke('miyoushe-login:cancel', sessionId),
  clearCredential: (provider) => ipcRenderer.invoke('credentials:clear', provider),
  onSyncCompleted: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, result: Parameters<typeof callback>[0]): void => callback(result)
    ipcRenderer.on('sync:completed', listener)
    return () => ipcRenderer.removeListener('sync:completed', listener)
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
