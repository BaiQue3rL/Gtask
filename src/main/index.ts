import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell } from 'electron'
import { AppDatabase, CURRENT_SCHEMA_VERSION } from './database'
import {
  createDailyBackup,
  createManualBackup,
  createPreMigrationBackup,
  listBackups,
  pruneDailyBackups,
  restoreBackup
} from './backup'
import { CredentialVault, removeRetiredDeepSeekCredential } from './credential-vault'
import { detectCodexPlugin } from './ai/codex-plugin'
import { MiyousheQrLoginService } from './auth/miyoushe-qr-login'
import { solveMiyousheGeetest } from './auth/miyoushe-geetest-window'
import { createElectronNetFetcher } from './sync/electron-net-fetcher'
import { CredentialBackedAdapter } from './sync/credential-backed-adapter'
import {
  createMiyousheGenshinPersonalAdapter,
  createMiyousheZenlessPersonalAdapter
} from './sync/miyoushe-chronicle-client'
import { SyncOrchestrator } from './sync/orchestrator'
import { restoreRelaunchOptions } from './relaunch'
import { recognizeScheduleImage } from './schedule-image-import'
import { parseScheduleImageText } from './schedule-image-parser'
import { normalizeSyncItems } from './sync/normalization'
import type { GameId, SyncResult, SyncScope, SyncTarget } from '../shared/contracts'
import {
  parseChecklistSection,
  parseCredentialProvider,
  parseExternalUrl,
  parseCreateChecklistItem,
  parseGameId,
  parseItemId,
  parseSyncRunMode,
  parseSyncScope,
  parseSyncTarget,
  parseUpdateChecklistItem
} from './validation'

const SECTION_CATEGORIES = {
  tasks: ['main_quest', 'side_quest'],
  events: ['limited_event', 'permanent_event'],
  cycles: ['weekly', 'endgame'],
  exploration: ['exploration'],
  custom: ['custom']
} as const

let mainWindow: BrowserWindow | null = null
let appDatabase: AppDatabase | null = null
let syncOrchestrator: SyncOrchestrator | null = null
let periodTimer: ReturnType<typeof setInterval> | null = null
let externalChangeTimer: ReturnType<typeof setInterval> | null = null
let credentialVault: CredentialVault | null = null
let miyousheQrLogin: MiyousheQrLoginService | null = null
let appBackupDirectory: string | null = null
let appDatabasePath: string | null = null

async function queueAiScheduleSync(
  gameId: GameId,
  scope: SyncScope,
  target: SyncTarget = 'all'
): Promise<SyncResult> {
  if (!appDatabase) throw new Error('数据库尚未初始化')
  const startedAt = new Date().toISOString()
  try {
    const plugin = detectCodexPlugin()
    const agent = appDatabase.getAiScheduleAgentStatus()
    const job = appDatabase.createAiScheduleJob(gameId, scope, new Date(), plugin.installed, target)
    const publicMessage = agent.connected
      ? `已提交给 ${agent.name ?? 'AI 排期 Agent'}，等待联网检索和交叉验证（任务 ${job.id.slice(0, 8)}）`
      : `已排队（任务 ${job.id.slice(0, 8)}）；请在 Codex 打开“幻游清单”插件并运行 $sync-gacha-schedules`
    const sources: SyncResult['sources'] = [{
      source: 'public_schedule',
      status: 'skipped',
      message: publicMessage,
      added: 0,
      updated: 0,
      preserved: 0
    }]
    if (scope === 'public_and_personal') {
      const personal = syncOrchestrator
        ? await syncOrchestrator.syncPersonalData(gameId, target)
        : {
            source: 'personal_data' as const,
            status: 'error' as const,
            message: '个人数据同步服务尚未初始化',
            added: 0,
            updated: 0,
            preserved: 0
          }
      sources.push(personal)
      const waitingMessage = `${personal.message}；公开排期任务等待 AI 处理`
      const personalStatus = personal.status === 'verification_required'
        ? 'verification_required'
        : personal.status === 'success'
          ? 'idle'
          : 'error'
      appDatabase.recordSyncOutcome(
        gameId,
        personalStatus,
        waitingMessage,
        personal.status === 'success'
      )
    }
    return {
      gameId,
      requestedScope: scope,
      requestedTarget: target,
      status: 'partial',
      startedAt,
      finishedAt: new Date().toISOString(),
      sources,
      message: sources.map((source) => source.message).join('；')
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法创建 AI 排期任务'
    appDatabase.recordSyncAttempt(gameId, scope)
    appDatabase.recordSyncOutcome(gameId, 'error', message, false)
    return {
      gameId,
      requestedScope: scope,
      requestedTarget: target,
      status: 'error',
      startedAt,
      finishedAt: new Date().toISOString(),
      sources: [{
        source: 'public_schedule',
        status: 'error',
        message,
        added: 0,
        updated: 0,
        preserved: 0
      }],
      message
    }
  }
}

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
    try {
      void shell.openExternal(parseExternalUrl(url))
    } catch (error) {
      console.warn('已阻止不安全的外部链接', error)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.once('did-finish-load', () => {
    mainWindow?.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      try {
        void shell.openExternal(parseExternalUrl(url))
      } catch (error) {
        console.warn('已阻止主窗口导航到不安全链接', error)
      }
    })
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
  ipcMain.handle('app:open-data-directory', async () => {
    const message = await shell.openPath(app.getPath('userData'))
    if (message) throw new Error(message)
  })
  ipcMain.handle('app:open-external-url', async (_event, value: unknown) => {
    await shell.openExternal(parseExternalUrl(value))
  })
  ipcMain.handle('backups:list', () => {
    if (!appBackupDirectory) throw new Error('备份目录尚未初始化')
    return listBackups(appBackupDirectory)
  })
  ipcMain.handle('backups:create', async () => {
    if (!appDatabase || !appBackupDirectory) throw new Error('备份服务尚未初始化')
    const path = await createManualBackup(appDatabase, appBackupDirectory)
    const backup = listBackups(appBackupDirectory).find((candidate) => path.endsWith(candidate.fileName))
    if (!backup) throw new Error('备份已创建但无法读取备份信息')
    return backup
  })
  ipcMain.handle('backups:restore', async (_event, fileName: unknown) => {
    if (!appDatabase || !appDatabasePath || !appBackupDirectory) {
      throw new Error('备份服务尚未初始化')
    }
    if (typeof fileName !== 'string') throw new Error('备份文件名格式不正确')
    const candidate = listBackups(appBackupDirectory).find((backup) => backup.fileName === fileName)
    if (!candidate) throw new Error('找不到指定的备份文件')
    const confirmationOptions = {
      type: 'warning',
      title: '恢复本地备份',
      message: `确定恢复备份“${candidate.fileName}”吗？`,
      detail: '当前数据库会先自动生成一份“恢复前”安全备份，随后应用将重新启动。',
      buttons: ['取消', '恢复并重启'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    } satisfies Electron.MessageBoxOptions
    const confirmation = mainWindow
      ? await dialog.showMessageBox(mainWindow, confirmationOptions)
      : await dialog.showMessageBox(confirmationOptions)
    if (confirmation.response !== 1) return false
    try {
      await restoreBackup(appDatabase, appDatabasePath, appBackupDirectory, fileName)
    } catch (error) {
      try {
        appDatabase.close()
      } catch {
        // The restore helper may already have closed this handle.
      }
      appDatabase = new AppDatabase(appDatabasePath)
      syncOrchestrator = createAppSyncOrchestrator(appDatabase)
      throw error
    }
    appDatabase = null
    syncOrchestrator = null
    if (periodTimer) clearInterval(periodTimer)
    periodTimer = null
    if (externalChangeTimer) clearInterval(externalChangeTimer)
    externalChangeTimer = null
    setTimeout(() => {
      try {
        const relaunchOptions = restoreRelaunchOptions(process.env, process.argv)
        if (relaunchOptions) app.relaunch(relaunchOptions)
        else app.relaunch()
      } catch (error) {
        dialog.showErrorBox(
          '数据已恢复，请手动重新打开应用',
          error instanceof Error ? error.message : '无法自动重新启动应用'
        )
      } finally {
        app.exit(0)
      }
    }, 150)
    return true
  })
  ipcMain.handle('schedule-image:recognize', async (_event, targetValue: unknown) => {
    const target = parseSyncTarget(targetValue)
    if (target === 'all' || target === 'tasks') throw new Error('该版块不支持图片导入')
    const selection = await dialog.showOpenDialog(mainWindow!, {
      title: '选择官方排期图片',
      properties: ['openFile'],
      filters: [{ name: '排期图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
    })
    const imagePath = selection.filePaths[0]
    if (selection.canceled || !imagePath) return null
    return recognizeScheduleImage(imagePath, target, app.isPackaged ? {
      langPath: join(process.resourcesPath, 'ocr'),
      workerPath: join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        'tesseract.js',
        'src',
        'worker-script',
        'node',
        'index.js'
      )
    } : {})
  })
  ipcMain.handle('schedule-image:parse-text', (_event, input: unknown) => {
    if (typeof input !== 'object' || input === null) throw new Error('OCR 文本解析参数格式不正确')
    const value = input as Record<string, unknown>
    const target = parseSyncTarget(value.target)
    if (target === 'all' || target === 'tasks') throw new Error('该版块不支持图片导入')
    if (typeof value.rawText !== 'string' || !value.rawText.trim() || value.rawText.length > 50_000) {
      throw new Error('OCR 文本为空或过长')
    }
    if (
      typeof value.sourceOffsetMinutes !== 'number' ||
      !Number.isInteger(value.sourceOffsetMinutes) ||
      value.sourceOffsetMinutes < -12 * 60 ||
      value.sourceOffsetMinutes > 14 * 60
    ) throw new Error('来源 UTC 偏移量格式不正确')
    return parseScheduleImageText(
      value.rawText,
      new Date(),
      value.sourceOffsetMinutes
    ).map((candidate) => ({
      ...candidate,
      category: target === 'cycles'
        ? 'endgame' as const
        : target === 'exploration'
          ? 'exploration' as const
          : candidate.category
    }))
  })
  ipcMain.handle('schedule-image:apply', (_event, input: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    if (typeof input !== 'object' || input === null) throw new Error('图片导入参数格式不正确')
    const value = input as Record<string, unknown>
    const gameId = parseGameId(value.gameId)
    const target = parseSyncTarget(value.target)
    if (target === 'all' || target === 'tasks' || !Array.isArray(value.items)) {
      throw new Error('图片导入版块或事项格式不正确')
    }
    const allowed = {
      events: ['limited_event'],
      cycles: ['weekly', 'endgame'],
      exploration: ['exploration']
    }[target]
    const items = value.items.map((candidate) => {
      const parsed = parseCreateChecklistItem({
        ...(typeof candidate === 'object' && candidate !== null ? candidate : {}),
        gameId
      })
      if (!allowed.includes(parsed.category)) throw new Error('图片导入包含其他版块的数据')
      if (
        ['limited_event', 'endgame'].includes(parsed.category) &&
        (!parsed.startsAt || !parsed.endsAt)
      ) throw new Error(`“${parsed.title}”缺少完整起止时间`)
      const identity = createHash('sha256')
        .update(`${gameId}|${parsed.category}|${parsed.title}`)
        .digest('hex')
        .slice(0, 24)
      return {
        remoteKey: `image:${identity}`,
        category: parsed.category,
        title: parsed.title,
        startsAt: parsed.startsAt,
        endsAt: parsed.endsAt,
        parentTitle: parsed.parentTitle,
        modeKey: parsed.modeKey,
        recurrenceRule: parsed.recurrenceRule,
        scheduleKind: parsed.scheduleKind
      }
    })
    return appDatabase.mergeSyncedItems(
      gameId,
      'public_schedule',
      normalizeSyncItems(items)
    )
  })
  ipcMain.handle('ai-schedule:get-agent-status', () => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return {
      ...appDatabase.getAiScheduleAgentStatus(),
      codexPluginInstalled: detectCodexPlugin().installed
    }
  })
  ipcMain.handle('codex-plugin:open', async () => {
    const plugin = detectCodexPlugin()
    if (!plugin.installed) throw new Error('尚未安装或启用“幻游清单”Codex 插件')
    await shell.openExternal(plugin.deeplink)
  })

  ipcMain.handle('games:list', () => appDatabase?.listGames() ?? [])
  ipcMain.handle('checklist:list', (_event, gameId: unknown) =>
    appDatabase?.listChecklistItems(parseGameId(gameId)) ?? []
  )
  ipcMain.handle('checklist:list-archived', (_event, gameId: unknown) =>
    appDatabase?.listArchivedChecklistItems(parseGameId(gameId)) ?? []
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
  ipcMain.handle('checklist:restore', (_event, id: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.restoreChecklistItem(parseItemId(id))
  })
  ipcMain.handle('checklist:archive-completed-section', (_event, input: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    if (typeof input !== 'object' || input === null) throw new Error('批量删除参数格式不正确')
    const value = input as Record<string, unknown>
    const gameId = parseGameId(value.gameId)
    const section = parseChecklistSection(value.section)
    return appDatabase.archiveCompletedSection(gameId, [...SECTION_CATEGORIES[section]])
  })
  ipcMain.handle('sync:get-settings', (_event, gameId: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.getSyncSettings(parseGameId(gameId))
  })
  ipcMain.handle('sync:update-settings', (_event, input: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    if (typeof input !== 'object' || input === null) throw new Error('同步设置参数格式不正确')
    const value = input as Record<string, unknown>
    return appDatabase.updateSyncSettings({
      gameId: parseGameId(value.gameId),
      runMode: parseSyncRunMode(value.runMode),
      autoScope: parseSyncScope(value.autoScope)
    })
  })
  ipcMain.handle('sync:run', async (_event, gameId: unknown, scope: unknown, target: unknown = 'all') => {
    return await queueAiScheduleSync(
      parseGameId(gameId),
      parseSyncScope(scope),
      parseSyncTarget(target)
    )
  })
  ipcMain.handle('credentials:list-status', () => {
    if (!credentialVault) throw new Error('安全凭据存储尚未初始化')
    return [
      credentialVault.status('miyoushe'),
      credentialVault.status('kuro-community')
    ]
  })
  ipcMain.handle('miyoushe-login:start', async () => {
    if (!miyousheQrLogin) throw new Error('米游社登录服务尚未初始化')
    return miyousheQrLogin.start()
  })
  ipcMain.handle('miyoushe-login:poll', async (_event, value: unknown) => {
    if (!miyousheQrLogin || !credentialVault) throw new Error('米游社登录服务尚未初始化')
    const sessionId = parseQrLoginSessionId(value)
    const result = await miyousheQrLogin.poll(sessionId)
    if (result.credential) {
      credentialVault.store('miyoushe', {
        kind: 'cookie',
        value: result.credential.cookie,
        accountLabel: result.credential.accountLabel
      })
    }
    return result.state
  })
  ipcMain.handle('miyoushe-login:cancel', (_event, value: unknown) => {
    if (!miyousheQrLogin) throw new Error('米游社登录服务尚未初始化')
    return miyousheQrLogin.cancel(parseQrLoginSessionId(value))
  })
  ipcMain.handle('credentials:clear', (_event, provider: unknown) => {
    if (!credentialVault) throw new Error('安全凭据存储尚未初始化')
    return credentialVault.clear(parseCredentialProvider(provider))
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    const databasePath = join(app.getPath('userData'), 'data', 'gacha-task-manager.sqlite')
    const backupDirectory = join(app.getPath('userData'), 'backups')
    appBackupDirectory = backupDirectory
    appDatabasePath = databasePath
    try {
      await createPreMigrationBackup(databasePath, backupDirectory, CURRENT_SCHEMA_VERSION)
    } catch (error) {
      dialog.showErrorBox(
        '无法安全升级数据库',
        error instanceof Error ? error.message : '创建迁移前备份失败'
      )
      app.quit()
      return
    }
    try {
      appDatabase = new AppDatabase(databasePath)
    } catch (error) {
      dialog.showErrorBox(
        '无法打开本地数据库',
        error instanceof Error ? error.message : '数据库初始化失败'
      )
      app.quit()
      return
    }
    const credentialDirectory = join(app.getPath('userData'), 'credentials')
    removeRetiredDeepSeekCredential(credentialDirectory)
    credentialVault = new CredentialVault(credentialDirectory, {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      protect: (plainText) => safeStorage.encryptString(plainText),
      unprotect: (encrypted) => safeStorage.decryptString(encrypted)
    })
    miyousheQrLogin = new MiyousheQrLoginService(createElectronNetFetcher(net.fetch))
    try {
      await createDailyBackup(appDatabase, backupDirectory)
      pruneDailyBackups(backupDirectory)
    } catch (error) {
      console.error('创建或整理每日数据库备份失败', error)
    }
    syncOrchestrator = createAppSyncOrchestrator(appDatabase)
    registerIpcHandlers()
    createWindow()
    for (const settings of appDatabase.listAutomaticSyncSettings()) {
      void queueAiScheduleSync(settings.gameId as GameId, settings.autoScope).then((result) => {
        mainWindow?.webContents.send('sync:completed', result)
      })
    }
    periodTimer = setInterval(() => {
      const changes =
        (appDatabase?.resetDueWeeklyItems() ?? 0) +
        (appDatabase?.rollDueRecurringItems() ?? 0) +
        (appDatabase?.markStaleSyncStates() ?? 0)
      if (changes > 0) mainWindow?.webContents.send('checklist:changed')
    }, 60_000)
    let lastDataVersion = appDatabase.getDataVersion()
    externalChangeTimer = setInterval(() => {
      const currentDataVersion = appDatabase?.getDataVersion() ?? lastDataVersion
      if (currentDataVersion === lastDataVersion) return
      lastDataVersion = currentDataVersion
      mainWindow?.webContents.send('checklist:changed')
    }, 2_000)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (periodTimer) clearInterval(periodTimer)
  periodTimer = null
  if (externalChangeTimer) clearInterval(externalChangeTimer)
  externalChangeTimer = null
  appDatabase?.close()
  appDatabase = null
  syncOrchestrator = null
  credentialVault = null
  miyousheQrLogin = null
  appBackupDirectory = null
  appDatabasePath = null
})

function parseQrLoginSessionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error('二维码登录会话标识格式不正确')
  }
  return value
}

function createAppSyncOrchestrator(database: AppDatabase): SyncOrchestrator {
  if (!credentialVault) return new SyncOrchestrator(database)
  const fetcher = createElectronNetFetcher(net.fetch)
  return new SyncOrchestrator(database, {
    publicSchedule: {},
    personalData: {
      genshin: new CredentialBackedAdapter(
        'miyoushe',
        credentialVault,
        (credential) => createMiyousheGenshinPersonalAdapter(
          credential,
          fetcher,
          (challenge) => solveMiyousheGeetest(mainWindow, challenge)
        )
      ),
      zenless: new CredentialBackedAdapter(
        'miyoushe',
        credentialVault,
        (credential) => createMiyousheZenlessPersonalAdapter(
          credential,
          fetcher,
          (challenge) => solveMiyousheGeetest(mainWindow, challenge)
        )
      )
    }
  })
}
