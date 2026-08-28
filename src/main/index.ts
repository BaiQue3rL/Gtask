import { appendFileSync, cpSync, existsSync, mkdirSync } from 'node:fs'
import { arch, cpus, release, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, net, powerMonitor, safeStorage, screen, shell } from 'electron'
import { terminateApplicationProcess } from './application-exit'
import { ApplicationLogger } from './application-logger'
import {
  calculatePortraitWindowSize,
  PORTRAIT_WINDOW_ASPECT_RATIO
} from './window-layout'
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
import {
  CODEX_PLUGIN_REQUIRED_MESSAGE,
  detectCodexPlugin,
  isCodexPluginUsable
} from './ai/codex-plugin'
import {
  hasCodexMcpLauncher,
  prepareStableMcpElectronRuntime,
  refreshCodexMcpLauncher
} from './ai/codex-mcp-runtime'
import {
  MAX_CODEX_SCHEDULE_WORKERS,
  CodexScheduleWorkerPool,
  resolveCodexWorkerRoute,
  selectCodexWorkerRoutes,
  type CodexScheduleWorkerEvent
} from './ai/codex-schedule-worker'
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
import { restoreRelaunchOptions } from './relaunch'
import { readRenderingMode, writeRenderingMode } from './rendering-mode'
import {
  SoftwareUpdateService,
  createDefaultSoftwareUpdateProviders,
  readSoftwareUpdateSettings,
  writeSoftwareUpdateSettings
} from './software-update'
import {
  RemoteCatalogUpdateService,
  createDefaultRemoteCatalogProviders,
  readRemoteCatalogUpdateState,
  writeRemoteCatalogUpdateState,
  type RemoteCatalogUpdateState
} from './remote-catalog-update'
import {
  MANUAL_REMOTE_CATALOG_COOLDOWN_MS,
  automaticRemoteCheckDelay,
  remoteCheckCooldownRemaining
} from './remote-check-cooldown'
import { migrateLegacyAppDataPaths } from './data-paths'
import {
  getBundledMapCatalog
} from './sync/map-catalog'
import {
  getPersonalSyncTargets,
  supportsPersonalSyncTarget
} from './sync/personal-sync-capabilities'
import {
  SUPPORTED_GAME_IDS,
  type AiScheduleJob,
  type GameId,
  type RenderingMode,
  type RenderingModeState,
  type RemoteCatalogCheckResult,
  type RemoteCatalogUpdateStatus,
  type SoftwareUpdateCheckResult,
  type SoftwareUpdateSettings,
  type SoftwareUpdateSource,
  type SyncProgressUpdate
} from '../shared/contracts'
import { projectAiJobProgressPhase } from '../shared/sync-progress'
import {
  parseChecklistSection,
  parseCredentialProvider,
  parseExternalUrl,
  parseCreateChecklistItem,
  parseGameId,
  parseItemId,
  parseSyncRequestContext,
  parseSyncTarget,
  parseUpdateChecklistItem
} from './validation'

// Release screenshots and automated UI checks must never touch the maintainer's
// real Documents data. Packaged builds intentionally ignore this override.
const developmentDocumentsArgument = process.argv.find((argument) =>
  argument.startsWith('--gtask-development-documents-path=')
)
const developmentDocumentsPath = !app.isPackaged
  ? process.env.GTASK_DEVELOPMENT_DOCUMENTS_PATH?.trim() ||
    developmentDocumentsArgument?.slice('--gtask-development-documents-path='.length).trim()
  : undefined
if (developmentDocumentsPath) {
  mkdirSync(developmentDocumentsPath, { recursive: true })
  app.setPath('documents', developmentDocumentsPath)
}

const renderingModeConfigPath = join(app.getPath('userData'), 'rendering-mode.json')
const activeRenderingMode = readRenderingMode(renderingModeConfigPath)
let configuredRenderingMode = activeRenderingMode
const softwareUpdateConfigPath = join(app.getPath('userData'), 'software-update.json')
let softwareUpdateSettings = readSoftwareUpdateSettings(softwareUpdateConfigPath)
const remoteCatalogStatePath = join(app.getPath('userData'), 'remote-catalog-update.json')
let remoteCatalogUpdateState: RemoteCatalogUpdateState = readRemoteCatalogUpdateState(
  remoteCatalogStatePath
)
const BASELINE_WORKER_PREFERENCES = {
  strategy: 'fixed' as const,
  model: 'gpt-5.6-sol' as const,
  reasoningEffort: 'medium' as const
}

// Electron requires this call before app readiness. Compatibility mode is the
// safe default because some Windows GPU/game overlay combinations corrupt
// Chromium compositor frames even though application state remains correct.
if (activeRenderingMode === 'compatibility') app.disableHardwareAcceleration()

function renderingModeState(): RenderingModeState {
  return {
    configured: configuredRenderingMode,
    active: activeRenderingMode,
    restartRequired: configuredRenderingMode !== activeRenderingMode
  }
}

function parseRequestedRenderingMode(value: unknown): RenderingMode {
  if (value === 'compatibility' || value === 'accelerated') return value
  throw new Error('界面渲染模式格式不正确')
}

const SECTION_CATEGORIES = {
  events: ['limited_event'],
  cycles: ['endgame'],
  exploration: ['exploration'],
  custom: ['custom']
} as const

let mainWindow: BrowserWindow | null = null
let appDatabase: AppDatabase | null = null
let syncOrchestrator: SyncOrchestrator | null = null
let periodTimer: ReturnType<typeof setInterval> | null = null
let externalChangeTimer: ReturnType<typeof setInterval> | null = null
let aiJobProgressTimer: ReturnType<typeof setInterval> | null = null
let softwareUpdateTimer: ReturnType<typeof setTimeout> | null = null
let remoteCatalogUpdateTimer: ReturnType<typeof setTimeout> | null = null
const aiJobProgressSignatures = new Map<string, string>()
let codexScheduleWorkerPool: CodexScheduleWorkerPool | null = null
let credentialVault: CredentialVault | null = null
let miyousheQrLogin: MiyousheQrLoginService | null = null
let kuroCommunityCredential: KuroCommunityCredentialService | null = null
let kuroCommunityLogin: KuroCommunityLoginService | null = null
let appBackupDirectory: string | null = null
let appDatabasePath: string | null = null
let appDataRoot: string | null = null
let softwareUpdateService: SoftwareUpdateService | null = null
let remoteCatalogUpdateService: RemoteCatalogUpdateService | null = null
let applicationLogger: ApplicationLogger | null = null
let isShuttingDown = false

function reportBackgroundError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (/database is locked|SQLITE_BUSY/i.test(message)) {
    applicationLogger?.warn('background_database_busy', { context, error })
    console.warn(`${context}暂时遇到数据库占用，稍后自动重试`)
    return
  }
  applicationLogger?.error('background_error', { context, error })
  console.error(`${context}失败`, error)
}

process.on('uncaughtExceptionMonitor', (error, origin) => {
  applicationLogger?.error('uncaught_exception', { origin, error })
})

process.on('unhandledRejection', (reason) => {
  applicationLogger?.error('unhandled_rejection', { reason })
})

function maintainChecklistTimeState(): void {
  if (!appDatabase || isShuttingDown) return
  try {
    // Recurring entries must advance first. Any system time-limited rows left
    // behind are expired one-off entries and are permanently removed.
    const changes =
      appDatabase.rolloverDueCycleItems() +
      appDatabase.rolloverExpiredVersionWindows() +
      appDatabase.pruneExpiredSystemItems() +
      appDatabase.markStaleSyncStates()
    if (changes > 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('checklist:changed')
    }
  } catch (error) {
    reportBackgroundError('清单时间状态后台维护', error)
  }
}

function shutdownApplicationRuntime(): void {
  if (isShuttingDown) return
  isShuttingDown = true
  applicationLogger?.info('application_stopping')
  if (periodTimer) clearInterval(periodTimer)
  periodTimer = null
  if (externalChangeTimer) clearInterval(externalChangeTimer)
  externalChangeTimer = null
  if (aiJobProgressTimer) clearInterval(aiJobProgressTimer)
  aiJobProgressTimer = null
  if (softwareUpdateTimer) clearTimeout(softwareUpdateTimer)
  softwareUpdateTimer = null
  if (remoteCatalogUpdateTimer) clearTimeout(remoteCatalogUpdateTimer)
  remoteCatalogUpdateTimer = null
  if (app.isReady()) {
    powerMonitor.removeListener('resume', maintainChecklistTimeState)
    powerMonitor.removeListener('unlock-screen', maintainChecklistTimeState)
  }
  aiJobProgressSignatures.clear()

  syncOrchestrator?.shutdown()
  miyousheQrLogin?.dispose()
  kuroCommunityLogin?.dispose()
  try {
    appDatabase?.cancelAllActiveAiScheduleJobs()
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

function parseSoftwareUpdatePreferences(
  value: unknown
): Pick<SoftwareUpdateSettings, 'autoCheckEnabled' | 'updateSource'> {
  if (!value || typeof value !== 'object') throw new Error('更新设置格式不正确')
  const record = value as Record<string, unknown>
  const enabled = record.autoCheckEnabled
  if (typeof enabled !== 'boolean') throw new Error('更新设置格式不正确')
  const source = record.updateSource
  if (source !== 'auto' && source !== 'gitee' && source !== 'github') {
    throw new Error('更新来源格式不正确')
  }
  return { autoCheckEnabled: enabled, updateSource: source as SoftwareUpdateSource }
}

function configureSoftwareUpdateService(): void {
  softwareUpdateService = new SoftwareUpdateService(
    app.getVersion(),
    createDefaultSoftwareUpdateProviders({
      feedOverride: process.env.GTASK_UPDATE_FEED_URL,
      mirrorFeedOverride: process.env.GTASK_UPDATE_MIRROR_FEED_URL,
      source: softwareUpdateSettings.updateSource,
      fetcher: net.fetch
    })
  )
  remoteCatalogUpdateService = new RemoteCatalogUpdateService(
    createDefaultRemoteCatalogProviders({
      feedOverride: process.env.GTASK_CATALOG_FEED_URL,
      mirrorFeedOverride: process.env.GTASK_CATALOG_MIRROR_FEED_URL,
      source: softwareUpdateSettings.updateSource,
      fetcher: net.fetch
    })
  )
}

function getRemoteCatalogUpdateStatus(reference = new Date()): RemoteCatalogUpdateStatus {
  const remaining = remoteCheckCooldownRemaining(
    remoteCatalogUpdateState.lastSuccessfulManualCheckAt,
    reference,
    MANUAL_REMOTE_CATALOG_COOLDOWN_MS
  )
  return {
    revision: remoteCatalogUpdateState.revision,
    manualRetryAt: remaining > 0
      ? new Date(reference.getTime() + remaining).toISOString()
      : null
  }
}

async function checkForRemoteCatalogUpdate(automatic: boolean): Promise<RemoteCatalogCheckResult> {
  if (!remoteCatalogUpdateService || !appDatabase) throw new Error('公共清单更新服务尚未初始化')
  const reference = new Date()
  if (!automatic) {
    const status = getRemoteCatalogUpdateStatus(reference)
    if (status.manualRetryAt) {
      return {
        outcome: 'cooldown',
        revision: status.revision,
        checkedAt: reference.toISOString(),
        added: 0,
        updated: 0,
        preserved: 0,
        archived: 0,
        expiredRemoved: 0,
        message: '活动和任务刚检查过',
        manualRetryAt: status.manualRetryAt
      }
    }
  }
  if (automatic) {
    remoteCatalogUpdateState = writeRemoteCatalogUpdateState(remoteCatalogStatePath, {
      ...remoteCatalogUpdateState,
      lastAutomaticCheckAt: reference.toISOString()
    })
  }
  const update = await remoteCatalogUpdateService.check(remoteCatalogUpdateState, reference)
  if (!update) {
    if (!automatic) {
      remoteCatalogUpdateState = writeRemoteCatalogUpdateState(remoteCatalogStatePath, {
        ...remoteCatalogUpdateState,
        lastSuccessfulManualCheckAt: reference.toISOString()
      })
    }
    return {
      outcome: 'up_to_date',
      revision: remoteCatalogUpdateState.revision,
      checkedAt: reference.toISOString(),
      added: 0,
      updated: 0,
      preserved: 0,
      archived: 0,
      expiredRemoved: 0,
      message: '活动和任务已经是最新',
      manualRetryAt: getRemoteCatalogUpdateStatus(reference).manualRetryAt
    }
  }
  if (!appDatabase || isShuttingDown) throw new Error('应用正在退出')
  const merge = appDatabase.applyRemoteCatalogFeed(update.feed)
  remoteCatalogUpdateState = writeRemoteCatalogUpdateState(remoteCatalogStatePath, {
    revision: update.feed.revision,
    publishedAt: update.feed.publishedAt,
    providerId: update.providerId,
    lastAutomaticCheckAt: remoteCatalogUpdateState.lastAutomaticCheckAt,
    lastSuccessfulManualCheckAt: automatic
      ? remoteCatalogUpdateState.lastSuccessfulManualCheckAt
      : reference.toISOString()
  })
  applicationLogger?.info('remote_catalog_updated', {
    revision: update.feed.revision,
    publishedAt: update.feed.publishedAt,
    providerId: update.providerId,
    merge
  })
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('checklist:changed')
  }
  return {
    outcome: 'updated',
    revision: update.feed.revision,
    checkedAt: reference.toISOString(),
    ...merge,
    message: `活动和任务已更新：新增 ${merge.added}，修改 ${merge.updated}，下线 ${merge.archived}`,
    manualRetryAt: getRemoteCatalogUpdateStatus(reference).manualRetryAt
  }
}

async function checkForSoftwareUpdate(automatic: boolean): Promise<SoftwareUpdateCheckResult> {
  if (!softwareUpdateService) throw new Error('更新服务尚未初始化')
  const reference = new Date()
  if (automatic) {
    softwareUpdateSettings = writeSoftwareUpdateSettings(softwareUpdateConfigPath, {
      ...softwareUpdateSettings,
      lastAutomaticCheckAt: reference.toISOString()
    })
  }
  const result = await softwareUpdateService.check(reference)
  if (result.checkedAt) {
    softwareUpdateSettings = writeSoftwareUpdateSettings(softwareUpdateConfigPath, {
      ...softwareUpdateSettings,
      lastSuccessfulCheckAt: result.checkedAt
    })
  }
  if (!automatic || result.outcome !== 'update_available' || !mainWindow || mainWindow.isDestroyed()) {
    return result
  }

  const hasReleaseUrl = Boolean(result.releaseUrl)
  const response = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '发现 Gtask 新版本',
    message: result.message,
    detail: '也可以稍后到设置里再检查。',
    buttons: hasReleaseUrl ? ['稍后', '查看更新'] : ['知道了'],
    defaultId: hasReleaseUrl ? 1 : 0,
    cancelId: 0,
    noLink: true
  })
  if (hasReleaseUrl && response.response === 1) await shell.openExternal(result.releaseUrl!)
  return result
}

function scheduleStartupUpdateCheck(): void {
  if (!softwareUpdateSettings.autoCheckEnabled || softwareUpdateTimer) return
  const delay = automaticRemoteCheckDelay(
    softwareUpdateSettings.lastAutomaticCheckAt,
    new Date(),
    2_000
  )
  softwareUpdateTimer = setTimeout(() => {
    softwareUpdateTimer = null
    void checkForSoftwareUpdate(true).catch((error) => {
      // Automatic checks never interrupt startup or surface transient network errors.
      reportBackgroundError('后台检查更新', error)
    })
  }, delay)
}

function scheduleStartupRemoteCatalogUpdate(): void {
  if (!softwareUpdateSettings.autoCheckEnabled || remoteCatalogUpdateTimer) return
  const delay = automaticRemoteCheckDelay(
    remoteCatalogUpdateState.lastAutomaticCheckAt,
    new Date(),
    750
  )
  remoteCatalogUpdateTimer = setTimeout(() => {
    remoteCatalogUpdateTimer = null
    void checkForRemoteCatalogUpdate(true).catch((error) => {
      // The last valid persistent baseline remains active when every remote
      // source fails or a payload cannot pass validation/transaction checks.
      reportBackgroundError('后台更新公共清单', error)
    })
  }, delay)
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
    databasePath: appDatabasePath ?? join(app.getPath('documents'), 'Gtask', 'data', 'gtask.sqlite'),
    commandShellPath: process.env.ComSpec ??
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
  }
}

function createCodexWorkerPool(): CodexScheduleWorkerPool {
  return new CodexScheduleWorkerPool({
    workingDirectory: app.getPath('userData'),
    env: {},
    transportMode: 'websocket_preferred',
    maxWorkers: MAX_CODEX_SCHEDULE_WORKERS,
    canStartWorkers: () => isCodexPluginUsable(currentCodexPluginStatus()),
    unavailableMessage: CODEX_PLUGIN_REQUIRED_MESSAGE,
    onEvent: handleCodexScheduleWorkerEvent
  })
}

function currentCodexPluginStatus() {
  return detectCodexPlugin({
    appMarketplacePath: join(app.getPath('userData'), 'codex-integration', 'marketplace.json')
  })
}

function handleCodexScheduleWorkerEvent(event: CodexScheduleWorkerEvent): void {
  applicationLogger?.info('codex_worker_event', {
    agentId: event.agentId,
    jobId: event.jobId,
    phase: event.phase,
    current: event.current,
    total: event.total,
    exitCode: event.exitCode,
    timedOut: event.timedOut,
    model: event.model,
    reasoningEffort: event.reasoningEffort,
    message: event.message
  })
  if (!appDatabase) return
  if (
    (event.phase === 'authorization' || event.phase === 'configuration') &&
    event.jobId
  ) {
    const active = appDatabase.listActiveAiScheduleJobs()
      .find((job) => job.id === event.jobId)
    const failed = active?.status === 'claimed' && active.agentId === event.agentId
      ? appDatabase.failAiScheduleJob(event.jobId, event.agentId, event.message)
      : active?.status === 'pending'
        ? appDatabase.failPendingAiScheduleJob(event.jobId, event.message)
        : null
    codexScheduleWorkerPool?.stopAgent(event.agentId)
    if (failed) {
      sendAiJobProgress(failed)
      mainWindow?.webContents.send('checklist:changed')
    }
    setTimeout(startCodexWorkersForActiveJobs, 0)
    return
  }
  if (event.phase === 'timeout' && event.jobId) {
    const before = appDatabase.listActiveAiScheduleJobs()
      .find((job) => job.id === event.jobId)
    const updated = before?.status === 'pending'
      ? appDatabase.recordAiScheduleJobLaunchFailure(
          event.jobId,
          event.agentId,
          {
            model: event.model ?? 'inherit',
            reasoningEffort: event.reasoningEffort ?? 'inherit',
            startedAt: event.startedAt ?? new Date().toISOString()
          },
          'timeout',
          event.message
        )
      : appDatabase.requeueAiScheduleJobAttempt(
          event.jobId,
          event.agentId,
          'timeout',
          event.message
        )
    sendAiJobProgress(updated)
    mainWindow?.webContents.send('checklist:changed')
    setTimeout(startCodexWorkersForActiveJobs, 0)
    return
  }
  if (event.phase === 'stopped') {
    let requeuedJobs = 0
    if (event.jobId) {
      const before = appDatabase.listActiveAiScheduleJobs()
        .find((job) => job.id === event.jobId)
      if (before?.status === 'claimed' && before.agentId === event.agentId) {
        const updated = appDatabase.requeueAiScheduleJobAttempt(
          event.jobId,
          event.agentId,
          'infrastructure_error',
          event.exitCode === 0
            ? 'Codex 进程已结束但没有提交完整结果'
            : event.message
        )
        requeuedJobs = updated.status === 'pending' ? 1 : 0
        sendAiJobProgress(updated)
      } else if (before?.status === 'pending') {
        const updated = appDatabase.recordAiScheduleJobLaunchFailure(
          event.jobId,
          event.agentId,
          {
            model: event.model ?? 'inherit',
            reasoningEffort: event.reasoningEffort ?? 'inherit',
            startedAt: event.startedAt ?? new Date().toISOString()
          },
          'infrastructure_error',
          event.message
        )
        requeuedJobs = updated.status === 'pending' ? 1 : 0
        sendAiJobProgress(updated)
      }
    }
    if (event.jobId || requeuedJobs > 0) {
      mainWindow?.webContents.send('checklist:changed')
    }
    setTimeout(startCodexWorkersForActiveJobs, 0)
    return
  }
  const message = event.message
  const changed = event.jobId
    ? appDatabase.updateAiScheduleJobLaunchMessage(
        event.jobId,
        message,
        event.current ?? null,
        event.total ?? null,
        event.phase === 'retrying' || event.phase === 'fallback'
          ? 'retrying'
          : event.phase === 'connecting'
            ? 'searching'
            : 'queued'
      )
    : 0
  if (changed > 0) pollAiJobProgress()
}

function startCodexWorkersForActiveJobs():
  | ReturnType<CodexScheduleWorkerPool['startJobs']>
  | null {
  if (!appDatabase || !codexScheduleWorkerPool) return null
  const plugin = currentCodexPluginStatus()
  if (!isCodexPluginUsable(plugin)) {
    const activeJobs = appDatabase.listActiveAiScheduleJobs()
    if (activeJobs.length > 0) {
      appDatabase.updatePendingAiScheduleJobsMessage(
        '等待安装或启用 Gtask Codex 同步插件',
        null,
        null
      )
    }
    return {
      status: 'unavailable',
      message: CODEX_PLUGIN_REQUIRED_MESSAGE,
      started: 0,
      running: codexScheduleWorkerPool.runningCount
    }
  }
  const preferences = BASELINE_WORKER_PREFERENCES
  let activeJobs = appDatabase.listActiveAiScheduleJobs()
  const now = Date.now()
  const budgetRemainingByJobId = new Map<string, number>()
  for (const job of activeJobs) {
    const route = resolveCodexWorkerRoute(job, preferences)
    const attemptedRuntimeMs = appDatabase.getAiScheduleJobAttemptRuntimeMs(job.id, new Date(now))
    const remainingMs = route.totalBudgetMs - attemptedRuntimeMs
    if (remainingMs > 0) {
      budgetRemainingByJobId.set(job.id, remainingMs)
      continue
    }
    const expired = appDatabase.expireAiScheduleJob(
      job.id,
      `后台处理已达到总时间预算（${Math.round(route.totalBudgetMs / 60_000)} 分钟），已停止并保留现有数据`
    )
    if (expired.agentId) codexScheduleWorkerPool.stopAgent(expired.agentId)
    sendAiJobProgress(expired.job)
  }
  activeJobs = appDatabase.listActiveAiScheduleJobs()
  const runningRoutes = codexScheduleWorkerPool.runningRoutes
  const routes = selectCodexWorkerRoutes({ jobs: activeJobs, runningRoutes, preferences })
    .map((route) => ({
      ...route,
      timeoutMs: Math.min(
        route.timeoutMs,
        budgetRemainingByJobId.get(route.jobId) ?? route.totalBudgetMs
      )
    }))
  if (routes.length === 0) {
    return {
      status: 'already_running',
      message: codexScheduleWorkerPool.runningCount > 0
        ? '同步任务已排队，完成后会自动继续'
        : '同步任务已排队',
      started: 0,
      running: codexScheduleWorkerPool.runningCount
    }
  }
  const launch = codexScheduleWorkerPool.startJobs(routes)
  return launch
}

function toAiJobProgress(job: AiScheduleJob): SyncProgressUpdate {
  const phase = projectAiJobProgressPhase(job)
  return {
    gameId: job.gameId,
    target: job.target,
    source: job.jobKind === 'public_catalog' ? 'public_schedule' : 'personal_data',
    phase,
    status: job.status === 'pending'
      ? 'waiting'
      : job.status === 'claimed'
        ? 'running'
        : job.status === 'completed'
          ? 'completed'
          : 'error',
    retryKind: phase === 'retrying' ? 'codex_connection' : null,
    // Detailed Agent diagnostics stay in the job record. The renderer receives
    // only structured progress fields and derives its own product copy.
    message: '',
    current: job.progressCurrent,
    total: job.progressTotal,
    updatedAt: job.progressUpdatedAt
  }
}

function sendAiJobProgress(job: AiScheduleJob): void {
  if (job.status === 'pending' || job.status === 'claimed') {
    aiJobProgressSignatures.set(job.id, [
      job.status,
      job.progressPhase,
      job.progressCurrent,
      job.progressTotal,
      job.progressUpdatedAt,
      job.message
    ].join(':'))
  } else {
    aiJobProgressSignatures.delete(job.id)
  }
  mainWindow?.webContents.send('sync:progress', toAiJobProgress(job))
}

function isCancelledAiJob(job: AiScheduleJob): boolean {
  return job.status === 'failed' && Boolean(job.message?.includes('取消'))
}

function pollAiJobProgress(): void {
  if (!appDatabase) return
  try {
    const maintenance = appDatabase.maintainAiScheduleJobs()
    if (maintenance.requeued > 0 || maintenance.expired > 0) {
      mainWindow?.webContents.send('checklist:changed')
      if (maintenance.requeued > 0) setTimeout(startCodexWorkersForActiveJobs, 0)
    }
    const jobs = appDatabase.listActiveAiScheduleJobs()
    if (jobs.some((job) => job.status === 'pending')) {
      setTimeout(startCodexWorkersForActiveJobs, 0)
    }
    const activeJobIds = new Set(jobs.map((job) => job.id))
    for (const knownJobId of aiJobProgressSignatures.keys()) {
      if (activeJobIds.has(knownJobId)) continue
      const terminalJob = appDatabase.getAiScheduleJobById(knownJobId)
      aiJobProgressSignatures.delete(knownJobId)
      if (
        (terminalJob.status === 'completed' || terminalJob.status === 'failed') &&
        !isCancelledAiJob(terminalJob)
      ) {
        sendAiJobProgress(terminalJob)
      }
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
  const portraitSize = calculatePortraitWindowSize(screen.getPrimaryDisplay().workAreaSize)
  mainWindow = new BrowserWindow({
    width: portraitSize.width,
    height: portraitSize.height,
    minWidth: portraitSize.minWidth,
    minHeight: portraitSize.minHeight,
    maximizable: false,
    fullscreenable: false,
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

  mainWindow.setAspectRatio(PORTRAIT_WINDOW_ASPECT_RATIO)
  mainWindow.center()

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('focus', maintainChecklistTimeState)
  mainWindow.on('close', () => {
    shutdownApplicationRuntime()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    // Runtime resources were closed synchronously in the close handler. On Windows,
    // Electron's graceful exit can still leave a headless UI thread and lock the app
    // directory, so the final process boundary must be deterministic.
    terminateApplicationProcess(0)
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
    scheduleStartupUpdateCheck()
    scheduleStartupRemoteCatalogUpdate()
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    applicationLogger?.error('renderer_process_gone', details)
  })
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    applicationLogger?.error('preload_error', { preloadPath, error })
  })
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    applicationLogger?.error('renderer_load_failed', {
      errorCode,
      errorDescription,
      validatedUrl
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
  ipcMain.handle('rendering:get-mode', () => renderingModeState())
  ipcMain.handle('rendering:update-mode', (_event, value: unknown) => {
    configuredRenderingMode = writeRenderingMode(
      renderingModeConfigPath,
      parseRequestedRenderingMode(value)
    )
    return renderingModeState()
  })
  ipcMain.handle('software-update:get-settings', () => softwareUpdateSettings)
  ipcMain.handle('software-update:update-settings', (_event, value: unknown) => {
    const preferences = parseSoftwareUpdatePreferences(value)
    softwareUpdateSettings = writeSoftwareUpdateSettings(softwareUpdateConfigPath, {
      ...softwareUpdateSettings,
      ...preferences
    })
    configureSoftwareUpdateService()
    if (softwareUpdateTimer) clearTimeout(softwareUpdateTimer)
    softwareUpdateTimer = null
    if (remoteCatalogUpdateTimer) clearTimeout(remoteCatalogUpdateTimer)
    remoteCatalogUpdateTimer = null
    scheduleStartupUpdateCheck()
    scheduleStartupRemoteCatalogUpdate()
    return softwareUpdateSettings
  })
  ipcMain.handle('software-update:check', () => checkForSoftwareUpdate(false))
  ipcMain.handle('remote-catalog:get-status', () => getRemoteCatalogUpdateStatus())
  ipcMain.handle('remote-catalog:check', () => checkForRemoteCatalogUpdate(false))
  ipcMain.handle('app:restart', () => {
    setTimeout(() => {
      app.relaunch()
      app.quit()
    }, 100)
    return true
  })
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
      detail: '恢复前会先自动备份当前数据，完成后 Gtask 会重新启动。',
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
  ipcMain.handle('games:list', () => appDatabase?.listGames() ?? [])
  ipcMain.handle('games:list-version-summaries', () =>
    appDatabase?.listGameVersionSummaries() ?? []
  )
  ipcMain.handle('checklist:list', (_event, gameId: unknown) =>
    appDatabase?.listChecklistItems(parseGameId(gameId)) ?? []
  )
  ipcMain.handle('checklist:list-archived', (_event, gameId: unknown) =>
    appDatabase?.listArchivedChecklistItems(parseGameId(gameId)) ?? []
  )
  ipcMain.handle('checklist:create', (_event, input: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    const parsed = parseCreateChecklistItem(input)
    if (parsed.category !== 'custom') throw new Error('这里只能添加自定义事项')
    return appDatabase.createChecklistItem(parsed)
  })
  ipcMain.handle('checklist:update', (_event, input: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    const parsed = parseUpdateChecklistItem(input)
    const current = appDatabase.getChecklistItem(parsed.id)
    if (current.category !== 'custom' || (parsed.category && parsed.category !== 'custom')) {
      throw new Error('这里只能编辑自定义事项')
    }
    return appDatabase.updateChecklistItem(parsed)
  })
  ipcMain.handle('checklist:set-completion', (_event, id: unknown, completed: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    if (typeof completed !== 'boolean') throw new Error('完成状态格式不正确')
    return appDatabase.setChecklistCompletion(parseItemId(id), completed)
  })
  ipcMain.handle('checklist:archive', (_event, id: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    const itemId = parseItemId(id)
    if (appDatabase.getChecklistItem(itemId).category !== 'custom') {
      throw new Error('内置事项不能删除')
    }
    appDatabase.archiveChecklistItem(itemId)
  })
  ipcMain.handle('checklist:restore', (_event, id: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.restoreChecklistItem(parseItemId(id))
  })
  ipcMain.handle('checklist:empty-recycle-bin', (_event, gameId: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    const resolvedGameId = parseGameId(gameId)
    const count = appDatabase.listArchivedChecklistItems(resolvedGameId).length
    if (count === 0) return 0
    return appDatabase.emptyRecycleBin(resolvedGameId)
  })
  ipcMain.handle('checklist:archive-completed-section', (_event, input: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    if (typeof input !== 'object' || input === null) throw new Error('批量删除参数格式不正确')
    const value = input as Record<string, unknown>
    const gameId = parseGameId(value.gameId)
    const section = parseChecklistSection(value.section)
    if (section !== 'custom') throw new Error('内置事项不能批量删除')
    return appDatabase.archiveCompletedSection(gameId, [...SECTION_CATEGORIES[section]])
  })
  ipcMain.handle('sync:get-settings', (_event, gameId: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.getSyncSettings(parseGameId(gameId))
  })
  ipcMain.handle('sync:update-settings', (_event, gameId: unknown, settings: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    if (!settings || typeof settings !== 'object') throw new Error('同步设置格式不正确')
    const autoSyncEnabled = (settings as Record<string, unknown>).autoSyncEnabled
    if (typeof autoSyncEnabled !== 'boolean') throw new Error('同步设置格式不正确')
    return appDatabase.updateSyncSettings(parseGameId(gameId), { autoSyncEnabled })
  })
  ipcMain.handle('sync:get-target-states', (_event, gameId: unknown) => {
    if (!appDatabase) throw new Error('数据库尚未初始化')
    return appDatabase.getSyncTargetStates(parseGameId(gameId))
  })
  ipcMain.handle('sync:get-personal-targets', (_event, gameId: unknown) =>
    getPersonalSyncTargets(parseGameId(gameId))
  )
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
      throw new Error('同步个人数据只能从活动、周期或地图版块发起')
    }
    if (!supportsPersonalSyncTarget(parsedGameId, parsedTarget)) {
      throw new Error('这个游戏暂时不能同步这个版块的进度')
    }
    const publicJob = appDatabase.listActiveAiScheduleJobs(parsedGameId).find((job) =>
      job.jobKind === 'public_catalog' &&
      (job.target === parsedTarget || job.target === 'all')
    )
    if (publicJob) {
      throw new Error('这个版块正在后台更新，请稍后再同步进度')
    }
    const result = await syncOrchestrator.syncPersonalOnly(
      parsedGameId,
      parsedTarget,
      parsedRequestContext
    )
    return result
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
        description: '请完成官方滑块验证。Gtask 只会接收这次验证结果，不会保存滑块内容。',
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
    let dataPaths
    const documentsPath = app.getPath('documents')
    try {
      dataPaths = migrateLegacyAppDataPaths(documentsPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : '本地数据目录迁移失败'
      try {
        mkdirSync(app.getPath('userData'), { recursive: true })
        appendFileSync(
          join(app.getPath('userData'), 'migration-error.log'),
          `${JSON.stringify({ timestamp: new Date().toISOString(), documentsPath, message })}\n`,
          'utf8'
        )
      } catch {
        // The error dialog remains the final fallback when even userData is unavailable.
      }
      dialog.showErrorBox(
        '无法安全迁移本地数据',
        message
      )
      app.quit()
      return
    }
    const databasePath = dataPaths.database
    const backupDirectory = dataPaths.backups
    try {
      applicationLogger = new ApplicationLogger(dataPaths.logs)
      const primaryDisplay = screen.getPrimaryDisplay()
      applicationLogger.info('application_started', {
        appVersion: app.getVersion(),
        packaged: app.isPackaged,
        runtime: {
          electron: process.versions.electron,
          chromium: process.versions.chrome,
          node: process.versions.node
        },
        system: {
          platform: process.platform,
          release: release(),
          architecture: arch(),
          logicalProcessorCount: cpus().length,
          totalMemoryMiB: Math.round(totalmem() / 1024 / 1024),
          locale: app.getLocale(),
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        },
        display: {
          width: primaryDisplay.size.width,
          height: primaryDisplay.size.height,
          workAreaWidth: primaryDisplay.workAreaSize.width,
          workAreaHeight: primaryDisplay.workAreaSize.height,
          scaleFactor: primaryDisplay.scaleFactor,
          colorDepth: primaryDisplay.colorDepth
        },
        renderingMode: activeRenderingMode
      })
    } catch (error) {
      // A damaged or unavailable log directory must not prevent the app from opening.
      console.error('初始化本地日志失败', error)
    }
    appDataRoot = dataPaths.root
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
      for (const gameId of SUPPORTED_GAME_IDS) {
        const explorationState = appDatabase.getSyncTargetStates(gameId).find(
          (state) => state.target === 'exploration'
        )
        if (
          explorationState?.catalogCoverage === 'complete' &&
          explorationState.catalogSource === 'public_schedule'
        ) {
          maintainBundledMapCatalog(appDatabase, gameId, new Date(), {
            recordSuccess: false,
            preserveActiveSourceState: true
          })
          appDatabase.recoverInterruptedPublicCatalogMaintenance(gameId, 'exploration')
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
    configureSoftwareUpdateService()
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
      applicationLogger?.error('daily_backup_failed', { error })
      console.error('创建或整理每日数据库备份失败', error)
    }
    try {
      const integrationDirectory = join(app.getPath('userData'), 'codex-integration')
      if (currentCodexPluginStatus().installed || hasCodexMcpLauncher(integrationDirectory)) {
        const launcherOptions = codexMcpLauncherOptions()
        refreshCodexMcpLauncher(launcherOptions)
      }
    } catch (error) {
      applicationLogger?.error('codex_launcher_refresh_failed', { error })
      console.error('刷新 Codex MCP 启动路径失败', error)
    }
    codexScheduleWorkerPool = createCodexWorkerPool()
    syncOrchestrator = createAppSyncOrchestrator(appDatabase)
    registerIpcHandlers()
    createWindow()
    powerMonitor.on('resume', maintainChecklistTimeState)
    powerMonitor.on('unlock-screen', maintainChecklistTimeState)
    periodTimer = setInterval(maintainChecklistTimeState, 15_000)
    let lastDataVersion = appDatabase.getDataVersion()
    let lastChecklistRevision = appDatabase.getChecklistRevision()
    externalChangeTimer = setInterval(() => {
      try {
        const currentDataVersion = appDatabase?.getDataVersion() ?? lastDataVersion
        if (currentDataVersion === lastDataVersion) return
        lastDataVersion = currentDataVersion
        const currentChecklistRevision = appDatabase?.getChecklistRevision() ?? lastChecklistRevision
        if (currentChecklistRevision === lastChecklistRevision) return
        lastChecklistRevision = currentChecklistRevision
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
  shutdownApplicationRuntime()
  terminateApplicationProcess(0)
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
    applicationLogger?.info('sync_progress', {
      gameId: progress.gameId,
      target: progress.target,
      source: progress.source,
      phase: progress.phase,
      status: progress.status,
      retryKind: progress.retryKind,
      current: progress.current,
      total: progress.total,
      message: progress.message
    })
    // Keep adapter diagnostics in the local log while the product UI derives
    // its wording from source/target/phase/count.
    mainWindow?.webContents.send('sync:progress', { ...progress, message: '' })
  }
  if (!credentialVault) {
    return new SyncOrchestrator(database, undefined, reportProgress)
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
  }, reportProgress)
}

function maintainBundledMapCatalog(
  database: AppDatabase,
  gameId: GameId,
  reference = new Date(),
  options: {
    recordSuccess?: boolean
    preserveActiveSourceState?: boolean
  } = {}
): { added: number; updated: number; preserved: number } {
  const { recordSuccess = true, preserveActiveSourceState = false } = options
  const merge = database.replacePublicCatalog(
    gameId,
    'exploration',
    getBundledMapCatalog(gameId),
    reference.toISOString(),
    { identityPolicy: 'remote-key-only', preserveActiveSourceState }
  )
  database.recordCatalogCoverage(gameId, 'exploration', 'public_schedule', 'complete')
  if (recordSuccess) database.recordSyncTargetSuccess(gameId, 'exploration', reference)
  return merge
}
