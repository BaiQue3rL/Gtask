import { join } from 'node:path'
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
import { prepareCodexPluginMarketplace } from './ai/codex-plugin-installer'
import { MiyousheQrLoginService } from './auth/miyoushe-qr-login'
import { solveMiyousheGeetest } from './auth/miyoushe-geetest-window'
import { KuroCommunityTokenImportService } from './auth/kuro-community-token-import'
import { createElectronNetFetcher } from './sync/electron-net-fetcher'
import { CredentialBackedAdapter } from './sync/credential-backed-adapter'
import {
  createMiyousheGenshinPersonalAdapter,
  createMiyousheStarRailPersonalAdapter,
  createMiyousheZenlessPersonalAdapter
} from './sync/miyoushe-chronicle-client'
import { createKuroCommunityPersonalAdapter } from './sync/kuro-community-client'
import { encodeKuroCommunityCredential } from './sync/kuro-community-credential'
import { SyncOrchestrator } from './sync/orchestrator'
import { restoreRelaunchOptions } from './relaunch'
import { normalizeSyncItems } from './sync/normalization'
import { getBundledExplorationCatalog } from './sync/bundled-exploration-catalog'
import {
  getPersonalSyncTargets,
  supportsPersonalSyncTarget
} from './sync/personal-sync-capabilities'
import {
  SUPPORTED_GAME_IDS,
  type AiScheduleJob,
  type GameId,
  type SyncProgressUpdate,
  type SyncResult,
  type SyncScope,
  type SyncTarget
} from '../shared/contracts'
import {
  parseChecklistSection,
  parseCredentialProvider,
  parseExternalUrl,
  parseCreateChecklistItem,
  parseGameId,
  parseItemId,
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
let aiJobProgressTimer: ReturnType<typeof setInterval> | null = null
const aiJobProgressSignatures = new Map<GameId, string>()
let credentialVault: CredentialVault | null = null
let miyousheQrLogin: MiyousheQrLoginService | null = null
let kuroCommunityTokenImport: KuroCommunityTokenImportService | null = null
let appBackupDirectory: string | null = null
let appDatabasePath: string | null = null

async function queueAiScheduleSync(
  gameId: GameId,
  scope: SyncScope,
  target: SyncTarget = 'all'
): Promise<SyncResult> {
  if (!appDatabase) throw new Error('数据库尚未初始化')
  const startedAt = new Date().toISOString()
  const sources: SyncResult['sources'] = []
  const bundledCatalogMerge = target === 'all' || target === 'exploration'
    ? appDatabase.mergeSyncedItems(
        gameId,
        'public_schedule',
        normalizeSyncItems(getBundledExplorationCatalog(gameId))
      )
    : null
  try {
    const plugin = detectCodexPlugin()
    const agent = appDatabase.getAiScheduleAgentStatus()
    const job = appDatabase.createAiScheduleJob(gameId, scope, new Date(), plugin.installed, target)
    sendAiJobProgress(job)
    const publicMessage = agent.connected
      ? `已提交给 ${agent.name ?? 'AI 资料 Agent'}，等待联网检索和交叉验证（任务 ${job.id.slice(0, 8)}）`
      : `已排队（任务 ${job.id.slice(0, 8)}）；请在 Codex 打开“幻游清单”插件并运行 $sync-gacha-schedules`
    const catalogMessage = bundledCatalogMerge
      ? `基础地图目录已同步（新增 ${bundledCatalogMerge.added}，更新 ${bundledCatalogMerge.updated}）；`
      : ''
    sources.push({
      source: 'public_schedule',
      status: 'skipped',
      message: `${catalogMessage}${publicMessage}`,
      ...(bundledCatalogMerge ?? { added: 0, updated: 0, preserved: 0 })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法创建 AI 资料任务'
    sources.push({
      source: 'public_schedule',
      status: bundledCatalogMerge ? 'success' : 'error',
      message: bundledCatalogMerge
        ? `基础地图目录已同步（新增 ${bundledCatalogMerge.added}，更新 ${bundledCatalogMerge.updated}）；AI 增量校正未能排队：${message}`
        : message,
      ...(bundledCatalogMerge ?? { added: 0, updated: 0, preserved: 0 })
    })
  }

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
    const publicPending = sources[0]?.status === 'skipped'
    const combinedMessage = `${personal.message}；${publicPending ? '公开资料任务等待 AI 处理' : '公开资料任务未能排队'}`
    const personalStatus = personal.status === 'verification_required'
      ? 'verification_required'
      : personal.status === 'success'
        ? 'idle'
        : 'error'
    appDatabase.recordSyncOutcome(
      gameId,
      personalStatus,
      combinedMessage,
      personal.status === 'success'
    )
  } else if (sources[0]?.status === 'error') {
    appDatabase.recordSyncAttempt(gameId, scope)
    appDatabase.recordSyncOutcome(gameId, 'error', sources[0].message, false)
  }

  const hasPersonalSuccess = sources.some(
    (source) => source.source === 'personal_data' && source.status === 'success'
  )
  const publicStatus = sources[0]?.status
  const finalStatus: SyncResult['status'] = publicStatus === 'error' && !hasPersonalSuccess
    ? 'error'
    : sources.every((source) => source.status === 'success')
      ? 'success'
      : 'partial'
  return {
    gameId,
    requestedScope: scope,
    requestedTarget: target,
    status: finalStatus,
    startedAt,
    finishedAt: new Date().toISOString(),
    sources,
    message: sources.map((source) => source.message).join('；')
  }
}

function toAiJobProgress(job: AiScheduleJob): SyncProgressUpdate {
  return {
    gameId: job.gameId,
    target: job.target,
    source: 'public_schedule',
    phase: job.progressPhase,
    status: job.status === 'pending' ? 'waiting' : 'running',
    message: job.message ?? (job.status === 'pending' ? '等待 Codex 接单' : 'Codex 正在处理'),
    current: job.progressCurrent,
    total: job.progressTotal,
    updatedAt: job.progressUpdatedAt
  }
}

function sendAiJobProgress(job: AiScheduleJob): void {
  mainWindow?.webContents.send('sync:progress', toAiJobProgress(job))
}

function pollAiJobProgress(): void {
  if (!appDatabase) return
  for (const gameId of SUPPORTED_GAME_IDS) {
    const job = appDatabase.getActiveAiScheduleJob(gameId)
    const previousSignature = aiJobProgressSignatures.get(gameId)
    if (!job) {
      if (previousSignature) {
        aiJobProgressSignatures.delete(gameId)
        mainWindow?.webContents.send('checklist:changed')
      }
      continue
    }
    const signature = [
      job.id,
      job.status,
      job.progressPhase,
      job.progressCurrent,
      job.progressTotal,
      job.progressUpdatedAt,
      job.message
    ].join(':')
    if (signature === previousSignature) continue
    aiJobProgressSignatures.set(gameId, signature)
    sendAiJobProgress(job)
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
    if (aiJobProgressTimer) clearInterval(aiJobProgressTimer)
    aiJobProgressTimer = null
    aiJobProgressSignatures.clear()
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
  ipcMain.handle('ai-schedule:get-agent-status', () => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    const appMarketplacePath = join(app.getPath('userData'), 'codex-integration', 'marketplace.json')
    return {
      ...appDatabase.getAiScheduleAgentStatus(),
      codexPluginInstalled: detectCodexPlugin({ appMarketplacePath }).installed
    }
  })
  ipcMain.handle('ai-schedule:get-active-job', (_event, gameId: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.getActiveAiScheduleJob(parseGameId(gameId))
  })
  ipcMain.handle('semantic-review:get-summary', (_event, gameId: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.getSemanticReviewSummary(parseGameId(gameId))
  })
  ipcMain.handle('codex-plugin:open', async () => {
    const integrationDirectory = join(app.getPath('userData'), 'codex-integration')
    const appMarketplacePath = join(integrationDirectory, 'marketplace.json')
    const plugin = detectCodexPlugin({ appMarketplacePath })
    if (plugin.installed) {
      await shell.openExternal(plugin.deeplink)
      return
    }
    const sourcePluginPath = app.isPackaged
      ? join(process.resourcesPath, 'codex-plugin')
      : join(app.getAppPath(), 'integrations', 'gacha-task-manager')
    const prepared = prepareCodexPluginMarketplace({
      sourcePluginPath,
      integrationDirectory,
      executablePath: process.execPath,
      mcpScriptPath: app.isPackaged
        ? join(process.resourcesPath, 'app.asar', 'out', 'main', 'local-mcp-server-cli.js')
        : join(app.getAppPath(), 'out', 'main', 'local-mcp-server-cli.js')
    })
    await shell.openExternal(prepared.deeplink)
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
  ipcMain.handle('sync:get-target-states', (_event, gameId: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.getSyncTargetStates(parseGameId(gameId))
  })
  ipcMain.handle('sync:get-personal-targets', (_event, gameId: unknown) =>
    getPersonalSyncTargets(parseGameId(gameId))
  )
  ipcMain.handle('sync:run', async (_event, gameId: unknown, scope: unknown, target: unknown = 'all') => {
    return await queueAiScheduleSync(
      parseGameId(gameId),
      parseSyncScope(scope),
      parseSyncTarget(target)
    )
  })
  ipcMain.handle('sync:run-personal', async (_event, gameId: unknown, target: unknown = 'all') => {
    if (!syncOrchestrator) throw new Error('个人数据同步服务尚未初始化')
    const parsedGameId = parseGameId(gameId)
    const parsedTarget = parseSyncTarget(target)
    if (parsedTarget === 'all' || parsedTarget === 'tasks') {
      throw new Error('同步进度只能从活动、周期事项或地图探索版块发起')
    }
    if (!supportsPersonalSyncTarget(parsedGameId, parsedTarget)) {
      throw new Error('当前游戏的个人数据接口不提供该版块进度')
    }
    return await syncOrchestrator.syncPersonalOnly(
      parsedGameId,
      parsedTarget
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
  ipcMain.handle(
    'kuro-credential:list-roles',
    async (_event, token: unknown, did: unknown) => {
      if (!kuroCommunityTokenImport) throw new Error('库街区凭据服务尚未初始化')
      return await kuroCommunityTokenImport.listRoles(token, did)
    }
  )
  ipcMain.handle('kuro-credential:store', async (_event, input: unknown) => {
    if (!kuroCommunityTokenImport || !credentialVault) {
      throw new Error('库街区凭据服务尚未初始化')
    }
    const credential = await kuroCommunityTokenImport.validateCredential(input)
    return credentialVault.store(
      'kuro-community',
      encodeKuroCommunityCredential(credential)
    )
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
    const fetcher = createElectronNetFetcher(net.fetch)
    miyousheQrLogin = new MiyousheQrLoginService(fetcher)
    kuroCommunityTokenImport = new KuroCommunityTokenImportService(fetcher)
    try {
      await createDailyBackup(appDatabase, backupDirectory)
      pruneDailyBackups(backupDirectory)
    } catch (error) {
      console.error('创建或整理每日数据库备份失败', error)
    }
    syncOrchestrator = createAppSyncOrchestrator(appDatabase)
    registerIpcHandlers()
    createWindow()
    periodTimer = setInterval(() => {
      const changes =
        (appDatabase?.resetDueWeeklyItems() ?? 0) +
        (appDatabase?.resetDueQuestItems() ?? 0) +
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
    pollAiJobProgress()
    aiJobProgressTimer = setInterval(pollAiJobProgress, 2_000)

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
  if (aiJobProgressTimer) clearInterval(aiJobProgressTimer)
  aiJobProgressTimer = null
  aiJobProgressSignatures.clear()
  appDatabase?.close()
  appDatabase = null
  syncOrchestrator = null
  credentialVault = null
  miyousheQrLogin = null
  kuroCommunityTokenImport = null
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
  const reportProgress = (progress: SyncProgressUpdate): void => {
    mainWindow?.webContents.send('sync:progress', progress)
  }
  if (!credentialVault) return new SyncOrchestrator(database, undefined, reportProgress)
  const fetcher = createElectronNetFetcher(net.fetch)
  return new SyncOrchestrator(database, {
    publicSchedule: {},
    personalData: {
      genshin: new CredentialBackedAdapter(
        'miyoushe',
        credentialVault,
        (credential, onProgress) => createMiyousheGenshinPersonalAdapter(
          credential,
          fetcher,
          (challenge) => solveMiyousheGeetest(mainWindow, challenge),
          onProgress
        )
      ),
      'star-rail': new CredentialBackedAdapter(
        'miyoushe',
        credentialVault,
        (credential, onProgress) => createMiyousheStarRailPersonalAdapter(
          credential,
          fetcher,
          (challenge) => solveMiyousheGeetest(mainWindow, challenge),
          onProgress
        )
      ),
      zenless: new CredentialBackedAdapter(
        'miyoushe',
        credentialVault,
        (credential, onProgress) => createMiyousheZenlessPersonalAdapter(
          credential,
          fetcher,
          (challenge) => solveMiyousheGeetest(mainWindow, challenge),
          onProgress
        )
      ),
      'wuthering-waves': new CredentialBackedAdapter(
        'kuro-community',
        credentialVault,
        (credential, onProgress) => createKuroCommunityPersonalAdapter(
          credential,
          fetcher,
          onProgress
        )
      )
    }
  }, reportProgress)
}
