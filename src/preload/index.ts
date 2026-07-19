import { contextBridge, ipcRenderer } from 'electron'
import type { GachaApi } from '../shared/contracts'

const gachaApi: GachaApi = {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  listGames: () => ipcRenderer.invoke('games:list'),
  listChecklistItems: (gameId) => ipcRenderer.invoke('checklist:list', gameId),
  createChecklistItem: (input) => ipcRenderer.invoke('checklist:create', input),
  updateChecklistItem: (input) => ipcRenderer.invoke('checklist:update', input),
  archiveChecklistItem: (id) => ipcRenderer.invoke('checklist:archive', id)
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('gacha', gachaApi)
} else {
  Object.assign(window, { gacha: gachaApi })
}
