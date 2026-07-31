import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { freemem, totalmem } from 'node:os'
import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, session, shell } from 'electron'
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
import {
  installCodexPluginFromPersonalMarketplace,
  prepareStableMcpElectronRuntime,
  prepareCodexPluginMarketplace,
  refreshCodexMcpLauncher
} from './ai/codex-plugin-installer'
import {
  CodexDynamicConcurrencyController,
  CodexScheduleWorkerPool,
  findCodexCli,
  type CodexWorkerTransportMode,
  type CodexScheduleWorkerEvent
} from './ai/codex-schedule-worker'
import {
  resolveLoopbackHttpProxy
} from './ai/codex-proxy-repair'
import { MiyousheQrLoginService } from './auth/miyoushe-qr-login'
import { solveMiyousheGeetest } from './auth/miyoushe-geetest-window'
import { KuroCommunityCredentialService } from './auth/kuro-community-credential'
import {
  KURO_COMMUNITY_CAPTCHA_ID,
  KuroCommunityLoginService
} from './auth/kuro-community-login'
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
import { syncPersonalBeforeCatalogBootstrap } from './sync/personal-catalog-bootstrap'
import { restoreRelaunchOptions } from './relaunch'
import { migrateLegacyAppData, resolveAppDataPaths } from './data-paths'
import { getFixedWeeklyBootstrap } from './sync/public-sync-bootstrap'
import {
  getBundledMapCatalog,
  getBundledMapCatalogVerifiedAt
} from './sync/map-catalog'
import {
  evaluateMapCatalogFreshness,
  selectRelevantVersionWindow,
  type MapCatalogAuditReason
} from './sync/map-catalog-freshness'
import {
  getPersonalSyncTargets,
  supportsPersonalSyncTarget
} from './sync/personal-sync-capabilities'
import {
  SUPPORTED_GAME_IDS,
  type AiScheduleJob,
  type CodexConnectionRepairMode,
  type CodexConnectionRepairResult,
  type GameId,
  type SyncProgressUpdate,
  type SyncRequestContext,
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
  parseSyncRequestContext,
  parseSyncTarget,
  parseUpdateChecklistItem
} from './validation'

const SECTION_CATEGORIES = {
  tasks: ['main_quest', 'side_quest'],
  events: ['limited_event'],
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
const aiJobProgressSignatures = new Map<string, string>()
let codexScheduleWorkerPool: CodexScheduleWorkerPool | null = null
let credentialVault: CredentialVault | null = null
let miyousheQrLogin: MiyousheQrLoginService | null = null
let kuroCommunityCredential: KuroCommunityCredentialService | null = null
let kuroCommunityLogin: KuroCommunityLoginService | null = null
let appBackupDirectory: string | null = null
let appDatabasePath: string | null = null
let appDataRoot: string | null = null
let codexWorkerEnvironment: NodeJS.ProcessEnv = {}
let codexWorkerTransportMode: CodexWorkerTransportMode = 'websocket_preferred'
const codexConcurrency = new CodexDynamicConcurrencyController()
let isShuttingDown = false

function reportBackgroundError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    codexConcurrency.recordBackpressure()
    console.warn(`${context}暂时遇到数据库占用，稍后自动重试`)
    return
  }
  console.error(`${context}失败`, error)
}

function shutdownApplicationRuntime(): void {
  if (isShuttingDown) return
  isShuttingDown = true
  if (periodTimer) clearInterval(periodTimer)
  periodTimer = null
  if (externalChangeTimer) clearInterval(externalChangeTimer)
  externalChangeTimer = null
  if (aiJobProgressTimer) clearInterval(aiJobProgressTimer)
  aiJobProgressTimer = null
  aiJobProgressSignatures.clear()

  syncOrchestrator?.shutdown()
  miyousheQrLogin?.dispose()
  kuroCommunityLogin?.dispose()
  try {
    appDatabase?.cancelAllActiveAiScheduleJobs()
    appDatabase?.cancelAllSemanticReviewCandidates()
  } catch (error) {
    reportBackgroundError('退出时取消同步任务', error)
  }
  codexScheduleWorkerPool?.stop()
  codexScheduleWorkerPool = null

  try {
    appDatabase?.close()
  } catch (error) {
    reportBackgroundError('退出时关闭数据库', error)
  }
  appDatabase = null
  syncOrchestrator = null
  credentialVault = null
  miyousheQrLogin = null
  kuroCommunityCredential = null
  kuroCommunityLogin = null
  appBackupDirectory = null
  appDatabasePath = null
  appDataRoot = null
}

function codexMcpLauncherOptions() {
  const integrationDirectory = join(app.getPath('userData'), 'codex-integration')
  const sourceScriptPath = app.isPackaged
    ? join(process.resourcesPath, 'codex-mcp-runtime', 'local-mcp-server-cli.js')
    : join(app.getAppPath(), 'out', 'main', 'local-mcp-server-cli.js')
  const runtimeDirectory = join(integrationDirectory, 'mcp-runtime')
  mkdirSync(runtimeDirectory, { recursive: true })
  cpSync(dirname(sourceScriptPath), runtimeDirectory, { recursive: true, force: true })
  const executablePath = prepareStableMcpElectronRuntime(
    process.execPath,
    integrationDirectory,
    app.getVersion()
  )
  return {
    integrationDirectory,
    executablePath,
    mcpScriptPath: join(runtimeDirectory, 'local-mcp-server-cli.js'),
    databasePath: appDatabasePath ?? join(app.getPath('documents'), 'GachaTaskManager', 'data', 'gacha-task-manager.sqlite'),
    commandShellPath: process.env.ComSpec ??
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  }
}

function createCodexWorkerPool(): CodexScheduleWorkerPool {
  return new CodexScheduleWorkerPool({
    workingDirectory: app.getPath('userData'),
    env: codexWorkerEnvironment,
    transportMode: codexWorkerTransportMode,
    onEvent: handleCodexScheduleWorkerEvent
  })
}

function restartCodexWorkers(message: string): void {
  if (!appDatabase) throw new Error('数据库尚未初始化')
  const agentIds = codexScheduleWorkerPool?.agentIds ?? []
  codexScheduleWorkerPool?.stop()
  for (const agentId of agentIds) {
    appDatabase.requeueClaimedAiScheduleJobsByAgent(agentId)
  }
  codexScheduleWorkerPool = createCodexWorkerPool()
  appDatabase.updatePendingAiScheduleJobsMessage(message, null, null)
  startCodexWorkersForActiveJobs()
  pollAiJobProgress()
}

async function queueAiScheduleSync(
  gameId: GameId,
  scope: SyncScope,
  target: SyncTarget = 'all',
  requestContext: SyncRequestContext = {
    outputLocale: 'zh-CN',
    userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  },
  queuedJobScope: SyncScope = scope
): Promise<SyncResult> {
  if (!appDatabase) throw new Error('数据库尚未初始化')
  if (scope === 'public_and_personal') {
    const catalogComplete =
      target !== 'all' &&
      target !== 'tasks' &&
      appDatabase.isCatalogComplete(gameId, target)
    return syncPersonalBeforeCatalogBootstrap({
      catalogComplete,
      isCatalogComplete: () =>
        target !== 'all' &&
        target !== 'tasks' &&
        Boolean(appDatabase?.isCatalogComplete(gameId, target)),
      syncPersonal: async () => {
        if (syncOrchestrator) {
          return syncOrchestrator.syncPersonalOnly(gameId, target, requestContext)
        }
        const timestamp = new Date().toISOString()
        return {
          gameId,
          requestedScope: 'personal_data',
          requestedTarget: target,
          status: 'error',
          startedAt: timestamp,
          finishedAt: timestamp,
          sources: [{
            source: 'personal_data',
            status: 'error',
            message: '个人数据同步服务尚未初始化',
            added: 0,
            updated: 0,
            preserved: 0
          }],
          message: '个人数据同步服务尚未初始化'
        }
      },
      queueCatalog: () => queueAiScheduleSync(
        gameId,
        'public_schedule',
        target,
        requestContext,
        'public_and_personal'
      )
    })
  }
  const startedAt = new Date().toISOString()
  let mapAuditReason: MapCatalogAuditReason | null = null
  let mapMerge: { added: number; updated: number; preserved: number } | null = null
  if (target === 'exploration') {
    const reference = new Date()
    mapMerge = maintainBundledMapCatalog(appDatabase, gameId, reference, false)
    const freshness = evaluateMapCatalogFreshness({
      bundledVerifiedAt: getBundledMapCatalogVerifiedAt(gameId),
      lastCodexAuditAt: appDatabase.getLastCompletedCatalogAuditAt(gameId, 'exploration'),
      versionWindow: selectRelevantVersionWindow(
        appDatabase.listChecklistItems(gameId),
        reference
      ),
      reference
    })
    mapAuditReason = freshness.reason
    if (!freshness.shouldAudit) {
      const message = `地图基准目录已同步：新增 ${mapMerge.added}，更新 ${mapMerge.updated}；当前版本无需增量核验`
      appDatabase.recordSyncAttempt(gameId, scope)
      appDatabase.recordSyncTargetSuccess(gameId, target, reference)
      appDatabase.recordSyncOutcome(gameId, 'success', message, true)
      return {
        gameId,
        requestedScope: scope,
        requestedTarget: target,
        status: 'success',
        startedAt,
        finishedAt: new Date().toISOString(),
        sources: [{
          source: 'public_schedule',
          status: 'success',
          message,
          ...mapMerge
        }],
        message
      }
    }
  }
  const sources: SyncResult['sources'] = []
  const fixedWeeklyMerge = target === 'all' || target === 'cycles'
    ? appDatabase.mergeSyncedItems(
        gameId,
        'public_schedule',
        getFixedWeeklyBootstrap(gameId, target)
      )
    : null
  let bootstrapMerge = mapMerge ?? (fixedWeeklyMerge
    ? {
        added: fixedWeeklyMerge.added,
        updated: fixedWeeklyMerge.updated,
        preserved: fixedWeeklyMerge.preserved
      }
    : null)
  try {
    const plugin = detectCodexPlugin()
    const job = appDatabase.createAiScheduleJob(
      gameId,
      queuedJobScope,
      new Date(),
      plugin.installed,
      target,
      requestContext
    )
    if (target === 'all') {
      const mapMerge = maintainBundledMapCatalog(appDatabase, gameId)
      bootstrapMerge = {
        added: (bootstrapMerge?.added ?? 0) + mapMerge.added,
        updated: (bootstrapMerge?.updated ?? 0) + mapMerge.updated,
        preserved: (bootstrapMerge?.preserved ?? 0) + mapMerge.preserved
      }
    }
    const launch = startCodexWorkersForActiveJobs() ?? {
      status: 'unavailable' as const,
      message: 'Codex 自动处理服务尚未初始化',
      started: 0,
      running: 0
    }
    if (launch.status === 'unavailable') {
      appDatabase.failPendingAiScheduleJobs(launch.message)
      throw new Error(launch.message)
    }
    appDatabase.updatePendingAiScheduleJobsMessage(launch.message)
    const activeJob = appDatabase.getActiveAiScheduleJob(gameId, target) ?? job
    sendAiJobProgress(activeJob)
    const publicMessage = `${launch.message}（任务 ${job.id.slice(0, 8)}）`
    const localMessages = [
      fixedWeeklyMerge
        ? `固定周常已维护（新增 ${fixedWeeklyMerge.added}，更新 ${fixedWeeklyMerge.updated}）`
        : '',
      mapMerge
        ? `地图基准目录已维护（新增 ${mapMerge.added}，更新 ${mapMerge.updated}）；${mapAuditReason === 'version_started'
          ? '检测到新版本，正在核验增量'
          : mapAuditReason === 'version_boundary_reached'
            ? '检测到版本边界，正在核验增量'
            : '目录距离上次核验较久，正在核验增量'}`
        : ''
    ].filter(Boolean)
    sources.push({
      source: 'public_schedule',
      status: 'skipped',
      message: `${localMessages.length ? `${localMessages.join('；')}；` : ''}${publicMessage}`,
      ...(bootstrapMerge ?? { added: 0, updated: 0, preserved: 0 })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法创建 AI 资料任务'
    appDatabase.recordSyncTargetAttempt(
      gameId,
      target,
      bootstrapMerge ? 'stale' : 'error'
    )
    sources.push({
      source: 'public_schedule',
      status: bootstrapMerge ? 'success' : 'error',
      message: bootstrapMerge
        ? `本地基础目录已维护（新增 ${bootstrapMerge.added}，更新 ${bootstrapMerge.updated}）；AI 增量校正未能排队：${message}`
        : message,
      ...(bootstrapMerge ?? { added: 0, updated: 0, preserved: 0 })
    })
  }

  if (sources[0]?.status === 'error') {
    appDatabase.recordSyncAttempt(gameId, scope)
    appDatabase.recordSyncOutcome(gameId, 'error', sources[0].message, false)
  }

  const publicStatus = sources[0]?.status
  const finalStatus: SyncResult['status'] = publicStatus === 'error'
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

function handleCodexScheduleWorkerEvent(event: CodexScheduleWorkerEvent): void {
  if (!appDatabase) return
  if (event.phase === 'stopped') {
    const message =
      event.exitCode === 0 && event.message === 'Codex 自动处理进程已结束'
        ? 'Codex 处理进程已结束，未完成任务已重新排队'
        : event.message
    const requeuedJobs = appDatabase.requeueClaimedAiScheduleJobsByAgent(
      event.agentId,
      new Date(),
      message
    )
    const requeuedReviews = appDatabase.requeueClaimedSemanticReviewsByAgent(
      event.agentId,
      message
    )
    const healthyExit =
      event.exitCode === 0 &&
      event.message === 'Codex 自动处理进程已结束' &&
      requeuedJobs === 0 &&
      requeuedReviews === 0
    const hasBacklog =
      appDatabase.listActiveAiScheduleJobs().length +
      appDatabase.getActiveSemanticReviewCount() > 0
    if (healthyExit) codexConcurrency.recordHealthyCompletion(hasBacklog)
    else codexConcurrency.recordBackpressure()
    if (requeuedJobs > 0 || requeuedReviews > 0) {
      mainWindow?.webContents.send('checklist:changed')
    }
    setTimeout(startCodexWorkersForActiveJobs, 0)
    return
  }
  if (event.phase === 'retrying' || event.phase === 'fallback') {
    codexConcurrency.recordBackpressure()
  }
  const runningWorkers = codexScheduleWorkerPool?.runningCount ?? 0
  const message = runningWorkers > 1
    ? `${event.message} · 并行 ${runningWorkers} · 动态目标 ${codexConcurrency.currentLimit}/${codexConcurrency.maximumLimit}`
    : event.message
  const changed = appDatabase.updatePendingAiScheduleJobsMessage(
    message,
    event.current ?? null,
    event.total ?? null
  )
  if (changed > 0) pollAiJobProgress()
}

function startCodexWorkersForActiveJobs():
  | ReturnType<CodexScheduleWorkerPool['ensureCapacity']>
  | null {
  if (!appDatabase || !codexScheduleWorkerPool) return null
  const activeJobs = appDatabase.listActiveAiScheduleJobs().length
  const activeReviews = appDatabase.getActiveSemanticReviewCount()
  const memoryRatio = totalmem() > 0 ? freemem() / totalmem() : 1
  const activeWork = codexConcurrency.desiredWorkers(
    activeJobs,
    activeReviews,
    memoryRatio
  )
  if (activeWork === 0) return null
  const launch = codexScheduleWorkerPool.ensureCapacity(activeWork)
  if (launch.status === 'unavailable') {
    appDatabase.failPendingAiScheduleJobs(launch.message)
    mainWindow?.webContents.send('checklist:changed')
  } else {
    appDatabase.updatePendingAiScheduleJobsMessage(launch.message)
  }
  return launch
}

function toAiJobProgress(job: AiScheduleJob): SyncProgressUpdate {
  return {
    gameId: job.gameId,
    target: job.target,
    source: 'public_schedule',
    phase: job.progressPhase,
    status: job.status === 'pending' ? 'waiting' : 'running',
    message: job.message ?? (job.status === 'pending' ? '正在启动本机 Codex' : 'Codex 正在处理'),
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
  try {
    const maintenance = appDatabase.maintainAiScheduleJobs()
    if (maintenance.requeued > 0 || maintenance.expired > 0) {
      mainWindow?.webContents.send('checklist:changed')
    }
    const jobs = appDatabase.listActiveAiScheduleJobs()
    const activeJobIds = new Set(jobs.map((job) => job.id))
    for (const knownJobId of aiJobProgressSignatures.keys()) {
      if (activeJobIds.has(knownJobId)) continue
      aiJobProgressSignatures.delete(knownJobId)
      mainWindow?.webContents.send('checklist:changed')
    }
    for (const job of jobs) {
      const previousSignature = aiJobProgressSignatures.get(job.id)
      const signature = [
        job.status,
        job.progressPhase,
        job.progressCurrent,
        job.progressTotal,
        job.progressUpdatedAt,
        job.message
      ].join(':')
      if (signature === previousSignature) continue
      aiJobProgressSignatures.set(job.id, signature)
      sendAiJobProgress(job)
    }
  } catch (error) {
    reportBackgroundError('同步任务后台维护', error)
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
  mainWindow.on('closed', () => {
    mainWindow = null
    if (!isShuttingDown) app.quit()
  })

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
    dataPath: appDataRoot ?? app.getPath('documents')
  }))
  ipcMain.handle('app:open-data-directory', async () => {
    const message = await shell.openPath(appDataRoot ?? app.getPath('documents'))
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
    shutdownApplicationRuntime()
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
  ipcMain.handle('ai-schedule:get-active-job', (
    _event,
    gameId: unknown,
    target?: unknown
  ) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.getActiveAiScheduleJob(
      parseGameId(gameId),
      target === undefined ? undefined : parseSyncTarget(target)
    )
  })
  ipcMain.handle('ai-schedule:list-active-jobs', (_event, gameId?: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.listActiveAiScheduleJobs(
      gameId === undefined ? undefined : parseGameId(gameId)
    )
  })
  ipcMain.handle('semantic-review:get-summary', (
    _event,
    gameId: unknown,
    target?: unknown
  ) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    const parsedTarget = target === undefined ? undefined : parseSyncTarget(target)
    if (parsedTarget === 'all' || parsedTarget === 'tasks') {
      throw new Error('语义核验进度只支持活动、周期事项和地图探索版块')
    }
    return appDatabase.getSemanticReviewSummary(parseGameId(gameId), parsedTarget)
  })
  ipcMain.handle('codex-plugin:open', async () => {
    const launcherOptions = codexMcpLauncherOptions()
    const sourcePluginPath = app.isPackaged
      ? join(process.resourcesPath, 'codex-plugin')
      : join(app.getAppPath(), 'integrations', 'gacha-task-manager')
    const prepared = prepareCodexPluginMarketplace({
      ...launcherOptions,
      sourcePluginPath,
      personalMarketplacePath: join(app.getPath('home'), '.agents', 'plugins', 'marketplace.json'),
      personalPluginPath: join(app.getPath('home'), 'plugins', 'gacha-task-manager')
    })
    await shell.openExternal(prepared.deeplink)
  })
  ipcMain.handle('codex-plugin:update', async () => {
    const launcherOptions = codexMcpLauncherOptions()
    const sourcePluginPath = app.isPackaged
      ? join(process.resourcesPath, 'codex-plugin')
      : join(app.getAppPath(), 'integrations', 'gacha-task-manager')
    prepareCodexPluginMarketplace({
      ...launcherOptions,
      sourcePluginPath,
      personalMarketplacePath: join(app.getPath('home'), '.agents', 'plugins', 'marketplace.json'),
      personalPluginPath: join(app.getPath('home'), 'plugins', 'gacha-task-manager')
    })
    const codexCliPath = findCodexCli()
    if (!codexCliPath) throw new Error('未找到 Codex 命令行，请先安装或更新 Codex')
    return installCodexPluginFromPersonalMarketplace(codexCliPath)
  })
  ipcMain.handle(
    'codex-proxy:repair',
    async (_event, mode: CodexConnectionRepairMode): Promise<CodexConnectionRepairResult> => {
      if (!['proxy', 'https'].includes(mode)) throw new Error('Codex 连接修复方式无效')
      if ((appDatabase?.listActiveAiScheduleJobs().length ?? 0) === 0) {
        throw new Error('当前没有需要修复的 Codex 同步任务')
      }
      if (mode === 'proxy') {
        const resolution = await session.defaultSession.resolveProxy(
          'https://chatgpt.com/backend-api/codex'
        )
        const proxyUrl = resolveLoopbackHttpProxy(resolution)
        if (!proxyUrl) {
          throw new Error('系统代理未解析到可安全显式套用的本地端口；可以切换全局/TUN，或继续选择 HTTPS 兼容连接')
        }
        codexWorkerEnvironment = {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          ALL_PROXY: '',
          NO_PROXY: 'localhost,127.0.0.1,::1'
        }
        codexWorkerTransportMode = 'websocket_preferred'
        const message = '已把当前本地代理显式应用到本软件启动的 Codex，正在重新连接'
        restartCodexWorkers(message)
        return { mode, message }
      }

      codexWorkerTransportMode = 'https_compatibility'
      const message = '已关闭本次 Codex 的 Responses WebSocket，正在通过 HTTPS 兼容连接重新同步'
      restartCodexWorkers(message)
      return { mode, message }
    }
  )

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
  ipcMain.handle('checklist:empty-recycle-bin', async (_event, gameId: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    const resolvedGameId = parseGameId(gameId)
    const count = appDatabase.listArchivedChecklistItems(resolvedGameId).length
    if (count === 0) return 0
    const gameName = appDatabase.listGames().find((game) => game.id === resolvedGameId)?.name ?? '当前游戏'
    const confirmationOptions = {
      type: 'warning',
      title: '清空回收站',
      message: `确定永久删除${gameName}回收站中的 ${count} 个事项吗？`,
      detail: '此操作无法撤销。',
      buttons: ['取消', '永久删除'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    } satisfies Electron.MessageBoxOptions
    const confirmation = mainWindow
      ? await dialog.showMessageBox(mainWindow, confirmationOptions)
      : await dialog.showMessageBox(confirmationOptions)
    return confirmation.response === 1 ? appDatabase.emptyRecycleBin(resolvedGameId) : 0
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
  ipcMain.handle('sync:dismiss-initial-guide', (_event, gameId: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.dismissInitialSyncGuide(parseGameId(gameId))
  })
  ipcMain.handle('sync:get-target-states', (_event, gameId: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.getSyncTargetStates(parseGameId(gameId))
  })
  ipcMain.handle('sync:get-personal-targets', (_event, gameId: unknown) =>
    getPersonalSyncTargets(parseGameId(gameId))
  )
  ipcMain.handle('sync:run', async (
    _event,
    gameId: unknown,
    scope: unknown,
    target: unknown = 'all',
    requestContext: unknown
  ) => {
    return await queueAiScheduleSync(
      parseGameId(gameId),
      parseSyncScope(scope),
      parseSyncTarget(target),
      parseSyncRequestContext(requestContext)
    )
  })
  ipcMain.handle('sync:run-personal', async (
    _event,
    gameId: unknown,
    target: unknown = 'all',
    requestContext: unknown
  ) => {
    if (!appDatabase || !syncOrchestrator) throw new Error('个人数据同步服务尚未初始化')
    const parsedGameId = parseGameId(gameId)
    const parsedTarget = parseSyncTarget(target)
    const parsedRequestContext = parseSyncRequestContext(requestContext)
    if (parsedTarget === 'all' || parsedTarget === 'tasks') {
      throw new Error('同步进度只能从活动、周期事项或地图探索版块发起')
    }
    if (!supportsPersonalSyncTarget(parsedGameId, parsedTarget)) {
      throw new Error('当前游戏的个人数据接口不提供该版块进度')
    }
    const result = appDatabase.isCatalogComplete(parsedGameId, parsedTarget)
      ? await syncOrchestrator.syncPersonalOnly(
          parsedGameId,
          parsedTarget,
          parsedRequestContext
        )
      : await queueAiScheduleSync(
          parsedGameId,
          'public_and_personal',
          parsedTarget,
          parsedRequestContext
        )
    if (result.sources.some((source) => (source.pendingReview ?? 0) > 0)) {
      startCodexWorkersForActiveJobs()
    }
    return result
  })
  ipcMain.handle('sync:cancel', (
    _event,
    gameId: unknown,
    target: unknown,
    source: unknown
  ) => {
    if (!appDatabase || !syncOrchestrator) throw new Error('同步服务尚未初始化')
    const parsedGameId = parseGameId(gameId)
    const parsedTarget = parseSyncTarget(target)
    if (source !== 'public_schedule' && source !== 'personal_data') {
      throw new Error('同步取消来源不受支持')
    }

    let cancelled = false
    if (source === 'public_schedule') {
      const result = appDatabase.cancelActiveAiScheduleJob(parsedGameId, parsedTarget)
      if (result?.agentId) codexScheduleWorkerPool?.stopAgent(result.agentId)
      cancelled = Boolean(result)
    } else {
      if (parsedTarget === 'all' || parsedTarget === 'tasks') {
        throw new Error('个人进度取消只支持活动、周期事项和地图探索版块')
      }
      const adapterCancelled = syncOrchestrator.cancelPersonalSync(
        parsedGameId,
        parsedTarget
      )
      const reviews = appDatabase.cancelSemanticReviewCandidates(
        parsedGameId,
        parsedTarget
      )
      for (const agentId of reviews.agentIds) {
        codexScheduleWorkerPool?.stopAgent(agentId)
      }
      cancelled = adapterCancelled || reviews.cancelled > 0
    }

    const message = cancelled ? '已取消' : '当前没有可取消的同步'
    if (cancelled) {
      mainWindow?.webContents.send('sync:progress', {
        gameId: parsedGameId,
        target: parsedTarget,
        source,
        phase: 'cancelled',
        status: 'cancelled',
        message,
        current: null,
        total: null,
        updatedAt: new Date().toISOString()
      } satisfies SyncProgressUpdate)
      mainWindow?.webContents.send('checklist:changed')
      pollAiJobProgress()
      setTimeout(startCodexWorkersForActiveJobs, 0)
    }
    return {
      gameId: parsedGameId,
      target: parsedTarget,
      source,
      cancelled,
      message
    }
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
  ipcMain.handle('kuro-login:send-sms', async (_event, phone: unknown) => {
    if (!kuroCommunityLogin) throw new Error('库街区登录服务尚未初始化')
    const verification = await solveMiyousheGeetest(
      mainWindow,
      {
        gt: KURO_COMMUNITY_CAPTCHA_ID,
        riskType: '',
        sessionId: '',
        version: 4
      },
      {
        title: '库街区安全验证',
        heading: '库街区安全验证',
        description: '请手动完成官方滑块。应用只接收本次验证票据，不保存滑块内容。',
        includeSessionUserInfo: false,
        showMethod: 'showBox'
      }
    )
    if (!verification) throw new Error('已取消库街区安全验证')
    if (verification.version !== 4) throw new Error('库街区安全验证结果格式不正确')
    return await kuroCommunityLogin.sendSms(phone, verification)
  })
  ipcMain.handle(
    'kuro-login:complete',
    async (_event, sessionId: unknown, code: unknown) => {
      if (!kuroCommunityLogin) throw new Error('库街区登录服务尚未初始化')
      return await kuroCommunityLogin.complete(sessionId, code)
    }
  )
  ipcMain.handle(
    'kuro-login:store',
    async (_event, sessionId: unknown, roleId: unknown, serverId: unknown) => {
      if (!kuroCommunityLogin || !credentialVault) {
        throw new Error('库街区登录服务尚未初始化')
      }
      const credential = await kuroCommunityLogin.finish(sessionId, roleId, serverId)
      return credentialVault.store(
        'kuro-community',
        encodeKuroCommunityCredential(credential)
      )
    }
  )
  ipcMain.handle('kuro-login:cancel', (_event, sessionId: unknown) => {
    if (!kuroCommunityLogin) throw new Error('库街区登录服务尚未初始化')
    return kuroCommunityLogin.cancel(sessionId)
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
    const dataPaths = resolveAppDataPaths(app.getPath('documents'))
    const databasePath = dataPaths.database
    const backupDirectory = dataPaths.backups
    appDataRoot = dataPaths.root
    appBackupDirectory = backupDirectory
    appDatabasePath = databasePath
    try {
      await migrateLegacyAppData(app.getPath('userData'), dataPaths)
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
      for (const gameId of SUPPORTED_GAME_IDS) {
        if (appDatabase.isCatalogComplete(gameId, 'exploration')) {
          maintainBundledMapCatalog(appDatabase, gameId, new Date(), false)
        }
      }
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
    kuroCommunityCredential = new KuroCommunityCredentialService(fetcher)
    kuroCommunityLogin = new KuroCommunityLoginService(
      kuroCommunityCredential,
      fetcher
    )
    try {
      await createDailyBackup(appDatabase, backupDirectory)
      pruneDailyBackups(backupDirectory)
    } catch (error) {
      console.error('创建或整理每日数据库备份失败', error)
    }
    try {
      const appMarketplacePath = join(app.getPath('userData'), 'codex-integration', 'marketplace.json')
      if (detectCodexPlugin({ appMarketplacePath }).installed) {
        const launcherOptions = codexMcpLauncherOptions()
        refreshCodexMcpLauncher(launcherOptions)
        const legacyIntegrationDirectory = join(
          app.getPath('appData'),
          'gacha-task-manager',
          'codex-integration'
        )
        if (existsSync(join(legacyIntegrationDirectory, 'launch-gacha-mcp.cmd'))) {
          refreshCodexMcpLauncher({
            ...launcherOptions,
            integrationDirectory: legacyIntegrationDirectory
          })
        }
      }
    } catch (error) {
      console.error('刷新 Codex MCP 启动路径失败', error)
    }
    codexScheduleWorkerPool = createCodexWorkerPool()
    syncOrchestrator = createAppSyncOrchestrator(appDatabase)
    registerIpcHandlers()
    createWindow()
    periodTimer = setInterval(() => {
      try {
        const changes =
          (appDatabase?.resetDueWeeklyItems() ?? 0) +
          (appDatabase?.resetDueQuestItems() ?? 0) +
          (appDatabase?.markStaleSyncStates() ?? 0)
        if (changes > 0) mainWindow?.webContents.send('checklist:changed')
      } catch (error) {
        reportBackgroundError('周期状态后台维护', error)
      }
    }, 60_000)
    let lastDataVersion = appDatabase.getDataVersion()
    externalChangeTimer = setInterval(() => {
      try {
        const currentDataVersion = appDatabase?.getDataVersion() ?? lastDataVersion
        if (currentDataVersion === lastDataVersion) return
        lastDataVersion = currentDataVersion
        mainWindow?.webContents.send('checklist:changed')
      } catch (error) {
        reportBackgroundError('数据库变更检测', error)
      }
    }, 2_000)
    pollAiJobProgress()
    aiJobProgressTimer = setInterval(pollAiJobProgress, 2_000)
    startCodexWorkersForActiveJobs()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  shutdownApplicationRuntime()
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
  const preparePersonalCatalog = (gameId: GameId, target: SyncTarget): void => {
    if (target === 'exploration' || target === 'all') {
      maintainBundledMapCatalog(database, gameId)
    }
  }
  if (!credentialVault) {
    return new SyncOrchestrator(database, undefined, reportProgress, preparePersonalCatalog)
  }
  const fetcher = createElectronNetFetcher(net.fetch)
  return new SyncOrchestrator(database, {
    publicSchedule: {},
    personalData: {
      genshin: new CredentialBackedAdapter(
        'miyoushe',
        credentialVault,
        (credential, onProgress, signal) => createMiyousheGenshinPersonalAdapter(
          credential,
          fetcher,
          (challenge) => solveMiyousheGeetest(
            mainWindow,
            challenge,
            undefined,
            signal
          ),
          onProgress,
          signal
        )
      ),
      'star-rail': new CredentialBackedAdapter(
        'miyoushe',
        credentialVault,
        (credential, onProgress, signal) => createMiyousheStarRailPersonalAdapter(
          credential,
          fetcher,
          (challenge) => solveMiyousheGeetest(
            mainWindow,
            challenge,
            undefined,
            signal
          ),
          onProgress,
          signal
        )
      ),
      zenless: new CredentialBackedAdapter(
        'miyoushe',
        credentialVault,
        (credential, onProgress, signal) => createMiyousheZenlessPersonalAdapter(
          credential,
          fetcher,
          (challenge) => solveMiyousheGeetest(
            mainWindow,
            challenge,
            undefined,
            signal
          ),
          onProgress,
          signal
        )
      ),
      'wuthering-waves': new CredentialBackedAdapter(
        'kuro-community',
        credentialVault,
        (credential, onProgress, signal) => createKuroCommunityPersonalAdapter(
          credential,
          fetcher,
          onProgress,
          signal
        )
      )
    }
  }, reportProgress, preparePersonalCatalog)
}

function maintainBundledMapCatalog(
  database: AppDatabase,
  gameId: GameId,
  reference = new Date(),
  recordSuccess = true
): { added: number; updated: number; preserved: number } {
  const merge = database.mergeSyncedItems(
    gameId,
    'public_schedule',
    getBundledMapCatalog(gameId),
    reference.toISOString(),
    true,
    { identityPolicy: 'remote-key-only' }
  )
  database.recordCatalogCoverage(gameId, 'exploration', 'public_schedule', 'complete')
  if (recordSuccess) database.recordSyncTargetSuccess(gameId, 'exploration', reference)
  return merge
}
