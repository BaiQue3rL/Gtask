import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { AppDatabase } from './database'
import {
  parseCreateChecklistItem,
  parseGameId,
  parseItemId,
  parseUpdateChecklistItem
} from './validation'

let mainWindow: BrowserWindow | null = null
let appDatabase: AppDatabase | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#061126',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('app:get-info', () => ({
    version: app.getVersion(),
    dataPath: app.getPath('userData')
  }))

  ipcMain.handle('games:list', () => appDatabase?.listGames() ?? [])
  ipcMain.handle('checklist:list', (_event, gameId: unknown) =>
    appDatabase?.listChecklistItems(parseGameId(gameId)) ?? []
  )
  ipcMain.handle('checklist:create', (_event, input: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.createChecklistItem(parseCreateChecklistItem(input))
  })
  ipcMain.handle('checklist:update', (_event, input: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.updateChecklistItem(parseUpdateChecklistItem(input))
  })
  ipcMain.handle('checklist:archive', (_event, id: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    appDatabase.archiveChecklistItem(parseItemId(id))
  })
}

app.whenReady().then(() => {
  appDatabase = new AppDatabase(join(app.getPath('userData'), 'data', 'gacha-task-manager.sqlite'))
  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  appDatabase?.close()
  appDatabase = null
})
