<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type {
  AiScheduleAgentStatus,
  AiScheduleJob,
  AppInfo,
  BackupSummary,
  ChecklistCategory,
  ChecklistItem,
  ChecklistSection,
  CodexWorkerPreferences,
  CreateChecklistItemInput,
  CredentialProvider,
  CredentialStatus,
  GameId,
  GameSummary,
  GameVersionSummary,
  KuroCommunityRole,
  MiyousheQrLoginState,
  PersonalSyncTarget,
  RenderingMode,
  RenderingModeState,
  SoftwareUpdateCheckResult,
  SoftwareUpdateSettings,
  SyncResult,
  SyncProgressUpdate,
  SyncScope,
  SyncTarget,
  SyncTargetState,
  SyncSettings
} from '../../shared/contracts'
import { projectAiJobProgressPhase } from '../../shared/sync-progress'
import { readHiddenGameIds, writeHiddenGameIds } from './game-visibility'
import {
  formatGameVersionRemaining,
  gameVersionDeadlineTone,
  isGameVersionDeadlineUrgent,
  orderGamesByVersion
} from './game-navigation'
import { kuroRoleKey } from './kuro-role-key'
import { compareChecklistItems } from './checklist-sort'
import {
  DEFAULT_PANEL_ORDER,
  movePanelSection,
  normalizePanelOrder,
  panelDragWheelDelta,
  readPanelOrders,
  writePanelOrder,
  type PanelDropPosition
} from './panel-order'
import {
  globalSyncSourceLabel,
  orderPersonalSyncTargets,
  selectGuardedGlobalPublicTargets,
  summarizeGlobalSyncState,
  waitForPersonalSyncCooldown
} from './global-sync'
import {
  buildMapTreeRows,
  collectMapBranchKeys,
  type ChecklistTreeRow
} from './map-tree'
import { filterChecklistPanels } from './panel-visibility'
import {
  CODEX_PROXY_REPAIR_PROMPT,
  CODEX_PROXY_WARNING,
  isCodexConnectionRetry
} from './codex-proxy-diagnostic'
import { toCodexWorkerPreferencesIpcPayload } from './codex-worker-preferences'
import {
  applyPersonalProgressUpdate,
  isTerminalPersonalProgress,
  mergeLiveSyncProgresses,
  personalProgressKey,
  reconcilePersonalProgressForGame
} from './personal-sync-progress'
import { credentialProviderForSyncResult } from './sync-credential-notice'
import {
  userFacingProgressMessage,
  userFacingSyncNotice
} from './sync-display-copy'
import {
  claimInitialSyncSetup,
  resolveInitialSyncSetupStep,
  type InitialSyncSource,
  type PendingInitialSyncSetup
} from './initial-onboarding'
import genshinIcon from './assets/games/genshin.jpg'
import starRailIcon from './assets/games/star-rail.jpg'
import zenlessIcon from './assets/games/zenless.jpg'
import wutheringWavesIcon from './assets/games/wuthering-waves.jpg'
import appIcon from '../../../build/brand-mark.svg'

interface ChecklistPanel {
  title: string
  section: ChecklistSection
  categories: ChecklistCategory[]
  defaultCategory: ChecklistCategory
  allowCreate?: boolean
  allowClear?: boolean
  createLabel?: string
  syncTarget?: Exclude<SyncTarget, 'all'>
}

const panels: ChecklistPanel[] = [
  { title: '任务', section: 'tasks', categories: ['main_quest', 'side_quest'], defaultCategory: 'side_quest', allowCreate: false, allowClear: false, syncTarget: 'tasks' },
  { title: '活动', section: 'events', categories: ['limited_event'], defaultCategory: 'limited_event', syncTarget: 'events', allowClear: false },
  { title: '周期事项', section: 'cycles', categories: ['weekly', 'endgame'], defaultCategory: 'endgame', syncTarget: 'cycles', allowClear: false },
  { title: '地图探索', section: 'exploration', categories: ['exploration'], defaultCategory: 'exploration', syncTarget: 'exploration', allowClear: false },
  { title: '自定义清单', section: 'custom', categories: ['custom'], defaultCategory: 'custom', createLabel: '自定义事项', allowClear: true }
]
const personalReviewTargets: PersonalSyncTarget[] = ['events', 'cycles', 'exploration']
const panelBySection = new Map(panels.map((panel) => [panel.section, panel]))

const workspaceElement = ref<HTMLElement | null>(null)

const categoryLabels: Record<ChecklistCategory, string> = {
  main_quest: '主线任务',
  side_quest: '支线任务',
  limited_event: '限时活动',
  weekly: '周常',
  endgame: '深渊/挑战模式',
  exploration: '地图探索',
  custom: '自定义事项'
}

const weekdayLabels: Record<number, string> = {
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
  7: '周日'
}

const gameEditorExamples: Record<GameId, {
  titles: Record<ChecklistCategory, string>
  parentTitle: string
  modeKey: string
  resetRule: string
}> = {
  genshin: {
    titles: {
      main_quest: '例如：主线任务', side_quest: '例如：支线任务', limited_event: '例如：砺行修远',
      weekly: '例如：周常', endgame: '例如：深境螺旋',
      exploration: '例如：枫丹廷区', custom: '例如：刷角色突破素材'
    },
    parentTitle: '例如：枫丹',
    modeKey: '例如：深境螺旋 / 幻想真境剧诗',
    resetRule: '例如：本期结束时间以游戏内为准'
  },
  'star-rail': {
    titles: {
      main_quest: '例如：开拓任务', side_quest: '例如：冒险任务', limited_event: '例如：折纸小鸟对对碰',
      weekly: '例如：周常', endgame: '例如：混沌回忆',
      exploration: '例如：黄金的时刻', custom: '例如：刷行迹材料'
    },
    parentTitle: '例如：匹诺康尼',
    modeKey: '例如：混沌回忆 / 虚构叙事',
    resetRule: '例如：本期名称与结束时间以游戏内为准'
  },
  zenless: {
    titles: {
      main_quest: '例如：主线任务', side_quest: '例如：代理人秘闻', limited_event: '例如：嗯呢从天降',
      weekly: '例如：周常', endgame: '例如：式舆防卫战',
      exploration: '例如：六分街', custom: '例如：刷驱动盘'
    },
    parentTitle: '例如：新艾利都',
    modeKey: '例如：式舆防卫战 / 危局强袭战',
    resetRule: '例如：本期结束时间以游戏内为准'
  },
  'wuthering-waves': {
    titles: {
      main_quest: '例如：潮汐任务', side_quest: '例如：危行任务', limited_event: '例如：限时活动',
      weekly: '例如：周常', endgame: '例如：逆境深塔',
      exploration: '例如：乘霄山', custom: '例如：刷声骸'
    },
    parentTitle: '例如：瑝珑',
    modeKey: '例如：逆境深塔 / 冥歌海墟',
    resetRule: '例如：本期结束时间以游戏内为准'
  }
}

const games = ref<GameSummary[]>([])
const gameVersionSummaries = ref<GameVersionSummary[]>([])
const gameIcons: Record<GameId, string> = {
  genshin: genshinIcon,
  'star-rail': starRailIcon,
  zenless: zenlessIcon,
  'wuthering-waves': wutheringWavesIcon
}
const hiddenGameIds = ref<GameId[]>(readHiddenGameIds(window.localStorage))
const panelOrders = ref(readPanelOrders(window.localStorage))
const items = ref<ChecklistItem[]>([])
const archivedItems = ref<ChecklistItem[]>([])
const appInfo = ref<AppInfo | null>(null)
const loading = ref(true)
const restoringGameView = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const selectedGameId = ref<GameId>('genshin')
const draggingPanelSection = ref<ChecklistSection | null>(null)
const panelDropTarget = ref<{ section: ChecklistSection; position: PanelDropPosition } | null>(null)
let panelDragPointerId: number | null = null
let panelDragHandle: HTMLElement | null = null
const panelDragPoint = ref<{ x: number; y: number } | null>(null)
const showIncompleteOnly = ref(false)
const activityTagFilter = ref('')
const activityTagMenuOpen = ref(false)
const sectionSyncMenuOpen = ref<ChecklistSection | null>(null)
const globalSyncMenuOpen = ref(false)
const globalPersonalSyncBusy = ref(false)
const globalPublicSyncBusy = ref(false)
const pendingPublicSourceSwitch = ref<PersonalSyncTarget | null>(null)
const collapsedMapKeys = ref(new Set<string>())
const collapsedMapKeysByGame = new Map<GameId, Set<string>>()
const knownMapBranchKeysByGame = new Map<GameId, Set<string>>()
const checklistScrollByGame = new Map<GameId, ChecklistScrollSnapshot>()
const activeSyncRequests = ref(new Set<string>())
const syncSettings = ref<SyncSettings | null>(null)
const syncTargetStates = ref<SyncTargetState[]>([])
const personalSyncTargets = ref<PersonalSyncTarget[]>([])
const syncNotice = ref<{
  status: SyncResult['status']
  message: string
  credentialProvider?: CredentialProvider | null
} | null>(null)
const clockNow = ref(Date.now())
const editorOpen = ref(false)
const recycleBinOpen = ref(false)
const settingsOpen = ref(false)
const miyousheLoginOpen = ref(false)
const miyousheLoginState = ref<MiyousheQrLoginState | null>(null)
const startingMiyousheLogin = ref(false)
const pollingMiyousheLogin = ref(false)
const kuroCredentialOpen = ref(false)
const kuroLoginPhone = ref('')
const kuroLoginCode = ref('')
const kuroLoginSessionId = ref('')
const kuroLoginPhase = ref<'phone' | 'code' | 'role'>('phone')
const kuroCredentialRoles = ref<KuroCommunityRole[]>([])
const kuroSelectedRoleKey = ref('')
const kuroCredentialBusy = ref(false)
const kuroCredentialMessage = ref('')
const credentialStatuses = ref<CredentialStatus[]>([])
const backups = ref<BackupSummary[]>([])
const backingUp = ref(false)
const restoringBackup = ref<string | null>(null)
const aiScheduleAgent = ref<AiScheduleAgentStatus | null>(null)
const activeAiJob = ref<AiScheduleJob | null>(null)
const activeAiJobs = ref<AiScheduleJob[]>([])
const personalSyncProgressByKey = ref<Record<string, SyncProgressUpdate>>({})
const cancellingSyncKeys = ref(new Set<string>())
const editingItem = ref<ChecklistItem | null>(null)
const dismissedCodexProxyJobId = ref('')
const codexProxyPromptCopied = ref(false)
const codexRepairStage = ref<'none' | 'proxy_applied' | 'https_applied'>('none')
const codexRepairBusy = ref(false)
const codexPluginBusy = ref(false)
const codexPluginMessage = ref('')
const codexSetupPromptOpen = ref(false)
const codexWorkerPreferences = ref<CodexWorkerPreferences>({
  strategy: 'fixed',
  model: 'gpt-5.6-sol',
  reasoningEffort: 'medium'
})
const codexWorkerPreferencesBusy = ref(false)
const codexWorkerPreferencesMessage = ref('')
const renderingModeState = ref<RenderingModeState | null>(null)
const renderingModeSelection = ref<RenderingMode>('compatibility')
const renderingModeBusy = ref(false)
const renderingModeMessage = ref('')
const softwareUpdateSettings = ref<SoftwareUpdateSettings>({
  autoCheckEnabled: true,
  lastSuccessfulCheckAt: null
})
const softwareUpdateBusy = ref(false)
const softwareUpdateMessage = ref('')
const onboardingBusy = ref(false)
const pendingInitialSyncSetup = ref<PendingInitialSyncSetup | null>(null)
const initialSyncContinuationBusy = ref(false)
let miyousheLoginTimer: number | null = null

const form = reactive({
  category: 'custom' as ChecklistCategory,
  title: '',
  activityTags: '',
  progressPercent: null as number | null,
  parentTitle: '',
  startsAt: '',
  endsAt: '',
  resetRule: '',
  resetWeekday: 1,
  modeKey: '',
})

const selectedGame = computed(() => games.value.find((game) => game.id === selectedGameId.value))
const orderedPanels = computed(() => {
  const order = normalizePanelOrder(panelOrders.value[selectedGameId.value] ?? DEFAULT_PANEL_ORDER)
  return order
    .map((section) => panelBySection.get(section))
    .filter((panel): panel is ChecklistPanel => Boolean(panel))
})
const draggingPanel = computed(() => (
  draggingPanelSection.value ? panelBySection.get(draggingPanelSection.value) ?? null : null
))
const panelDragPreviewStyle = computed(() => {
  const point = panelDragPoint.value
  if (!point) return undefined
  const width = 260
  const height = 62
  const gap = 16
  const x = point.x + gap + width <= window.innerWidth - 10
    ? point.x + gap
    : Math.max(10, point.x - width - gap)
  const y = point.y + gap + height <= window.innerHeight - 10
    ? point.y + gap
    : Math.max(10, point.y - height - gap)
  return { transform: `translate3d(${x}px, ${y}px, 0)` }
})
const panelOrderIsDefault = computed(() =>
  currentPanelOrder().every((section, index) => section === DEFAULT_PANEL_ORDER[index])
)
const editorExamples = computed(() => gameEditorExamples[selectedGameId.value])
const orderedGames = computed(() => orderGamesByVersion(
  games.value,
  gameVersionSummaries.value,
  clockNow.value
))
const visibleGames = computed(() => orderedGames.value.filter(
  (game) => !hiddenGameIds.value.includes(game.id)
))
const gameCredentialStatuses = computed(() => credentialStatuses.value)
const aiScheduleAvailable = computed(() =>
  aiScheduleAgent.value?.codexPluginInstalled === true
)
const publicSyncProgresses = computed<SyncProgressUpdate[]>(() =>
  activeAiJobs.value.map((job) => ({
    gameId: job.gameId,
    target: job.target,
    source: job.jobKind === 'public_catalog' ? 'public_schedule' : 'personal_data',
    phase: projectAiJobProgressPhase(job),
    status: job.status === 'pending' ? 'waiting' : 'running',
    retryKind: job.progressPhase === 'retrying' ? 'codex_connection' : null,
    message: '',
    current: job.progressCurrent,
    total: job.progressTotal,
    updatedAt: job.progressUpdatedAt
  }))
)
const publicSyncProgress = computed<SyncProgressUpdate | null>(() =>
  publicSyncProgresses.value.find((progress) => progress.source === 'public_schedule') ?? null
)
const codexSyncProgress = computed<SyncProgressUpdate | null>(() =>
  publicSyncProgresses.value.find((progress) => progress.gameId === selectedGameId.value) ?? null
)
const liveSyncProgress = computed(() =>
  mergeLiveSyncProgresses(
    publicSyncProgresses.value,
    Object.values(personalSyncProgressByKey.value)
  ).filter(
    (progress): progress is SyncProgressUpdate =>
      Boolean(
        progress &&
        progress.gameId === selectedGameId.value &&
        ['waiting', 'running', 'verification_required'].includes(progress.status)
      )
  )
)
const showCodexProxyWarning = computed(() =>
  isCodexConnectionRetry(codexSyncProgress.value) &&
  Boolean(activeAiJob.value?.id) &&
  dismissedCodexProxyJobId.value !== activeAiJob.value?.id
)
watch(() => activeAiJob.value?.id, (jobId, previousJobId) => {
  if (jobId === previousJobId) return
  codexRepairStage.value = 'none'
  dismissedCodexProxyJobId.value = ''
})
const hasActivePublicSync = computed(() =>
  activeAiJobs.value.some((job) =>
    job.gameId === selectedGameId.value && job.jobKind === 'public_catalog'
  )
)
const syncing = computed(() =>
  [...activeSyncRequests.value].some((key) => key.startsWith(`${selectedGameId.value}:`))
)

function syncResultNotice(result: SyncResult): ReturnType<typeof userFacingSyncNotice> {
  return userFacingSyncNotice({
    status: result.status,
    credentialProvider: credentialProviderForSyncResult(result),
    needsRetry: result.sources.some((source) => source.status === 'error')
  })
}

const editorCategories = computed(() => {
  const questCategories: ChecklistCategory[] = ['main_quest', 'side_quest']
  if (editingItem.value && questCategories.includes(editingItem.value.category)) {
    return [[editingItem.value.category, categoryLabels[editingItem.value.category]]] as Array<[
      ChecklistCategory,
      string
    ]>
  }
  return (Object.entries(categoryLabels) as Array<[ChecklistCategory, string]>).filter(
    ([category]) => !questCategories.includes(category)
  )
})
const personalPlatform = computed(() =>
  selectedGameId.value === 'wuthering-waves' ? '库街区' : '米游社'
)
const syncNoticeCredentialProvider = computed<CredentialProvider | null>(() => {
  return syncNotice.value?.credentialProvider ?? null
})
const incompleteCount = computed(() => items.value.filter((item) => !item.completed).length)
const globalSyncState = computed(() => summarizeGlobalSyncState(syncTargetStates.value))
const globalSourceLabel = computed(() => globalSyncSourceLabel(syncTargetStates.value))
const pendingPublicSourceSwitchLabel = computed(() =>
  pendingPublicSourceSwitch.value === 'events'
    ? '活动'
    : pendingPublicSourceSwitch.value === 'cycles'
      ? '周期事项'
      : '地图探索'
)
const hasEstablishedCatalog = computed(() => items.value.some((item) =>
  !['main_quest', 'side_quest', 'custom'].includes(item.category)
))
const needsInitialSync = computed(() =>
  !syncSettings.value?.initialGuideDismissed &&
  !hasEstablishedCatalog.value &&
  !globalSyncState.value?.lastSuccessAt
)
const codexSetupDescription = computed(() => {
  const setup = pendingInitialSyncSetup.value
  if (setup?.source === 'personal_data') {
    return '安装并启用插件后将继续登录；也可以暂不安装，先同步目前可读取的个人数据。'
  }
  if (setup?.source === 'public_schedule') {
    return '同步公开数据需要 Codex 插件。安装并启用后，本次初始化会自动继续。'
  }
  return '当前数据已安全保留。安装并启用插件后，Gtask 会自动继续等待处理的任务；无需重新同步。'
})
const codexSetupDeferLabel = computed(() =>
  pendingInitialSyncSetup.value?.source === 'personal_data' ? '暂不安装，继续登录' : '稍后安装'
)
const completedCount = computed(() => {
  const weekStart = startOfCurrentWeek()
  return items.value.filter((item) => item.completedAt && new Date(item.completedAt) >= weekStart).length
})
const activityTagOptions = computed(() => [...new Set(
  items.value
    .filter((item) => item.category === 'limited_event')
    .flatMap((item) => item.activityTags)
)].sort((left, right) => left.localeCompare(right, 'zh-CN')))
const expiringCount = computed(() => {
  const now = Date.now()
  const threshold = now + 3 * 24 * 60 * 60 * 1000
  return items.value.filter((item) => {
    if (item.completed || !item.endsAt) return false
    const end = new Date(item.endsAt).getTime()
    return end >= now && end <= threshold
  }).length
})
onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('wheel', handlePanelDragWheel, { capture: true, passive: false })
  window.addEventListener('blur', endPanelDrag)
  try {
    ;[
      games.value,
      gameVersionSummaries.value,
      appInfo.value,
      aiScheduleAgent.value
    ] = await Promise.all([
      window.gacha.listGames(),
      window.gacha.listGameVersionSummaries(),
      window.gacha.getAppInfo(),
      window.gacha.getAiScheduleAgentStatus()
    ])
    if (hiddenGameIds.value.includes(selectedGameId.value)) {
      selectedGameId.value = visibleGames.value[0]?.id ?? 'genshin'
    }
    await Promise.all([
      loadItems(),
      loadArchivedItems(),
      loadSyncSettings(),
      loadSyncTargetStates(),
      loadPersonalSyncTargets(),
      loadActiveAiJobs()
    ])
  } catch (error) {
    showError(error)
  } finally {
    loading.value = false
  }
})

const removeSyncListener = window.gacha.onSyncCompleted((result) => {
  if (result.gameId !== selectedGameId.value) return
  syncNotice.value = syncResultNotice(result)
  void Promise.all([
    loadItems(),
    loadGameVersionSummaries(),
    loadSyncSettings(),
    loadSyncTargetStates()
  ])
})
const removeChecklistListener = window.gacha.onChecklistChanged(() => {
  void Promise.all([
    loadItems(),
    loadGameVersionSummaries(),
    loadArchivedItems(),
    loadSyncSettings(),
    loadSyncTargetStates(),
    loadAiScheduleAgentStatus(),
    loadActiveAiJobs()
  ])
    .then(() => {
      const settings = syncSettings.value
      if (!settings?.message || settings.status === 'idle') return
      syncNotice.value = userFacingSyncNotice({
        status: settings.status === 'success'
          ? 'success'
          : settings.status === 'error'
            ? 'error'
            : 'partial',
        needsRetry: settings.status === 'error'
      })
    })
})
const removeSyncProgressListener = window.gacha.onSyncProgress((progress) => {
  if (progress.source === 'personal_data') {
    if (progress.target === 'all' || progress.target === 'tasks') return
    personalSyncProgressByKey.value = applyPersonalProgressUpdate(
      personalSyncProgressByKey.value,
      progress
    )
    if (isTerminalPersonalProgress(progress)) {
      if (progress.gameId === selectedGameId.value) {
        syncNotice.value = progress.status === 'completed'
          ? null
          : progress.status === 'cancelled'
            ? { status: 'cancelled', message: '已取消' }
            : userFacingSyncNotice({
                status: 'error'
              })
        void Promise.all([
          loadItems(),
          loadSyncSettings(),
          loadSyncTargetStates(),
          loadActiveAiJobs()
        ])
      }
      return
    }
    return
  }
  if (progress.gameId === selectedGameId.value) {
    if (progress.status === 'cancelled') {
      syncNotice.value = { status: 'cancelled', message: '已取消' }
    }
    void loadActiveAiJobs()
  }
})
const clockTimer = window.setInterval(() => {
  clockNow.value = Date.now()
}, 1_000)
const agentTimer = window.setInterval(() => {
  void loadAiScheduleAgentStatus()
}, 5_000)
const progressTimer = window.setInterval(() => {
  if (activeAiJobs.value.length > 0) void loadActiveAiJobs()
}, 2_000)
onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('wheel', handlePanelDragWheel, true)
  window.removeEventListener('blur', endPanelDrag)
  removeSyncListener()
  removeChecklistListener()
  removeSyncProgressListener()
  window.clearInterval(clockTimer)
  window.clearInterval(agentTimer)
  window.clearInterval(progressTimer)
  stopMiyousheLoginPolling()
})

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (miyousheLoginOpen.value) {
    void closeMiyousheLogin()
    return
  }
  if (kuroCredentialOpen.value) {
    void closeKuroCommunityLogin()
    return
  }
  if (pendingPublicSourceSwitch.value) {
    pendingPublicSourceSwitch.value = null
    return
  }
  globalSyncMenuOpen.value = false
  sectionSyncMenuOpen.value = null
  activityTagMenuOpen.value = false
  editorOpen.value = false
  recycleBinOpen.value = false
  settingsOpen.value = false
}

watch(selectedGameId, async (gameId, previousGameId) => {
  if (previousGameId) {
    checklistScrollByGame.set(previousGameId, captureChecklistScroll())
  }
  restoringGameView.value = true
  items.value = []
  syncNotice.value = null
  activeAiJob.value = null
  activeAiJobs.value = []
  globalSyncMenuOpen.value = false
  sectionSyncMenuOpen.value = null
  pendingPublicSourceSwitch.value = null
  activityTagMenuOpen.value = false
  draggingPanelSection.value = null
  panelDropTarget.value = null
  recycleBinOpen.value = false
  activityTagFilter.value = ''
  let savedScroll: ChecklistScrollSnapshot | undefined
  try {
    await Promise.all([
      loadItems({ showLoading: true, preserveScroll: false }),
      loadArchivedItems(),
      loadSyncSettings(),
      loadSyncTargetStates(),
      loadPersonalSyncTargets(),
      loadActiveAiJobs()
    ])
    savedScroll = checklistScrollByGame.get(gameId)
  } finally {
    if (selectedGameId.value === gameId) {
      restoringGameView.value = false
      if (savedScroll) await restoreChecklistScroll(savedScroll)
      else await nextTick()
    }
  }
}, { flush: 'sync' })

function currentPanelOrder(): ChecklistSection[] {
  return normalizePanelOrder(panelOrders.value[selectedGameId.value] ?? DEFAULT_PANEL_ORDER)
}

function persistPanelOrder(order: readonly ChecklistSection[]): void {
  panelOrders.value = writePanelOrder(
    window.localStorage,
    panelOrders.value,
    selectedGameId.value,
    order
  )
}

function resetPanelOrder(): void {
  persistPanelOrder(DEFAULT_PANEL_ORDER)
}

function beginPanelDrag(event: PointerEvent, section: ChecklistSection): void {
  if (event.button !== 0) return
  const handle = event.currentTarget
  if (!(handle instanceof HTMLElement)) return
  event.preventDefault()
  draggingPanelSection.value = section
  panelDropTarget.value = null
  panelDragPointerId = event.pointerId
  panelDragHandle = handle
  panelDragPoint.value = { x: event.clientX, y: event.clientY }
  handle.setPointerCapture(event.pointerId)
}

function handlePanelDragWheel(event: WheelEvent): void {
  const workspace = workspaceElement.value
  if (!draggingPanelSection.value || !workspace) return
  const delta = panelDragWheelDelta(event.deltaY, event.deltaMode, workspace.clientHeight)
  if (delta === 0) return
  event.preventDefault()
  workspace.scrollTop += delta
  if (panelDragPoint.value) {
    updatePanelDropTargetAtPoint(panelDragPoint.value.x, panelDragPoint.value.y)
    window.requestAnimationFrame(() => {
      if (panelDragPoint.value) {
        updatePanelDropTargetAtPoint(panelDragPoint.value.x, panelDragPoint.value.y)
      }
    })
  }
}

function updatePanelDropTargetAtPoint(clientX: number, clientY: number): void {
  const source = draggingPanelSection.value
  if (!source) return
  const hit = document.elementFromPoint(clientX, clientY)
  const element = hit instanceof Element
    ? hit.closest<HTMLElement>('[data-panel-section]')
    : null
  const section = element?.dataset.panelSection as ChecklistSection | undefined
  if (!element || !section || !panelBySection.has(section) || source === section) {
    panelDropTarget.value = null
    return
  }
  const bounds = element.getBoundingClientRect()
  panelDropTarget.value = {
    section,
    position: clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
  }
}

function movePanelDrag(event: PointerEvent): void {
  if (event.pointerId !== panelDragPointerId || !draggingPanelSection.value) return
  panelDragPoint.value = { x: event.clientX, y: event.clientY }
  updatePanelDropTargetAtPoint(event.clientX, event.clientY)
}

function finishPanelDrag(event: PointerEvent): void {
  if (event.pointerId !== panelDragPointerId) return
  movePanelDrag(event)
  dropPanel()
}

function cancelPanelDrag(event: PointerEvent): void {
  if (event.pointerId === panelDragPointerId) endPanelDrag()
}

function dropPanel(): void {
  const source = draggingPanelSection.value
  const target = panelDropTarget.value
  if (source && target) {
    persistPanelOrder(movePanelSection(currentPanelOrder(), source, target.section, target.position))
  }
  endPanelDrag()
}

function endPanelDrag(): void {
  if (panelDragHandle && panelDragPointerId !== null) {
    try {
      if (panelDragHandle.hasPointerCapture(panelDragPointerId)) {
        panelDragHandle.releasePointerCapture(panelDragPointerId)
      }
    } catch {
      // Pointer capture may already be released by the browser after pointerup.
    }
  }
  panelDragPointerId = null
  panelDragHandle = null
  panelDragPoint.value = null
  draggingPanelSection.value = null
  panelDropTarget.value = null
}

function movePanelByKeyboard(section: ChecklistSection, direction: -1 | 1): void {
  const order = currentPanelOrder()
  const sourceIndex = order.indexOf(section)
  const targetIndex = sourceIndex + direction
  if (sourceIndex < 0 || targetIndex < 0 || targetIndex >= order.length) return
  persistPanelOrder(movePanelSection(
    order,
    section,
    order[targetIndex],
    direction < 0 ? 'before' : 'after'
  ))
}

interface ChecklistScrollSnapshot {
  workspaceTop: number
  workspaceLeft: number
}

function captureChecklistScroll(): ChecklistScrollSnapshot {
  return {
    workspaceTop: workspaceElement.value?.scrollTop ?? 0,
    workspaceLeft: workspaceElement.value?.scrollLeft ?? 0
  }
}

async function restoreChecklistScroll(snapshot: ChecklistScrollSnapshot): Promise<void> {
  const restore = (): void => {
    workspaceElement.value?.scrollTo({
      top: snapshot.workspaceTop,
      left: snapshot.workspaceLeft,
      behavior: 'auto'
    })
  }
  await nextTick()
  restore()
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
  restore()
}

async function loadItems(
  options: { showLoading?: boolean; preserveScroll?: boolean } = {}
): Promise<void> {
  const gameId = selectedGameId.value
  const showLoading = options.showLoading ?? false
  const preserveScroll = options.preserveScroll ?? true
  const scrollSnapshot = preserveScroll ? captureChecklistScroll() : null
  if (showLoading) loading.value = true
  errorMessage.value = ''
  try {
    const loadedItems = await window.gacha.listChecklistItems(gameId)
    if (selectedGameId.value === gameId) {
      items.value = loadedItems
      const mapItems = loadedItems.filter((item) => item.category === 'exploration')
      const currentBranchKeys = collectMapBranchKeys(mapItems)
      const knownBranchKeys = knownMapBranchKeysByGame.get(gameId) ?? new Set<string>()
      const collapsed = collapsedMapKeysByGame.get(gameId) ?? new Set<string>()
      for (const key of currentBranchKeys) {
        if (!knownBranchKeys.has(key)) collapsed.add(key)
        knownBranchKeys.add(key)
      }
      knownMapBranchKeysByGame.set(gameId, knownBranchKeys)
      collapsedMapKeysByGame.set(gameId, collapsed)
      collapsedMapKeys.value = new Set(collapsed)
      if (scrollSnapshot) await restoreChecklistScroll(scrollSnapshot)
    }
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  } finally {
    if (showLoading && selectedGameId.value === gameId) loading.value = false
  }
}

async function loadGameVersionSummaries(): Promise<void> {
  try {
    gameVersionSummaries.value = await window.gacha.listGameVersionSummaries()
  } catch (error) {
    showError(error)
  }
}

async function loadSyncSettings(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const loadedSettings = await window.gacha.getSyncSettings(gameId)
    if (selectedGameId.value === gameId) syncSettings.value = loadedSettings
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

async function dismissInitialSyncGuide(gameId = selectedGameId.value): Promise<boolean> {
  const previousSettings = selectedGameId.value === gameId ? syncSettings.value : null
  if (previousSettings && selectedGameId.value === gameId) {
    syncSettings.value = { ...previousSettings, initialGuideDismissed: true }
  }
  try {
    const settings = await window.gacha.dismissInitialSyncGuide(gameId)
    if (selectedGameId.value === gameId) syncSettings.value = settings
    return true
  } catch (error) {
    if (selectedGameId.value === gameId && previousSettings) syncSettings.value = previousSettings
    if (selectedGameId.value === gameId) showError(error)
    return false
  }
}

function credentialProviderForGame(gameId: GameId): CredentialProvider {
  return gameId === 'wuthering-waves' ? 'kuro-community' : 'miyoushe'
}

async function ensurePersonalSyncCredential(gameId: GameId): Promise<boolean> {
  credentialStatuses.value = await window.gacha.listCredentialStatuses()
  const provider = credentialProviderForGame(gameId)
  const credential = credentialStatuses.value.find((status) => status.provider === provider)
  if (credential?.stored) return true
  if (selectedGameId.value === gameId) await openCredentialSettings(provider)
  return false
}

async function runPersonalSyncBatch(gameId = selectedGameId.value): Promise<boolean> {
  if (globalPersonalSyncBusy.value) return false
  globalSyncMenuOpen.value = false
  globalPersonalSyncBusy.value = true
  try {
    if (!await ensurePersonalSyncCredential(gameId)) return false
    const supportedTargets = orderPersonalSyncTargets(
      await window.gacha.getPersonalSyncTargets(gameId)
    )
    if (supportedTargets.length === 0) {
      if (selectedGameId.value === gameId) errorMessage.value = '当前游戏暂不支持同步个人数据'
      return false
    }
    for (let index = 0; index < supportedTargets.length; index += 1) {
      if (index > 0) await waitForPersonalSyncCooldown()
      if (!await runPersonalSync(supportedTargets[index], gameId)) return false
    }
    return true
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
    return false
  } finally {
    globalPersonalSyncBusy.value = false
  }
}

async function runGlobalPublicSync(gameId = selectedGameId.value): Promise<boolean> {
  if (globalPublicSyncBusy.value) return false
  globalSyncMenuOpen.value = false
  if (!aiScheduleAvailable.value) {
    codexSetupPromptOpen.value = true
    return false
  }
  globalPublicSyncBusy.value = true
  try {
    const states = await window.gacha.getSyncTargetStates(gameId)
    if (selectedGameId.value === gameId) syncTargetStates.value = states
    const targets = selectGuardedGlobalPublicTargets(states)
    const results = await Promise.all(
      targets.map((target) => runSync('public_schedule', target, gameId))
    )
    const skippedPersonalCount = ['events', 'cycles', 'exploration'].filter((target) =>
      states.find((state) => state.target === target)?.catalogSource === 'personal_data'
    ).length
    if (selectedGameId.value === gameId && skippedPersonalCount > 0 && !results.every(Boolean)) {
      syncNotice.value = userFacingSyncNotice({
        status: 'partial',
        needsRetry: true
      })
    }
    return results.length > 0 && results.every(Boolean)
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
    return false
  } finally {
    globalPublicSyncBusy.value = false
  }
}

async function continueInitialSyncSetup(): Promise<void> {
  const setup = pendingInitialSyncSetup.value
  if (!setup || initialSyncContinuationBusy.value) return
  initialSyncContinuationBusy.value = true
  try {
    const provider = credentialProviderForGame(setup.gameId)
    if (setup.source === 'personal_data') {
      credentialStatuses.value = await window.gacha.listCredentialStatuses()
    }
    const credentialStored = setup.source === 'personal_data' && credentialStatuses.value.some(
      (status) => status.provider === provider && status.stored
    )
    const step = resolveInitialSyncSetupStep(
      setup,
      Boolean(aiScheduleAgent.value?.codexPluginInstalled),
      credentialStored
    )
    if (step === 'codex_plugin') {
      codexSetupPromptOpen.value = true
      return
    }
    if (step === 'credential') {
      await openCredentialSettings(provider)
      return
    }

    pendingInitialSyncSetup.value = null
    if (setup.source === 'personal_data') {
      void runPersonalSyncBatch(setup.gameId)
    } else {
      void runGlobalPublicSync(setup.gameId)
    }
  } catch (error) {
    if (selectedGameId.value === setup.gameId) showError(error)
  } finally {
    initialSyncContinuationBusy.value = false
  }
}

async function beginInitialSync(source: InitialSyncSource): Promise<void> {
  if (onboardingBusy.value) return
  const gameId = selectedGameId.value
  const claim = claimInitialSyncSetup(pendingInitialSyncSetup.value, gameId, source)
  if (!claim.accepted) return
  pendingInitialSyncSetup.value = claim.setup
  onboardingBusy.value = true
  try {
    if (!await dismissInitialSyncGuide(gameId)) {
      pendingInitialSyncSetup.value = null
      return
    }
  } catch (error) {
    showError(error)
  } finally {
    onboardingBusy.value = false
  }
  await continueInitialSyncSetup()
}

async function startInitialPublicSync(): Promise<void> {
  await beginInitialSync('public_schedule')
}

async function startInitialPersonalSync(): Promise<void> {
  await beginInitialSync('personal_data')
}

async function loadSyncTargetStates(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const states = await window.gacha.getSyncTargetStates(gameId)
    if (selectedGameId.value === gameId) syncTargetStates.value = states
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

async function loadPersonalSyncTargets(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const targets = await window.gacha.getPersonalSyncTargets(gameId)
    if (selectedGameId.value === gameId) personalSyncTargets.value = targets
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

function syncTargetState(target: SyncTargetState['target']): SyncTargetState | undefined {
  return syncTargetStates.value.find((state) => state.target === target)
}

function formatSyncTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function syncStateTimestamp(state: SyncTargetState | undefined): string | null {
  if (state?.status === 'success') return state.lastSuccessAt
  return state?.lastAttemptAt ?? state?.lastSuccessAt ?? null
}

function syncStateLabel(state: SyncTargetState | undefined): string {
  if (!state || (!state.lastAttemptAt && !state.lastSuccessAt)) return '未同步'
  const source = state.catalogSource === 'personal_data'
    ? '个人数据'
    : state.catalogSource === 'public_schedule'
      ? '公开数据'
      : null
  if (state.status === 'success') return source ? `已同步 · ${source}` : '已同步'
  if (state.status === 'stale') return '部分同步'
  if (state.status === 'error') return '同步失败'
  if (state.status === 'verification_required') return '待验证'
  return '同步中'
}

function syncStateClass(state: SyncTargetState | undefined): string {
  return state?.status ?? 'idle'
}

async function loadAiScheduleAgentStatus(): Promise<void> {
  try {
    aiScheduleAgent.value = await window.gacha.getAiScheduleAgentStatus()
    if (aiScheduleAgent.value.codexPluginInstalled) {
      codexSetupPromptOpen.value = false
      if (pendingInitialSyncSetup.value) void continueInitialSyncSetup()
    }
  } catch (error) {
    showError(error)
  }
}

function dismissCodexSetupPrompt(): void {
  codexSetupPromptOpen.value = false
  const setup = pendingInitialSyncSetup.value
  if (!setup) return
  if (setup.source === 'public_schedule') {
    pendingInitialSyncSetup.value = null
    return
  }
  pendingInitialSyncSetup.value = { ...setup, allowWithoutCodexPlugin: true }
  void continueInitialSyncSetup()
}

async function loadActiveAiJobs(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const jobs = await window.gacha.listActiveAiScheduleJobs(gameId)
    if (selectedGameId.value === gameId) {
      activeAiJobs.value = jobs
      activeAiJob.value = jobs[0] ?? null
      const activeTargets = new Set<PersonalSyncTarget>()
      for (const target of personalReviewTargets) {
        if (isSyncRequestActive('personal_data', target, gameId)) activeTargets.add(target)
      }
      personalSyncProgressByKey.value = reconcilePersonalProgressForGame(
        personalSyncProgressByKey.value,
        gameId,
        jobs,
        activeTargets
      )
    }
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

const syncProgressPhaseLabels: Record<SyncProgressUpdate['phase'], string> = {
  queued: '排队中',
  fetching: '读取数据',
  searching: '联网检索',
  verifying: '核对信息',
  structuring: '整理清单',
  writing: '写入清单',
  retrying: '正在重试',
  verification: '等待验证',
  merging: '更新清单',
  completed: '同步完成',
  failed: '同步失败',
  cancelled: '已取消'
}

const syncProgressTargetLabels: Record<SyncTarget, string> = {
  all: '全局',
  tasks: '任务',
  events: '活动',
  cycles: '周期事项',
  exploration: '地图探索'
}

function syncProgressTitle(progress: SyncProgressUpdate): string {
  if (progress.source !== 'public_schedule') {
    return `${personalPlatform.value}${syncProgressTargetLabels[progress.target]}个人数据同步`
  }
  if (progress.target === 'tasks') return '版更校时'
  return `${syncProgressTargetLabels[progress.target]}公开数据同步`
}

function syncProgressCount(progress: SyncProgressUpdate): string | null {
  if (progress.current === null || progress.total === null) return null
  return `${progress.current}/${progress.total}`
}

function syncProgressPercent(progress: SyncProgressUpdate): number | null {
  if (progress.current === null || progress.total === null || progress.total <= 0) return null
  return Math.min(100, Math.round(progress.current / progress.total * 100))
}

function syncProgressStalled(progress: SyncProgressUpdate): boolean {
  const elapsed = clockNow.value - new Date(progress.updatedAt).getTime()
  return (progress.status === 'waiting' && elapsed > 60_000) ||
    (progress.status === 'running' && elapsed > 30_000)
}

function syncProgressAge(progress: SyncProgressUpdate): string {
  if (progress.status === 'waiting') return '排队中'
  const seconds = Math.max(0, Math.floor((clockNow.value - new Date(progress.updatedAt).getTime()) / 1_000))
  const elapsed = seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分钟`
  return `${elapsed}前更新`
}

function syncProgressMessage(progress: SyncProgressUpdate): string {
  return userFacingProgressMessage(progress)
}

function progressForTarget(target: SyncTarget): SyncProgressUpdate | null {
  return liveSyncProgress.value.find((progress) => progress.target === target) ?? null
}

async function loadArchivedItems(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const loadedItems = await window.gacha.listArchivedChecklistItems(gameId)
    if (selectedGameId.value === gameId) archivedItems.value = loadedItems
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

async function openSettings(): Promise<void> {
  settingsOpen.value = true
  try {
    const [statuses, listedBackups, preferences, loadedRenderingMode, loadedUpdateSettings] = await Promise.all([
      window.gacha.listCredentialStatuses(),
      window.gacha.listBackups(),
      window.gacha.getCodexWorkerPreferences(),
      window.gacha.getRenderingModeState(),
      window.gacha.getSoftwareUpdateSettings()
    ])
    credentialStatuses.value = statuses
    backups.value = listedBackups
    codexWorkerPreferences.value = preferences
    codexWorkerPreferencesMessage.value = ''
    renderingModeState.value = loadedRenderingMode
    renderingModeSelection.value = loadedRenderingMode.configured
    renderingModeMessage.value = ''
    softwareUpdateSettings.value = loadedUpdateSettings
    softwareUpdateMessage.value = ''
  } catch (error) {
    showError(error)
  }
}

function closeSettings(): void {
  settingsOpen.value = false
  const setup = pendingInitialSyncSetup.value
  if (!setup || setup.source !== 'personal_data') return
  const provider = credentialProviderForGame(setup.gameId)
  const credentialStored = credentialStatuses.value.some(
    (status) => status.provider === provider && status.stored
  )
  if (!credentialStored) {
    pendingInitialSyncSetup.value = null
    return
  }
  void continueInitialSyncSetup()
}

async function openCredentialSettings(provider: CredentialProvider): Promise<void> {
  await openSettings()
  await nextTick()
  const row = document.querySelector<HTMLElement>(
    `[data-credential-provider="${provider}"]`
  )
  row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  row?.querySelector<HTMLButtonElement>('.credential-actions button')?.focus({
    preventScroll: true
  })
}

function isGameVisible(gameId: GameId): boolean {
  return !hiddenGameIds.value.includes(gameId)
}

function toggleGameVisibility(gameId: GameId): void {
  const currentlyVisible = isGameVisible(gameId)
  if (currentlyVisible && visibleGames.value.length === 1) {
    errorMessage.value = '至少需要保留一款游戏显示'
    return
  }

  const nextHidden = currentlyVisible
    ? [...hiddenGameIds.value, gameId]
    : hiddenGameIds.value.filter((id) => id !== gameId)

  try {
    hiddenGameIds.value = writeHiddenGameIds(window.localStorage, nextHidden)
    if (hiddenGameIds.value.includes(selectedGameId.value)) {
      selectedGameId.value = visibleGames.value[0]?.id ?? 'genshin'
    }
  } catch (error) {
    showError(error)
  }
}

async function createBackup(): Promise<void> {
  if (backingUp.value) return
  backingUp.value = true
  try {
    await window.gacha.createBackup()
    backups.value = await window.gacha.listBackups()
  } catch (error) {
    showError(error)
  } finally {
    backingUp.value = false
  }
}

async function restoreBackup(backup: BackupSummary): Promise<void> {
  if (restoringBackup.value) return
  restoringBackup.value = backup.fileName
  try {
    const restarting = await window.gacha.restoreBackup(backup.fileName)
    if (!restarting) restoringBackup.value = null
  } catch (error) {
    restoringBackup.value = null
    showError(error)
  }
}

async function clearCredential(provider: CredentialProvider): Promise<void> {
  const platform = provider === 'miyoushe' ? '米游社' : '库街区'
  if (!window.confirm(`确定清除本机保存的${platform}登录凭据吗？`)) return
  try {
    await window.gacha.clearCredential(provider)
    credentialStatuses.value = await window.gacha.listCredentialStatuses()
  } catch (error) {
    showError(error)
  }
}

async function startMiyousheLogin(): Promise<void> {
  if (startingMiyousheLogin.value) return
  startingMiyousheLogin.value = true
  stopMiyousheLoginPolling()
  try {
    miyousheLoginState.value = await window.gacha.startMiyousheQrLogin()
    miyousheLoginOpen.value = true
    miyousheLoginTimer = window.setInterval(() => void pollMiyousheLogin(), 1_000)
  } catch (error) {
    showError(error)
  } finally {
    startingMiyousheLogin.value = false
  }
}

async function pollMiyousheLogin(): Promise<void> {
  const state = miyousheLoginState.value
  if (!state || pollingMiyousheLogin.value || ['confirmed', 'expired'].includes(state.status)) return
  pollingMiyousheLogin.value = true
  try {
    const nextState = await window.gacha.pollMiyousheQrLogin(state.sessionId)
    if (miyousheLoginState.value?.sessionId !== state.sessionId) return
    miyousheLoginState.value = nextState
    if (nextState.status === 'confirmed') {
      stopMiyousheLoginPolling()
      credentialStatuses.value = await window.gacha.listCredentialStatuses()
    } else if (nextState.status === 'expired') {
      stopMiyousheLoginPolling()
    }
  } catch (error) {
    stopMiyousheLoginPolling()
    showError(error)
  } finally {
    pollingMiyousheLogin.value = false
  }
}

async function closeMiyousheLogin(): Promise<void> {
  const sessionId = miyousheLoginState.value?.sessionId
  const shouldResumeInitialSync = miyousheLoginState.value?.status === 'confirmed'
  const finished = ['confirmed', 'expired'].includes(miyousheLoginState.value?.status ?? '')
  stopMiyousheLoginPolling()
  miyousheLoginOpen.value = false
  miyousheLoginState.value = null
  if (sessionId && !finished) {
    try {
      await window.gacha.cancelMiyousheQrLogin(sessionId)
    } catch {
      // Closing the UI remains safe even if the in-memory session already expired.
    }
  }
  if (shouldResumeInitialSync) {
    settingsOpen.value = false
    await continueInitialSyncSetup()
  }
}

function stopMiyousheLoginPolling(): void {
  if (miyousheLoginTimer !== null) window.clearInterval(miyousheLoginTimer)
  miyousheLoginTimer = null
}

function openKuroCommunityLogin(): void {
  kuroLoginPhone.value = ''
  kuroLoginCode.value = ''
  kuroLoginSessionId.value = ''
  kuroLoginPhase.value = 'phone'
  kuroCredentialRoles.value = []
  kuroSelectedRoleKey.value = ''
  kuroCredentialMessage.value = ''
  kuroCredentialOpen.value = true
}

async function closeKuroCommunityLogin(): Promise<void> {
  if (kuroCredentialBusy.value) return
  const sessionId = kuroLoginSessionId.value
  kuroCredentialOpen.value = false
  kuroLoginPhone.value = ''
  kuroLoginCode.value = ''
  kuroLoginSessionId.value = ''
  kuroLoginPhase.value = 'phone'
  kuroCredentialRoles.value = []
  kuroSelectedRoleKey.value = ''
  kuroCredentialMessage.value = ''
  if (sessionId) {
    try {
      await window.gacha.cancelKuroCommunityLogin(sessionId)
    } catch {
      // The server-side session may already have been consumed or expired.
    }
  }
}

async function sendKuroCommunitySms(): Promise<void> {
  if (kuroCredentialBusy.value) return
  kuroCredentialBusy.value = true
  kuroCredentialMessage.value = '请在弹出的窗口中完成官方滑块验证…'
  try {
    const state = await window.gacha.sendKuroCommunitySms(kuroLoginPhone.value)
    kuroLoginSessionId.value = state.sessionId
    kuroLoginPhase.value = 'code'
    kuroCredentialMessage.value = state.message
  } catch (error) {
    kuroCredentialMessage.value = ''
    showError(error)
  } finally {
    kuroCredentialBusy.value = false
  }
}

async function completeKuroCommunityLogin(): Promise<void> {
  if (kuroCredentialBusy.value || !kuroLoginSessionId.value) return
  kuroCredentialBusy.value = true
  kuroCredentialMessage.value = '正在登录库街区并读取鸣潮角色…'
  try {
    const result = await window.gacha.completeKuroCommunityLogin(
      kuroLoginSessionId.value,
      kuroLoginCode.value
    )
    kuroCredentialRoles.value = result.roles
    kuroSelectedRoleKey.value = result.roles.length === 1 ? kuroRoleKey(result.roles[0]) : ''
    kuroLoginPhase.value = 'role'
    kuroCredentialMessage.value = result.roles.length === 1
      ? '已读取角色，正在等待保存'
      : `已读取 ${result.roles.length} 个角色，请选择要同步的角色`
  } catch (error) {
    kuroCredentialMessage.value = ''
    showError(error)
  } finally {
    kuroCredentialBusy.value = false
  }
}

async function saveKuroCommunityLogin(): Promise<void> {
  if (kuroCredentialBusy.value) return
  const role = kuroCredentialRoles.value.find(
    (candidate) => kuroRoleKey(candidate) === kuroSelectedRoleKey.value
  )
  if (!role) {
    kuroCredentialMessage.value = '角色选择状态无效，请重新登录并选择角色'
    return
  }
  kuroCredentialBusy.value = true
  kuroCredentialMessage.value = '正在向库街区校验角色数据权限…'
  try {
    await window.gacha.storeKuroCommunityLogin(
      kuroLoginSessionId.value,
      role.roleId,
      role.serverId
    )
    credentialStatuses.value = await window.gacha.listCredentialStatuses()
    kuroCredentialBusy.value = false
    await closeKuroCommunityLogin()
    settingsOpen.value = false
    await continueInitialSyncSetup()
  } catch (error) {
    kuroCredentialMessage.value = error instanceof Error
      ? error.message
      : '库街区凭据验证失败，请重试'
    showError(error)
    kuroCredentialBusy.value = false
  }
}

async function openDataDirectory(): Promise<void> {
  try {
    await window.gacha.openDataDirectory()
  } catch (error) {
    showError(error)
  }
}

async function openExternalSource(url: string): Promise<void> {
  try {
    await window.gacha.openExternalUrl(url)
  } catch (error) {
    showError(error)
  }
}

async function openCodexPlugin(): Promise<void> {
  try {
    await window.gacha.openCodexPlugin()
    codexPluginMessage.value = 'Codex 安装页已打开；安装并启用后，Gtask 会自动检测。'
  } catch (error) {
    showError(error)
  }
}

async function updateCodexPlugin(): Promise<void> {
  codexPluginBusy.value = true
  codexPluginMessage.value = '正在更新插件…'
  try {
    const result = await window.gacha.updateCodexPlugin()
    codexPluginMessage.value = result.message
    await loadAiScheduleAgentStatus()
  } catch (error) {
    codexPluginMessage.value = ''
    showError(error)
  } finally {
    codexPluginBusy.value = false
  }
}

async function saveCodexWorkerPreferences(): Promise<void> {
  if (codexWorkerPreferencesBusy.value) return
  codexWorkerPreferencesBusy.value = true
  codexWorkerPreferencesMessage.value = '正在保存…'
  try {
    codexWorkerPreferences.value = await window.gacha.updateCodexWorkerPreferences(
      toCodexWorkerPreferencesIpcPayload(codexWorkerPreferences.value)
    )
    codexWorkerPreferencesMessage.value = '设置已保存'
  } catch (error) {
    codexWorkerPreferencesMessage.value = ''
    showError(error)
  } finally {
    codexWorkerPreferencesBusy.value = false
  }
}

async function saveRenderingMode(): Promise<void> {
  if (renderingModeBusy.value) return
  renderingModeBusy.value = true
  renderingModeMessage.value = '正在保存…'
  try {
    const state = await window.gacha.updateRenderingMode(renderingModeSelection.value)
    renderingModeState.value = state
    if (!state.restartRequired) {
      renderingModeMessage.value = '当前已使用此模式。'
      return
    }
    renderingModeMessage.value = '已保存，正在重启 Gtask…'
    await window.gacha.restartApp()
  } catch (error) {
    renderingModeMessage.value = ''
    showError(error)
  } finally {
    renderingModeBusy.value = false
  }
}

async function saveSoftwareUpdatePreference(): Promise<void> {
  if (softwareUpdateBusy.value) return
  softwareUpdateBusy.value = true
  softwareUpdateMessage.value = '正在保存…'
  try {
    softwareUpdateSettings.value = await window.gacha.updateSoftwareUpdateSettings({
      autoCheckEnabled: softwareUpdateSettings.value.autoCheckEnabled
    })
    softwareUpdateMessage.value = '设置已保存'
  } catch (error) {
    softwareUpdateSettings.value.autoCheckEnabled = !softwareUpdateSettings.value.autoCheckEnabled
    softwareUpdateMessage.value = ''
    showError(error)
  } finally {
    softwareUpdateBusy.value = false
  }
}

async function checkSoftwareUpdate(): Promise<void> {
  if (softwareUpdateBusy.value) return
  softwareUpdateBusy.value = true
  softwareUpdateMessage.value = '正在检查更新…'
  try {
    const result: SoftwareUpdateCheckResult = await window.gacha.checkSoftwareUpdate()
    softwareUpdateMessage.value = result.message
    softwareUpdateSettings.value = await window.gacha.getSoftwareUpdateSettings()
    if (result.outcome === 'update_available' && result.releaseUrl) {
      const confirmed = window.confirm(`${result.message}，是否查看更新？`)
      if (confirmed) await window.gacha.openExternalUrl(result.releaseUrl)
    }
  } catch (error) {
    softwareUpdateMessage.value = '暂时无法检查更新，请稍后重试'
    showError(error)
  } finally {
    softwareUpdateBusy.value = false
  }
}

function formatUpdateCheckTime(value: string | null): string {
  if (!value) return '尚未完成在线检查'
  return `上次检查 ${new Date(value).toLocaleString('zh-CN', { hour12: false })}`
}

async function copyCodexProxyRepairPrompt(): Promise<void> {
  try {
    await navigator.clipboard.writeText(CODEX_PROXY_REPAIR_PROMPT)
    codexProxyPromptCopied.value = true
    window.setTimeout(() => {
      codexProxyPromptCopied.value = false
    }, 2_000)
  } catch (error) {
    showError(error)
  }
}

async function repairCodexConnection(mode: 'proxy' | 'https'): Promise<void> {
  const confirmed = window.confirm(mode === 'proxy'
    ? '检测到 Codex 连接不稳定。是否使用当前系统代理重新连接？不会修改 Windows 或 Codex 配置，重连会消耗少量 Token。'
    : '连接仍不稳定。是否改用 HTTPS 兼容连接？不会修改 Codex 配置，重连会消耗少量 Token。')
  if (!confirmed) return
  codexRepairBusy.value = true
  try {
    const result = await window.gacha.repairCodexConnection(mode)
    codexRepairStage.value = result.mode === 'proxy' ? 'proxy_applied' : 'https_applied'
    syncNotice.value = { status: 'partial', message: result.message }
    await loadActiveAiJobs()
  } catch (error) {
    if (mode === 'proxy') {
      codexRepairStage.value = 'proxy_applied'
    }
    showError(error)
  } finally {
    codexRepairBusy.value = false
  }
}

function continueCodexSyncWithoutProxyChange(): void {
  dismissedCodexProxyJobId.value = activeAiJob.value?.id ?? ''
}

function syncRequestKey(
  gameId: GameId,
  source: SyncProgressUpdate['source'],
  target: SyncTarget
): string {
  return `${gameId}:${source}:${target}`
}

function setSyncRequestActive(
  gameId: GameId,
  source: SyncProgressUpdate['source'],
  target: SyncTarget,
  active: boolean
): void {
  const next = new Set(activeSyncRequests.value)
  const key = syncRequestKey(gameId, source, target)
  if (active) next.add(key)
  else next.delete(key)
  activeSyncRequests.value = next
}

function isSyncRequestActive(
  source: SyncProgressUpdate['source'],
  target: SyncTarget,
  gameId = selectedGameId.value
): boolean {
  return activeSyncRequests.value.has(syncRequestKey(gameId, source, target))
}

function hasActivePublicSyncForTarget(target: SyncTarget): boolean {
  return activeAiJobs.value.some(
    (job) => job.jobKind === 'public_catalog' &&
      (job.target === target || job.target === 'all' || target === 'all')
  )
}

function hasActivePersonalSyncForTarget(
  target: PersonalSyncTarget,
  gameId = selectedGameId.value
): boolean {
  const progress = personalSyncProgressByKey.value[
    personalProgressKey(gameId, target)
  ]
  return activeAiJobs.value.some((job) => job.gameId === gameId &&
    (job.jobKind === 'personal_metadata' || job.jobKind === 'personal_review') &&
      job.target === target
  ) || isSyncRequestActive('personal_data', target, gameId) || Boolean(
    progress && ['waiting', 'running', 'verification_required'].includes(progress.status)
  )
}

const hasActivePersonalSync = computed(() =>
  personalSyncTargets.value.some((target) => hasActivePersonalSyncForTarget(target))
)
const globalSyncBusy = computed(() =>
  globalPersonalSyncBusy.value ||
  globalPublicSyncBusy.value ||
  syncing.value ||
  hasActivePublicSync.value ||
  hasActivePersonalSync.value
)

function panelHasActiveSync(panel: ChecklistPanel): boolean {
  const target = panel.syncTarget
  if (!target) return false
  if (
    isSyncRequestActive('public_schedule', target) ||
    hasActivePublicSyncForTarget(target)
  ) return true
  return target !== 'tasks' && hasActivePersonalSyncForTarget(target)
}

const visiblePanels = computed(() => filterChecklistPanels(
  orderedPanels.value,
  items.value,
  showIncompleteOnly.value,
  new Set(
    orderedPanels.value
      .filter(panelHasActiveSync)
      .map((panel) => panel.section)
  )
))

function isCancellingSync(progress: SyncProgressUpdate): boolean {
  return cancellingSyncKeys.value.has(
    syncRequestKey(progress.gameId, progress.source, progress.target)
  )
}

async function cancelSync(progress: SyncProgressUpdate): Promise<void> {
  const key = syncRequestKey(progress.gameId, progress.source, progress.target)
  if (cancellingSyncKeys.value.has(key)) return
  const nextCancelling = new Set(cancellingSyncKeys.value)
  nextCancelling.add(key)
  cancellingSyncKeys.value = nextCancelling
  setSyncRequestActive(progress.gameId, progress.source, progress.target, false)

  if (progress.source === 'public_schedule') {
    activeAiJobs.value = activeAiJobs.value.filter(
      (job) => !(job.gameId === progress.gameId && job.target === progress.target)
    )
    activeAiJob.value = activeAiJobs.value[0] ?? null
  } else if (progress.target !== 'all' && progress.target !== 'tasks') {
    activeAiJobs.value = activeAiJobs.value.filter(
      (job) => !(
        job.gameId === progress.gameId &&
        job.target === progress.target &&
        (job.jobKind === 'personal_metadata' || job.jobKind === 'personal_review')
      )
    )
    activeAiJob.value = activeAiJobs.value[0] ?? null
    const nextProgress = { ...personalSyncProgressByKey.value }
    delete nextProgress[personalProgressKey(progress.gameId, progress.target)]
    personalSyncProgressByKey.value = nextProgress
  }
  syncNotice.value = { status: 'cancelled', message: '正在取消…' }

  try {
    const result = await window.gacha.cancelSync(
      progress.gameId,
      progress.target,
      progress.source
    )
    syncNotice.value = {
      status: result.cancelled ? 'cancelled' : 'partial',
      message: result.cancelled ? '同步已取消' : '当前没有进行中的同步'
    }
    await Promise.all([
      loadActiveAiJobs(),
      loadSyncSettings(),
      loadSyncTargetStates()
    ])
  } catch (error) {
    showError(error)
  } finally {
    const remaining = new Set(cancellingSyncKeys.value)
    remaining.delete(key)
    cancellingSyncKeys.value = remaining
  }
}

async function runSync(
  scope: SyncScope,
  target: SyncTarget = 'all',
  gameId = selectedGameId.value
): Promise<boolean> {
  if (isSyncRequestActive('public_schedule', target, gameId)) return false
  if (!aiScheduleAvailable.value) {
    codexSetupPromptOpen.value = true
    return false
  }
  globalSyncMenuOpen.value = false
  sectionSyncMenuOpen.value = null
  setSyncRequestActive(gameId, 'public_schedule', target, true)
  syncNotice.value = null
  try {
    const result = await window.gacha.syncGame(gameId, scope, target, {
      outputLocale: document.documentElement.lang || 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    })
    if (selectedGameId.value === gameId) {
      syncNotice.value = syncResultNotice(result)
      await Promise.all([loadItems(), loadSyncSettings(), loadSyncTargetStates(), loadActiveAiJobs()])
    }
    return result.status !== 'error' && result.status !== 'cancelled'
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
    return false
  } finally {
    setSyncRequestActive(gameId, 'public_schedule', target, false)
  }
}

async function runPersonalSync(
  target: SyncTarget,
  gameId = selectedGameId.value
): Promise<boolean> {
  if (target === 'all' || target === 'tasks') return false
  if (hasActivePersonalSyncForTarget(target, gameId)) return false
  globalSyncMenuOpen.value = false
  sectionSyncMenuOpen.value = null
  setSyncRequestActive(gameId, 'personal_data', target, true)
  syncNotice.value = null
  const progressKey = personalProgressKey(gameId, target)
  const nextProgress = { ...personalSyncProgressByKey.value }
  delete nextProgress[progressKey]
  personalSyncProgressByKey.value = nextProgress
  try {
    const result = await window.gacha.syncPersonalData(gameId, target, {
      outputLocale: document.documentElement.lang || 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    })
    if (selectedGameId.value === gameId) {
      const credentialProvider = credentialProviderForSyncResult(result)
      syncNotice.value = userFacingSyncNotice({
        status: result.status,
        credentialProvider,
        needsRetry: result.sources.some((source) => source.status === 'error')
      })
      const pendingReview = result.sources.reduce(
        (count, source) => count + (source.pendingReview ?? 0),
        0
      )
      if (pendingReview > 0) {
        await loadActiveAiJobs()
      }
      if (result.sources.some((source) => source.requiresCodexPlugin)) {
        codexSetupPromptOpen.value = true
      }
      await Promise.all([loadItems(), loadSyncSettings(), loadSyncTargetStates()])
      if (credentialProvider) await openCredentialSettings(credentialProvider)
    }
    return result.status !== 'error' && result.status !== 'cancelled' &&
      !credentialProviderForSyncResult(result)
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
    return false
  } finally {
    setSyncRequestActive(gameId, 'personal_data', target, false)
    const hasBackgroundJob = activeAiJobs.value.some(
      (job) => job.gameId === gameId && job.target === target &&
        (job.jobKind === 'personal_metadata' || job.jobKind === 'personal_review')
    )
    if (selectedGameId.value === gameId && !hasBackgroundJob) {
      const remainingProgress = { ...personalSyncProgressByKey.value }
      delete remainingProgress[progressKey]
      personalSyncProgressByKey.value = remainingProgress
    }
  }
}

function requestSectionPublicSync(target: PersonalSyncTarget): void {
  sectionSyncMenuOpen.value = null
  if (syncTargetState(target)?.catalogSource === 'personal_data') {
    pendingPublicSourceSwitch.value = target
    return
  }
  void runSync('public_schedule', target)
}

async function confirmPublicSourceSwitch(): Promise<void> {
  const target = pendingPublicSourceSwitch.value
  pendingPublicSourceSwitch.value = null
  if (target) await runSync('public_schedule', target)
}

function itemsFor(categories: ChecklistCategory[]): ChecklistItem[] {
  return items.value.filter(
    (item) =>
      categories.includes(item.category) &&
      (!showIncompleteOnly.value || !item.completed) &&
      (
        !activityTagFilter.value ||
        item.category !== 'limited_event' ||
        item.activityTags.includes(activityTagFilter.value)
      )
  ).sort((left, right) => compareChecklistItems(left, right, clockNow.value))
}

function panelItems(panel: ChecklistPanel): ChecklistTreeRow[] {
  const visible = itemsFor(panel.categories)
  if (panel.section !== 'exploration') {
    return visible.map((item) => ({
      item,
      depth: 0,
      hasChildren: false,
      displayProgressPercent: item.progressPercent
    }))
  }
  return buildMapTreeRows(
    visible,
    collapsedMapKeys.value,
    items.value.filter((item) => item.category === 'exploration')
  )
}

function panelItemColumns(panel: ChecklistPanel): ChecklistTreeRow[][] {
  const rows = panelItems(panel)
  return rows.length === 0 ? [] : [rows]
}

function toggleMapBranch(item: ChecklistItem): void {
  const key = item.remoteKey ?? item.id
  const next = new Set(collapsedMapKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  collapsedMapKeys.value = next
  collapsedMapKeysByGame.set(selectedGameId.value, new Set(next))
}

function activateChecklistItem(
  item: ChecklistItem,
  section: ChecklistSection,
  hasChildren: boolean
): void {
  if (section === 'exploration' && hasChildren) {
    toggleMapBranch(item)
    return
  }
  openEdit(item)
}

function isPersistentItem(item: ChecklistItem): boolean {
  return [
    `${item.gameId}:main_quest`,
    `${item.gameId}:side_quest`,
    `${item.gameId}:weekly`
  ].includes(item.id)
}

function openCreate(category: ChecklistCategory): void {
  editingItem.value = null
  form.category = category
  form.title = ''
  form.activityTags = ''
  form.progressPercent = null
  form.parentTitle = ''
  form.startsAt = ''
  form.endsAt = ''
  form.resetRule = category === 'weekly' ? '每周一重置' : ''
  form.resetWeekday = 1
  form.modeKey = ''
  editorOpen.value = true
}

function openEdit(item: ChecklistItem): void {
  editingItem.value = item
  form.category = item.category
  form.title = item.title
  form.activityTags = item.activityTags.join('、')
  form.progressPercent = item.progressPercent
  form.parentTitle = item.parentTitle ?? ''
  form.startsAt = toLocalDateTime(item.startsAt)
  form.endsAt = toLocalDateTime(item.endsAt)
  form.resetRule = item.resetRule ?? ''
  form.resetWeekday = item.category === 'weekly' ? 1 : item.resetWeekday ?? 1
  form.modeKey = item.modeKey ?? ''
  editorOpen.value = true
}

async function saveItem(): Promise<void> {
  if (!form.title.trim() || saving.value) return
  saving.value = true
  errorMessage.value = ''
  try {
    const isTimed = ['limited_event', 'endgame'].includes(form.category)
    const isWeekly = form.category === 'weekly'
    const isVersionTask = ['main_quest', 'side_quest'].includes(form.category)
    const common: Omit<CreateChecklistItemInput, 'gameId'> = {
      category: form.category,
      title: form.title,
      activityTags: form.category === 'limited_event'
        ? parseActivityTags(form.activityTags)
        : [],
      progressPercent: form.category === 'exploration' ? normalizeProgress(form.progressPercent) : null,
      parentTitle: form.category === 'exploration' ? form.parentTitle.trim() || null : null,
      startsAt: isWeekly || isVersionTask ? undefined : isTimed ? toIsoOrNull(form.startsAt) : null,
      endsAt: isWeekly || isVersionTask ? undefined : isTimed ? toIsoOrNull(form.endsAt) : null,
      resetRule: isWeekly
        ? `每${weekdayLabels[form.resetWeekday]}重置`
        : form.category === 'endgame'
          ? form.resetRule.trim() || null
          : null,
      scheduleKind: isVersionTask
        ? undefined
        : isWeekly
        ? 'weekly'
        : form.category === 'limited_event'
          ? 'fixed_window'
          : form.category === 'endgame'
            ? 'remote_schedule'
            : null,
      resetWeekday: isWeekly ? 1 : null,
      timeZone: isVersionTask ? undefined : isWeekly ? 'Asia/Shanghai' : null,
      modeKey: form.category === 'endgame' ? form.modeKey.trim() || null : null,
      recurrenceRule: null
    }
    const saved = editingItem.value
      ? await window.gacha.updateChecklistItem({ id: editingItem.value.id, ...common })
      : await window.gacha.createChecklistItem({ gameId: selectedGameId.value, ...common })

    const index = items.value.findIndex((item) => item.id === saved.id)
    if (index >= 0) items.value[index] = saved
    else items.value.push(saved)
    editorOpen.value = false
  } catch (error) {
    showError(error)
  } finally {
    saving.value = false
  }
}

async function toggleCompleted(item: ChecklistItem): Promise<void> {
  const scrollTop = workspaceElement.value?.scrollTop ?? 0
  const scrollLeft = workspaceElement.value?.scrollLeft ?? 0
  try {
    const updatedItems = await window.gacha.setChecklistCompletion(item.id, !item.completed)
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    for (const updated of updatedItems) {
      const index = items.value.findIndex((candidate) => candidate.id === updated.id)
      if (index >= 0) items.value[index] = updated
    }
    await nextTick()
    const restoreScrollPosition = (): void => {
      workspaceElement.value?.scrollTo({
        top: scrollTop,
        left: scrollLeft,
        behavior: 'auto'
      })
    }
    restoreScrollPosition()
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    restoreScrollPosition()
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
    restoreScrollPosition()
  } catch (error) {
    showError(error)
  }
}

async function archiveItem(item: ChecklistItem): Promise<void> {
  if (!window.confirm(`确定删除“${item.title}”吗？`)) return
  try {
    await window.gacha.archiveChecklistItem(item.id)
    items.value = items.value.filter((candidate) => candidate.id !== item.id)
    archivedItems.value.unshift(item)
    editorOpen.value = false
  } catch (error) {
    showError(error)
  }
}

async function archiveCompletedSection(
  section: ChecklistSection,
  categories: ChecklistCategory[],
  sectionTitle: string
): Promise<void> {
  const completedItems = items.value.filter(
    (item) => categories.includes(item.category) && item.completed && item.source === 'manual' && !isPersistentItem(item)
  )
  if (completedItems.length === 0) return
  if (!window.confirm(`确定删除“${sectionTitle}”中的 ${completedItems.length} 个已完成事项吗？`)) return

  try {
    await window.gacha.archiveCompletedSection({ gameId: selectedGameId.value, section })
    await Promise.all([loadItems(), loadArchivedItems()])
  } catch (error) {
    showError(error)
  }
}

async function restoreItem(item: ChecklistItem): Promise<void> {
  try {
    const restored = await window.gacha.restoreChecklistItem(item.id)
    archivedItems.value = archivedItems.value.filter((candidate) => candidate.id !== item.id)
    items.value.push(restored)
  } catch (error) {
    showError(error)
  }
}

async function emptyRecycleBin(): Promise<void> {
  try {
    const deleted = await window.gacha.emptyRecycleBin(selectedGameId.value)
    if (deleted > 0) archivedItems.value = []
  } catch (error) {
    showError(error)
  }
}

function normalizeProgress(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  return Math.min(100, Math.max(0, Number(value)))
}

function parseActivityTags(value: string): string[] {
  return [...new Set(value
    .split(/[、,，]/)
    .map((tag) => tag.trim())
    .filter(Boolean))]
    .slice(0, 5)
}

function toLocalDateTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function toIsoOrNull(value: string): string | null {
  return value ? new Date(value).toISOString() : null
}

function countdown(value: string, prefix = '剩余'): string {
  const diff = new Date(value).getTime() - clockNow.value
  if (diff <= 0) return '已到期'
  const days = Math.floor(diff / 86_400_000)
  const hours = Math.floor((diff % 86_400_000) / 3_600_000)
  const minutes = Math.max(0, Math.floor((diff % 3_600_000) / 60_000))
  if (days > 0) return `${prefix} ${days} 天 ${hours} 小时`
  if (hours > 0) return `${prefix} ${hours} 小时 ${minutes} 分钟`
  return `${prefix} ${minutes} 分钟`
}

function versionRemainingForGame(gameId: GameId): string | null {
  return formatGameVersionRemaining(gameVersionEndsAt(gameId), clockNow.value)
}

function gameVersionEndsAt(gameId: GameId): string | null {
  return gameVersionSummaries.value.find((summary) => summary.gameId === gameId)?.endsAt ?? null
}

function versionDeadlineToneForGame(gameId: GameId): ReturnType<typeof gameVersionDeadlineTone> {
  return gameVersionDeadlineTone(gameVersionEndsAt(gameId), clockNow.value)
}

function isExpired(value: string): boolean {
  return new Date(value).getTime() <= clockNow.value
}

function isUrgentDeadline(value: string): boolean {
  return isGameVersionDeadlineUrgent(value, clockNow.value)
}

function isUpcoming(value: string): boolean {
  return new Date(value).getTime() > clockNow.value
}

function formatLocalTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(value))
}

function formatFileSize(value: number): string {
  if (value < 1024) return `${value} B`
  return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
}

function startOfCurrentWeek(): Date {
  const date = new Date()
  const day = date.getDay() || 7
  date.setDate(date.getDate() - day + 1)
  date.setHours(0, 0, 0, 0)
  return date
}

function showError(error: unknown): void {
  errorMessage.value = error instanceof Error ? error.message : '操作失败，请重试'
}
</script>

<template>
  <main class="app-shell" @click="globalSyncMenuOpen = false; sectionSyncMenuOpen = null; activityTagMenuOpen = false">
    <aside class="sidebar">
      <div class="brand">
        <img class="brand-mark" :src="appIcon" alt="" aria-hidden="true">
        Gtask
      </div>
      <button class="overview active" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
        总览
      </button>
      <p class="section-label">我的游戏</p>
      <nav class="game-list" aria-label="支持的游戏">
        <button
          v-for="game in visibleGames"
          :key="game.id"
          class="game-button"
          :class="{ selected: selectedGameId === game.id }"
          :style="{ '--game-accent': game.accent }"
          type="button"
          :aria-current="selectedGameId === game.id ? 'page' : undefined"
          @click="selectedGameId = game.id"
        >
          <img class="game-icon" :src="gameIcons[game.id]" alt="" aria-hidden="true">
          <span class="game-name">{{ game.name }}</span>
          <small
            v-if="versionRemainingForGame(game.id)"
            class="game-version-remaining"
            :class="versionDeadlineToneForGame(game.id)"
          >
            {{ versionRemainingForGame(game.id) }}
          </small>
        </button>
      </nav>
      <div class="sidebar-footer">
        <button type="button" @click="recycleBinOpen = true">
          <span class="sidebar-action-label">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>
            回收站
          </span>
          <span class="sidebar-action-count">{{ archivedItems.length }}</span>
        </button>
        <button type="button" @click="openSettings">
          <span class="sidebar-action-label">
            <svg class="settings-sidebar-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4A2 2 0 0 0 4 9.9l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/></svg>
            设置
          </span>
        </button>
      </div>
    </aside>

    <section ref="workspaceElement" class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">本地任务总览</p>
          <h1>{{ selectedGame?.name ?? 'Gtask' }}</h1>
        </div>
        <div v-if="!loading && !restoringGameView" class="topbar-actions">
          <button
            class="toolbar-button incomplete-filter-button"
            :class="{ active: showIncompleteOnly }"
            type="button"
            :aria-pressed="showIncompleteOnly"
            @click="showIncompleteOnly = !showIncompleteOnly"
          >
            <span>只看未完成</span>
            <svg class="incomplete-filter-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 3.25h11L8.75 7.5v5.25h-1.5V7.5L2.5 3.25Z" />
            </svg>
          </button>
          <div class="dropdown global-sync-dropdown" @click.stop>
            <button
              class="toolbar-button global-sync-button"
              type="button"
              aria-haspopup="menu"
              :aria-expanded="globalSyncMenuOpen"
              :disabled="globalSyncBusy"
              @click="globalSyncMenuOpen = !globalSyncMenuOpen"
            >
              <span>全局同步</span>
              <svg class="dropdown-chevron global-sync-chevron" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m4 6 4 4 4-4" />
              </svg>
            </button>
            <div v-if="globalSyncMenuOpen" class="dropdown-menu global-sync-menu" role="menu">
              <button
                role="menuitem"
                type="button"
                :disabled="personalSyncTargets.length === 0 || hasActivePersonalSync"
                @click="runPersonalSyncBatch()"
              >
                <strong>同步个人数据</strong>
                <small>按版块依次读取官方进度</small>
              </button>
              <button
                role="menuitem"
                type="button"
                :disabled="!aiScheduleAvailable || hasActivePersonalSync"
                @click="runGlobalPublicSync()"
              >
                <strong>同步公开数据</strong>
                <small>保留正在使用的个人数据版块</small>
              </button>
            </div>
          </div>
          <span
            class="sync-indicator"
            :class="syncStateClass(globalSyncState)"
            :title="syncStateTimestamp(globalSyncState)
              ? `同步时间：${new Date(syncStateTimestamp(globalSyncState)!).toLocaleString()}`
              : '尚未完成全局同步'"
          >
            <strong>全局清单 · {{ syncStateLabel(globalSyncState) }}<template v-if="globalSourceLabel === '混合来源'"> · 混合来源</template></strong>
            <time v-if="syncStateTimestamp(globalSyncState)">{{ formatSyncTimestamp(syncStateTimestamp(globalSyncState)!) }}</time>
          </span>
        </div>
      </header>

      <p v-if="!loading && !restoringGameView && errorMessage" class="error-banner" role="alert">{{ errorMessage }}</p>
      <div v-if="!loading && !restoringGameView && liveSyncProgress.length" class="sync-progress-stack" aria-live="polite">
        <article
          v-for="progress in liveSyncProgress"
          :key="`${progress.source}:${progress.target}`"
          class="sync-progress-card"
          :class="{ stalled: syncProgressStalled(progress), verification: progress.status === 'verification_required' }"
        >
          <div class="sync-progress-main">
            <div class="sync-progress-heading">
              <strong>{{ syncProgressTitle(progress) }}</strong>
              <span>{{ syncProgressPhaseLabels[progress.phase] }}</span>
              <b v-if="syncProgressCount(progress)">{{ syncProgressCount(progress) }}</b>
            </div>
            <p>{{ syncProgressMessage(progress) }}</p>
            <div v-if="syncProgressPercent(progress) !== null" class="sync-progress-track" aria-hidden="true">
              <i :style="{ width: `${syncProgressPercent(progress)}%` }"></i>
            </div>
            <small :class="{ warning: syncProgressStalled(progress) }">
              {{ syncProgressStalled(progress) && progress.status === 'running'
                ? `进度暂未变化 · ${syncProgressAge(progress)}`
                : syncProgressAge(progress) }}
            </small>
          </div>
          <button
            class="sync-cancel-button"
            type="button"
            :disabled="isCancellingSync(progress)"
            @click="cancelSync(progress)"
          >
            {{ isCancellingSync(progress) ? '取消中…' : '取消同步' }}
          </button>
        </article>
        <aside v-if="showCodexProxyWarning" class="codex-proxy-warning" role="status">
          <div>
            <strong>Codex 连接反复重试</strong>
            <p>{{ CODEX_PROXY_WARNING }}</p>
          </div>
          <div class="codex-proxy-actions">
            <button
              v-if="codexRepairStage === 'none'"
              type="button"
              :disabled="codexRepairBusy"
              @click="repairCodexConnection('proxy')"
            >
              {{ codexRepairBusy ? '正在重连…' : '显式使用当前代理' }}
            </button>
            <button
              v-if="codexRepairStage === 'proxy_applied'"
              type="button"
              :disabled="codexRepairBusy"
              @click="repairCodexConnection('https')"
            >
              {{ codexRepairBusy ? '正在切换…' : '改用 HTTPS' }}
            </button>
            <button type="button" @click="copyCodexProxyRepairPrompt">
              {{ codexProxyPromptCopied ? '已复制' : '复制网络排查提示词' }}
            </button>
            <button type="button" class="secondary-button" @click="continueCodexSyncWithoutProxyChange">
              继续同步
            </button>
          </div>
        </aside>
      </div>
      <div v-if="!loading && !restoringGameView && syncNotice" class="sync-banner" :class="syncNotice.status" aria-live="polite">
        <span>{{ syncNotice.message }}</span>
        <button
          v-if="syncNoticeCredentialProvider"
          type="button"
          @click="openCredentialSettings(syncNoticeCredentialProvider)"
        >前往登录</button>
      </div>
      <section v-if="!loading && !restoringGameView" class="summary-grid">
        <article class="summary-card">
          <span class="summary-icon coral" aria-hidden="true">
            <svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" /></svg>
          </span>
          <div><small>未完成</small><strong>{{ incompleteCount }}<em> 项</em></strong></div>
        </article>
        <article class="summary-card">
          <span class="summary-icon gold" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M7 4h10M7 20h10M8 5c0 4 4 4.2 4 7s-4 3-4 7M16 5c0 4-4 4.2-4 7s4 3 4 7" />
            </svg>
          </span>
          <div><small>即将到期</small><strong>{{ expiringCount }}<em> 项</em></strong></div>
        </article>
        <article class="summary-card">
          <span class="summary-icon green" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="m6.5 12.5 3.5 3.5 7.5-8" /></svg>
          </span>
          <div><small>本周完成</small><strong>{{ completedCount }}<em> 项</em></strong></div>
        </article>
      </section>

      <section
        v-if="loading || restoringGameView"
        class="panel centered"
        role="status"
        aria-live="polite"
      >{{ restoringGameView ? '正在切换游戏…' : '正在读取本地清单…' }}</section>
      <div
        v-else
        class="checklist-content-frame"
      >
        <TransitionGroup
          name="panel-flow"
          tag="section"
          class="content-grid"
          :class="{
            'motion-suppressed': draggingPanelSection !== null || globalSyncBusy || liveSyncProgress.length > 0
          }"
          :key="selectedGameId"
        >
          <article
            v-for="panel in visiblePanels"
            :key="panel.section"
            class="panel checklist-card"
            :data-panel-section="panel.section"
            :class="[
              `panel-${panel.section}`,
              {
                'panel-dragging': draggingPanelSection === panel.section,
                'panel-drop-before': panelDropTarget?.section === panel.section && panelDropTarget.position === 'before',
                'panel-drop-after': panelDropTarget?.section === panel.section && panelDropTarget.position === 'after'
              }
            ]"
          >
              <div class="section-header">
                <button
                  class="panel-drag-handle"
                  type="button"
                  :aria-label="`拖动调整${panel.title}的顺序；按 Alt+上、下方向键也可移动`"
                  :aria-pressed="draggingPanelSection === panel.section"
                  title="拖动调整版块顺序"
                  @pointerdown="beginPanelDrag($event, panel.section)"
                  @pointermove="movePanelDrag"
                  @pointerup="finishPanelDrag"
                  @pointercancel="cancelPanelDrag"
                  @keydown.alt.up.prevent="movePanelByKeyboard(panel.section, -1)"
                  @keydown.alt.down.prevent="movePanelByKeyboard(panel.section, 1)"
                ><span></span><span></span><span></span><span></span><span></span><span></span></button>
                <div class="section-title">
                  <h2>
                    <span class="panel-icon" :class="`panel-icon-${panel.section}`" aria-hidden="true">
                      <svg v-if="panel.section === 'tasks'" viewBox="0 0 24 24"><path d="M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>
                      <svg v-else-if="panel.section === 'events'" viewBox="0 0 24 24"><path d="M12 3v18M3 12h18"/><path d="M5.6 5.6 18.4 18.4M18.4 5.6 5.6 18.4"/><circle cx="12" cy="12" r="4"/></svg>
                      <svg v-else-if="panel.section === 'cycles'" viewBox="0 0 24 24"><path d="M20 8a8 8 0 1 0 .3 7"/><path d="M20 3v5h-5"/><path d="M12 7v5l3 2"/></svg>
                      <svg v-else-if="panel.section === 'exploration'" viewBox="0 0 24 24"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></svg>
                      <svg v-else viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="m8 9 2 2 4-4M8 15h8"/></svg>
                    </span>
                    <span class="section-title-text">{{ panel.title }}</span>
                  </h2>
                  <span
                    v-if="panel.syncTarget"
                    class="section-sync-indicator"
                    :class="syncStateClass(syncTargetState(panel.syncTarget))"
                    :title="syncStateTimestamp(syncTargetState(panel.syncTarget))
                      ? `同步时间：${new Date(syncStateTimestamp(syncTargetState(panel.syncTarget))!).toLocaleString()}`
                      : '该版块尚未同步'"
                  >
                    {{ syncStateLabel(syncTargetState(panel.syncTarget)) }}
                    <time v-if="syncStateTimestamp(syncTargetState(panel.syncTarget))">
                      {{ formatSyncTimestamp(syncStateTimestamp(syncTargetState(panel.syncTarget))!) }}
                    </time>
                  </span>
                </div>
                <div class="section-actions">
                  <button
                    v-if="panel.syncTarget === 'tasks'"
                    class="section-sync-button"
                    type="button"
                    :disabled="!aiScheduleAvailable || isSyncRequestActive('public_schedule', 'tasks') || hasActivePublicSyncForTarget('tasks')"
                    @click="runSync('public_schedule', 'tasks')"
                  >↻ 版更校时</button>
                  <div v-else-if="panel.syncTarget" class="dropdown" @click.stop>
                    <button
                      class="section-sync-button"
                      type="button"
                      aria-haspopup="menu"
                      :aria-expanded="sectionSyncMenuOpen === panel.section"
                      @click="sectionSyncMenuOpen = sectionSyncMenuOpen === panel.section ? null : panel.section"
                    >
                      <span>↻ 同步</span>
                      <svg class="dropdown-chevron" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m4 6 4 4 4-4" />
                      </svg>
                    </button>
                    <div v-if="sectionSyncMenuOpen === panel.section" class="dropdown-menu section-sync-menu" role="menu">
                      <button
                        role="menuitem"
                        type="button"
                        :disabled="!aiScheduleAvailable || isSyncRequestActive('public_schedule', panel.syncTarget) || hasActivePublicSyncForTarget(panel.syncTarget) || hasActivePersonalSyncForTarget(panel.syncTarget as PersonalSyncTarget)"
                        @click="requestSectionPublicSync(panel.syncTarget as PersonalSyncTarget)"
                      >同步公开数据</button>
                      <button
                        v-if="personalSyncTargets.includes(panel.syncTarget)"
                        role="menuitem"
                        type="button"
                        :disabled="hasActivePersonalSyncForTarget(panel.syncTarget as PersonalSyncTarget) || hasActivePublicSyncForTarget(panel.syncTarget)"
                        @click="runPersonalSync(panel.syncTarget)"
                      >同步个人数据</button>
                    </div>
                  </div>
                  <button
                    v-if="panel.allowClear === true"
                    class="clear-completed-button"
                    type="button"
                    :disabled="!items.some((item) => panel.categories.includes(item.category) && item.completed && item.source === 'manual' && !isPersistentItem(item))"
                    @click="archiveCompletedSection(panel.section, panel.categories, panel.title)"
                  >删除已完成</button>
                </div>
              </div>
              <div
                v-if="panel.syncTarget && progressForTarget(panel.syncTarget)"
                class="section-live-progress"
                :class="{ stalled: syncProgressStalled(progressForTarget(panel.syncTarget)!) }"
              >
                <span class="section-live-dot"></span>
                <strong>{{ syncProgressPhaseLabels[progressForTarget(panel.syncTarget)!.phase] }}</strong>
                <span>{{ syncProgressMessage(progressForTarget(panel.syncTarget)!) }}</span>
                <b v-if="syncProgressCount(progressForTarget(panel.syncTarget)!)">
                  {{ syncProgressCount(progressForTarget(panel.syncTarget)!) }}
                </b>
                <button
                  class="section-sync-cancel"
                  type="button"
                  :disabled="isCancellingSync(progressForTarget(panel.syncTarget)!)"
                  @click="cancelSync(progressForTarget(panel.syncTarget)!)"
                >
                  {{ isCancellingSync(progressForTarget(panel.syncTarget)!) ? '取消中…' : '取消' }}
                </button>
              </div>
              <div
                v-if="panel.section === 'events'"
                class="activity-tag-filter"
                @click.stop
              >
                <div v-if="activityTagOptions.length > 0" class="activity-filter-control">
                  <span>玩法筛选</span>
                  <div class="dropdown activity-filter-dropdown">
                    <button
                      class="activity-filter-button"
                      type="button"
                      aria-haspopup="menu"
                      :aria-expanded="activityTagMenuOpen"
                      @click="activityTagMenuOpen = !activityTagMenuOpen"
                    >
                      <span>{{ activityTagFilter || '全部玩法' }}</span>
                      <svg class="dropdown-chevron" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m4 6 4 4 4-4" />
                      </svg>
                    </button>
                    <div v-if="activityTagMenuOpen" class="dropdown-menu activity-filter-menu" role="menu">
                      <button
                        role="menuitemradio"
                        type="button"
                        :aria-checked="activityTagFilter === ''"
                        :class="{ selected: activityTagFilter === '' }"
                        @click="activityTagFilter = ''; activityTagMenuOpen = false"
                      >全部玩法</button>
                      <button
                        v-for="tag in activityTagOptions"
                        :key="tag"
                        role="menuitemradio"
                        type="button"
                        :aria-checked="activityTagFilter === tag"
                        :class="{ selected: activityTagFilter === tag }"
                        @click="activityTagFilter = tag; activityTagMenuOpen = false"
                      >{{ tag }}</button>
                    </div>
                  </div>
                </div>
              </div>
              <div class="item-list panel-item-columns">
                <TransitionGroup
                  v-for="(itemColumn, itemColumnIndex) in panelItemColumns(panel)"
                  :key="itemColumnIndex"
                  name="checklist-flow"
                  tag="div"
                  class="item-list-column"
                  :class="{ 'motion-suppressed': globalSyncBusy || liveSyncProgress.length > 0 }"
                >
                  <div
                    v-for="row in itemColumn"
                    :key="row.item.id"
                    class="checklist-row"
                    :class="{
                      completed: row.item.completed,
                      'map-tree-row': panel.section === 'exploration'
                    }"
                    :style="panel.section === 'exploration' ? { '--tree-depth': row.depth } : undefined"
                  >
                  <button
                    v-if="panel.section === 'exploration' && row.hasChildren"
                    class="map-tree-toggle"
                    type="button"
                    :aria-label="collapsedMapKeys.has(row.item.remoteKey ?? row.item.id) ? '展开子区域' : '收起子区域'"
                    @click="toggleMapBranch(row.item)"
                  >{{ collapsedMapKeys.has(row.item.remoteKey ?? row.item.id) ? '›' : '⌄' }}</button>
                  <span v-else-if="panel.section === 'exploration'" class="map-tree-spacer"></span>
                  <button
                    class="check-button"
                    type="button"
                    :aria-label="row.item.completed ? '标为未完成' : '标为完成'"
                    @click="toggleCompleted(row.item)"
                  >
                    {{ row.item.completed ? '✓' : '' }}
                  </button>
                  <button
                    class="item-main"
                    type="button"
                    :title="panel.section === 'exploration' && row.hasChildren
                      ? (collapsedMapKeys.has(row.item.remoteKey ?? row.item.id) ? '展开子区域' : '收起子区域')
                      : row.item.title"
                    @click="activateChecklistItem(row.item, panel.section, row.hasChildren)"
                  >
                    <span class="item-title">{{ row.item.title }}</span>
                    <span class="item-details">
                      <b>{{ categoryLabels[row.item.category] }}</b>
                      <span
                        v-for="tag in row.item.activityTags"
                        :key="tag"
                        class="activity-tag"
                      >{{ tag }}</span>
                      <span v-if="row.item.category === 'exploration' && row.displayProgressPercent !== null">
                        {{ row.displayProgressPercent }}%
                      </span>
                      <span
                        v-if="row.item.resetRule && (row.item.category === 'weekly' || row.item.source === 'manual')"
                        class="reset-detail"
                      >{{ row.item.resetRule }}</span>
                      <span
                        v-if="row.item.source !== 'manual' && row.item.lastSyncedAt"
                        class="source-detail"
                        :title="`${row.item.source === 'public_schedule' ? '公开数据' : '个人数据'} · 同步于 ${formatLocalTime(row.item.lastSyncedAt)}${row.item.sourceUrl ? ` · ${row.item.sourceUrl}` : ''}`"
                      >
                        {{ row.item.source === 'public_schedule' ? '公开数据' : '个人数据' }}
                      </span>
                    </span>
                    <span v-if="row.item.startsAt && isUpcoming(row.item.startsAt)" class="item-timing deadline upcoming">{{ countdown(row.item.startsAt, '距离开始') }}</span>
                    <span
                      v-else-if="row.item.endsAt"
                      class="item-timing deadline"
                      :class="{ expired: isExpired(row.item.endsAt), urgent: isUrgentDeadline(row.item.endsAt) }"
                    >{{ countdown(row.item.endsAt) }}</span>
                  </button>
                    <button class="more-button" type="button" aria-label="编辑" @click="openEdit(row.item)">⋮</button>
                  </div>
                </TransitionGroup>
                <p v-if="panelItems(panel).length === 0" class="empty-text">暂无事项</p>
              </div>
              <button v-if="panel.allowCreate !== false" class="add-button" type="button" @click="openCreate(panel.defaultCategory)">
                <span class="add-button-label"><span class="add-button-icon" aria-hidden="true">＋</span>新增{{ panel.createLabel ?? panel.title }}</span>
              </button>
          </article>
          <p v-if="visiblePanels.length === 0" key="filtered-empty" class="filtered-empty-state">
            当前没有未完成事项
          </p>
        </TransitionGroup>
      </div>

      <footer v-if="appInfo" class="dev-footer">v{{ appInfo.version }} · 数据仅保存在本机</footer>
    </section>

    <div v-if="editorOpen" class="modal-backdrop" @click.self="editorOpen = false">
      <form class="editor-modal" role="dialog" aria-modal="true" aria-label="事项编辑器" @submit.prevent="saveItem">
        <div class="modal-header">
          <div><p class="eyebrow">{{ selectedGame?.name }}</p><h2>{{ editingItem ? '编辑事项' : '新增事项' }}</h2></div>
          <button class="close-button" type="button" aria-label="关闭事项编辑器" @click="editorOpen = false">×</button>
        </div>

        <label>事项名称<input v-model="form.title" maxlength="100" autofocus :placeholder="editorExamples.titles[form.category]" /></label>
        <label>分类
          <select v-model="form.category" :disabled="editingItem ? ['main_quest', 'side_quest'].includes(editingItem.category) || isPersistentItem(editingItem) : false">
            <option v-for="[category, label] in editorCategories" :key="category" :value="category">{{ label }}</option>
          </select>
        </label>
        <label v-if="form.category === 'limited_event'">
          玩法标签（最多5个）
          <input
            v-model="form.activityTags"
            maxlength="120"
            placeholder="例如：战斗、跑酷、解谜"
          />
        </label>
        <template v-if="form.category === 'exploration'">
          <div class="form-grid">
            <label>上级区域（可选）<input v-model="form.parentTitle" maxlength="200" :placeholder="editorExamples.parentTitle" /></label>
            <label>探索进度（%）<input v-model.number="form.progressPercent" type="number" min="0" max="100" /></label>
          </div>
        </template>
        <template v-if="['limited_event', 'endgame'].includes(form.category)">
          <div class="form-grid">
            <label>开始时间<input v-model="form.startsAt" type="datetime-local" /></label>
            <label>结束时间<input v-model="form.endsAt" type="datetime-local" /></label>
          </div>
        </template>
        <label v-if="form.category === 'weekly'">每周重置日
          <input value="周一（固定）" disabled />
        </label>
        <template v-if="form.category === 'endgame'">
          <label>玩法标识<input v-model="form.modeKey" maxlength="200" :placeholder="editorExamples.modeKey" /></label>
          <label>周期说明<input v-model="form.resetRule" maxlength="200" :placeholder="editorExamples.resetRule" /></label>
        </template>
        <div v-if="editingItem?.sourceUrl" class="source-box">
          <div><span>同步来源</span><small>{{ editingItem.sourceUrl }}</small></div>
          <button class="secondary-button" type="button" @click="openExternalSource(editingItem.sourceUrl)">查看来源</button>
        </div>

        <div class="modal-actions">
          <button v-if="editingItem?.source === 'manual' && !isPersistentItem(editingItem)" class="danger-button" type="button" @click="archiveItem(editingItem)">删除</button>
          <div class="modal-actions-right">
            <button class="secondary-button" type="button" @click="editorOpen = false">取消</button>
            <button class="primary-button" type="submit" :disabled="saving || !form.title.trim()">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </div>
      </form>
    </div>

    <div v-if="recycleBinOpen" class="modal-backdrop" @click.self="recycleBinOpen = false">
      <section class="editor-modal recycle-modal" role="dialog" aria-modal="true" aria-label="回收站">
        <div class="modal-header">
          <div><p class="eyebrow">{{ selectedGame?.name }}</p><h2>回收站</h2></div>
          <div class="recycle-header-actions">
            <button
              class="danger-button compact"
              type="button"
              :disabled="archivedItems.length === 0"
              @click="emptyRecycleBin"
            >清空回收站</button>
            <button class="close-button" type="button" aria-label="关闭回收站" @click="recycleBinOpen = false">×</button>
          </div>
        </div>
        <p class="recycle-hint">手动删除的事项会保留在本机，便于随时恢复。</p>
        <div class="recycle-list">
          <div v-for="item in archivedItems" :key="item.id" class="recycle-row">
            <div>
              <strong>{{ item.title }}</strong>
              <span>{{ categoryLabels[item.category] }} · 手动事项</span>
            </div>
            <button class="secondary-button" type="button" @click="restoreItem(item)">恢复</button>
          </div>
          <p v-if="archivedItems.length === 0" class="empty-text">回收站为空</p>
        </div>
      </section>
    </div>

    <div
      v-if="pendingPublicSourceSwitch"
      class="modal-backdrop source-switch-backdrop"
      @click.self="pendingPublicSourceSwitch = null"
    >
      <section class="source-switch-modal" role="dialog" aria-modal="true" aria-labelledby="source-switch-title">
        <div class="modal-header">
          <div>
            <p class="eyebrow">切换数据来源</p>
            <h2 id="source-switch-title">改用公开数据？</h2>
          </div>
          <button class="close-button" type="button" aria-label="取消" @click="pendingPublicSourceSwitch = null">×</button>
        </div>
        <p>{{ pendingPublicSourceSwitchLabel }}版块当前使用个人数据。继续后，该版块会切换为公开清单，完成状态需要手动维护。</p>
        <div class="source-switch-actions">
          <button class="toolbar-button" type="button" @click="pendingPublicSourceSwitch = null">取消</button>
          <button class="primary-button" type="button" @click="confirmPublicSourceSwitch">切换并同步</button>
        </div>
      </section>
    </div>

    <div
      v-if="!loading && !restoringGameView && needsInitialSync"
      class="modal-backdrop onboarding-backdrop"
    >
      <section class="onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div class="modal-header onboarding-header">
          <div>
            <p class="eyebrow">{{ selectedGame?.name }}</p>
            <h2 id="onboarding-title">建立你的第一份清单</h2>
            <p>选择一种数据来源，之后仍可在每个版块随时切换。</p>
          </div>
          <button class="close-button" type="button" aria-label="稍后再说" @click="dismissInitialSyncGuide()">×</button>
        </div>
        <div v-if="!aiScheduleAgent?.codexPluginInstalled" class="onboarding-plugin-guide">
          <div>
            <strong>连接 Codex 同步插件</strong>
            <span>同步公开数据需要插件；同步个人数据时也会用它补充和校正清单信息。</span>
          </div>
          <button class="secondary-button" type="button" @click="openCodexPlugin">安装插件</button>
        </div>
        <div class="onboarding-choice-grid">
          <button
            class="onboarding-choice recommended"
            type="button"
            :disabled="onboardingBusy"
            @click="startInitialPersonalSync"
          >
            <span class="onboarding-choice-label">推荐</span>
            <strong>同步个人数据</strong>
            <small>需要登录 {{ personalPlatform }}。活动、周期事项和地图探索会按版块依次同步。</small>
            <b>{{ onboardingBusy ? '正在处理…' : '使用个人数据开始' }}</b>
          </button>
          <button
            class="onboarding-choice"
            type="button"
            :disabled="onboardingBusy"
            @click="startInitialPublicSync"
          >
            <strong>同步公开数据</strong>
            <small>无需登录。根据公开资料建立清单，进度由你手动维护。</small>
            <b>{{ aiScheduleAvailable ? '使用公开数据开始' : '先连接 Codex' }}</b>
          </button>
        </div>
        <p class="onboarding-note">可随时在各版块切换数据来源，自定义事项不受影响。</p>
        <button class="onboarding-later" type="button" :disabled="onboardingBusy" @click="dismissInitialSyncGuide()">稍后再说</button>
      </section>
    </div>

    <div
      v-if="codexSetupPromptOpen"
      class="modal-backdrop codex-install-backdrop"
      @click.self="dismissCodexSetupPrompt"
    >
      <section class="source-switch-modal codex-install-modal" role="dialog" aria-modal="true" aria-labelledby="codex-install-title">
        <div class="modal-header">
          <div>
            <p class="eyebrow">Codex 同步</p>
            <h2 id="codex-install-title">需要安装同步插件</h2>
          </div>
          <button class="close-button" type="button" aria-label="稍后安装" @click="dismissCodexSetupPrompt">×</button>
        </div>
        <p>{{ codexSetupDescription }}</p>
        <p v-if="codexPluginMessage" class="codex-install-status">{{ codexPluginMessage }}</p>
        <div class="source-switch-actions">
          <button class="toolbar-button" type="button" @click="dismissCodexSetupPrompt">{{ codexSetupDeferLabel }}</button>
          <button class="toolbar-button" type="button" @click="loadAiScheduleAgentStatus">重新检测</button>
          <button class="primary-button" type="button" @click="openCodexPlugin">打开安装页</button>
        </div>
      </section>
    </div>

    <div v-if="settingsOpen" class="modal-backdrop" @click.self="closeSettings">
      <section class="editor-modal recycle-modal settings-modal" role="dialog" aria-modal="true" aria-label="设置">
        <div class="modal-header">
          <div><p class="eyebrow">本机设置</p><h2>设置</h2></div>
          <button class="close-button" type="button" aria-label="关闭设置" @click="closeSettings">×</button>
        </div>
        <h3 class="settings-heading">我的游戏</h3>
        <p class="recycle-hint">隐藏只影响侧栏，数据仍会保留。</p>
        <div class="game-visibility-list">
          <label v-for="game in games" :key="game.id" class="game-visibility-row">
            <span><img class="game-icon" :src="gameIcons[game.id]" alt="" aria-hidden="true">{{ game.name }}</span>
            <input
              type="checkbox"
              :checked="isGameVisible(game.id)"
              :disabled="isGameVisible(game.id) && visibleGames.length === 1"
              :aria-label="`显示 ${game.name}`"
              @change="toggleGameVisibility(game.id)"
            >
          </label>
        </div>
        <h3 class="settings-heading">版块布局</h3>
        <div class="panel-order-setting">
          <div>
            <strong>{{ selectedGame?.name }}</strong>
            <span>在总览中拖动标题旁的手柄调整版块顺序。</span>
          </div>
          <button
            class="secondary-button settings-action-button"
            type="button"
            :disabled="panelOrderIsDefault"
            @click="resetPanelOrder"
          >默认顺序</button>
        </div>
        <h3 class="settings-heading">界面渲染</h3>
        <div class="ai-provider-box rendering-provider-box">
          <label class="codex-strategy-field">
            <span>渲染模式</span>
            <select v-model="renderingModeSelection">
              <option value="compatibility">兼容模式（推荐）· 与游戏同时运行更稳定</option>
              <option value="accelerated">GPU 加速 · 性能优先</option>
            </select>
          </label>
          <div class="codex-runtime-footer">
            <span>{{ renderingModeMessage || (renderingModeState?.active === 'compatibility'
              ? '当前使用软件渲染，可规避部分游戏、驱动或叠加层造成的界面残影。'
              : '当前使用 GPU 加速；若与游戏同时运行时出现残影，请切回兼容模式。') }}</span>
            <button
              class="primary-button settings-action-button"
              type="button"
              :disabled="renderingModeBusy"
              @click="saveRenderingMode"
            >{{ renderingModeBusy ? '保存中…' : renderingModeSelection === renderingModeState?.active ? '确认设置' : '保存并重启' }}</button>
          </div>
        </div>
        <h3 class="settings-heading">Codex 同步</h3>
        <div class="ai-provider-box codex-provider-box">
          <div class="ai-provider-heading">
            <div>
              <strong>Codex 插件</strong>
              <span>{{ !aiScheduleAgent?.codexPluginInstalled
                ? '未安装或未启用'
                : aiScheduleAgent?.connected
                  ? `已连接 · ${aiScheduleAgent.name}`
                  : '已安装' }}</span>
            </div>
          </div>
          <div class="codex-runtime-settings">
            <div class="codex-runtime-grid">
              <label>
                <span>后台模型</span>
                <select v-model="codexWorkerPreferences.model">
                  <option value="inherit">跟随 Codex 默认</option>
                  <option value="gpt-5.6-sol">GPT-5.6-Sol · 准确优先</option>
                  <option value="gpt-5.6-terra">GPT-5.6-Terra · 速度均衡</option>
                  <option value="gpt-5.6-luna">GPT-5.6-Luna · 高速结构化</option>
                </select>
              </label>
              <label>
                <span>推理强度</span>
                <select v-model="codexWorkerPreferences.reasoningEffort">
                  <option value="inherit">跟随 Codex 默认</option>
                  <option value="low">低</option>
                  <option value="medium">中</option>
                  <option value="high">高</option>
                  <option value="xhigh">极高</option>
                  <option value="max">最大</option>
                  <option value="ultra">Ultra</option>
                </select>
              </label>
            </div>
            <div class="codex-runtime-footer">
              <span>{{ codexWorkerPreferencesMessage || '所有后台任务使用这里选择的模型与推理强度。' }}</span>
              <button
                class="primary-button settings-action-button"
                type="button"
                :disabled="codexWorkerPreferencesBusy"
                @click="saveCodexWorkerPreferences"
              >{{ codexWorkerPreferencesBusy ? '保存中…' : '保存设置' }}</button>
            </div>
          </div>
          <div v-if="!aiScheduleAgent?.codexPluginInstalled" class="codex-setup-guide">
            <div class="codex-setup-actions">
              <button class="secondary-button wide-action-button" type="button" @click="openCodexPlugin">安装插件</button>
              <button class="secondary-button" type="button" @click="loadAiScheduleAgentStatus">重新检测</button>
            </div>
          </div>
          <div v-else class="codex-setup-actions">
            <button
              class="secondary-button"
              type="button"
              :disabled="codexPluginBusy"
              @click="updateCodexPlugin"
            >{{ codexPluginBusy ? '正在更新…' : '更新插件' }}</button>
            <button
              class="secondary-button"
              type="button"
              :disabled="codexPluginBusy"
              @click="loadAiScheduleAgentStatus"
            >重新检测</button>
          </div>
          <p v-if="codexPluginMessage" class="codex-plugin-message">{{ codexPluginMessage }}</p>
        </div>
        <h3 class="settings-heading">软件更新</h3>
        <div class="ai-provider-box software-update-box">
          <label class="software-update-toggle">
            <span>
              <strong>启动后自动检查更新</strong>
              <small>后台检查，不影响启动。</small>
            </span>
            <input
              v-model="softwareUpdateSettings.autoCheckEnabled"
              type="checkbox"
              :disabled="softwareUpdateBusy"
              aria-label="启动后自动检查更新"
              @change="saveSoftwareUpdatePreference"
            >
          </label>
          <div class="software-update-footer">
            <span>
              <strong>当前版本 v{{ appInfo?.version ?? '—' }}</strong>
              <small>{{ softwareUpdateMessage || formatUpdateCheckTime(softwareUpdateSettings.lastSuccessfulCheckAt) }}</small>
            </span>
            <button
              class="secondary-button settings-action-button"
              type="button"
              :disabled="softwareUpdateBusy"
              @click="checkSoftwareUpdate"
            >{{ softwareUpdateBusy ? '检查中…' : '检查更新' }}</button>
          </div>
        </div>
        <h3 class="settings-heading data-heading">登录凭据</h3>
        <p class="recycle-hint">登录可选；凭据由 Windows 加密保存在本机。</p>
        <div class="recycle-list">
          <div
            v-for="status in gameCredentialStatuses"
            :key="status.provider"
            class="recycle-row"
            :data-credential-provider="status.provider"
          >
            <div>
              <strong>{{ status.provider === 'miyoushe' ? '米游社' : '库街区' }}</strong>
              <span>{{ status.stored ? `已安全保存 · ${formatLocalTime(status.updatedAt!)}` : '未登录' }}</span>
            </div>
            <div class="credential-actions">
              <button
                v-if="status.provider === 'miyoushe'"
                class="secondary-button"
                type="button"
                :disabled="startingMiyousheLogin"
                @click="startMiyousheLogin"
              >{{ startingMiyousheLogin ? '获取中…' : status.stored ? '重新登录' : '扫码登录' }}</button>
              <button
                v-else
                class="secondary-button"
                type="button"
                @click="openKuroCommunityLogin"
              >{{ status.stored ? '重新登录' : '手机登录' }}</button>
              <button
                class="danger-button"
                type="button"
                :disabled="!status.stored"
                @click="clearCredential(status.provider)"
              >清除凭据</button>
            </div>
          </div>
        </div>
        <h3 class="settings-heading data-heading">本地数据与备份</h3>
        <div class="data-location">
          <span>{{ appInfo?.dataPath }}</span>
          <div class="data-location-actions">
            <button class="secondary-button" type="button" :disabled="backingUp" @click="createBackup">
              {{ backingUp ? '备份中…' : '立即备份' }}
            </button>
            <button class="secondary-button" type="button" @click="openDataDirectory">打开目录</button>
          </div>
        </div>
        <p class="recycle-hint">数据保存在系统“文档\GachaTaskManager”目录，自动保留最近 30 份每日备份。</p>
        <div class="backup-list">
          <div v-for="backup in backups" :key="backup.fileName" class="backup-row">
            <div><strong>{{ backup.fileName }}</strong><span>{{ formatLocalTime(backup.updatedAt) }}</span></div>
            <small>{{ backup.kind === 'daily' ? '每日' : backup.kind === 'manual' ? '手动' : backup.kind === 'pre_restore' ? '恢复前' : '升级前' }} · {{ formatFileSize(backup.sizeBytes) }}</small>
            <button
              class="secondary-button"
              type="button"
              :disabled="Boolean(restoringBackup)"
              :aria-label="`恢复备份 ${backup.fileName}`"
              @click="restoreBackup(backup)"
            >{{ restoringBackup === backup.fileName ? '恢复中…' : '恢复' }}</button>
          </div>
          <p v-if="backups.length === 0" class="empty-text">尚无备份</p>
        </div>
        <p class="settings-note">米游社支持扫码登录，库街区支持手机号登录；凭据仅在本机加密保存。</p>
      </section>
    </div>
    <div v-if="miyousheLoginOpen" class="modal-backdrop login-backdrop" @click.self="closeMiyousheLogin">
      <section class="editor-modal login-modal" role="dialog" aria-modal="true" aria-label="米游社扫码登录">
        <div class="modal-header">
          <div><h2>米游社扫码登录</h2><p>登录凭据仅保存在本机</p></div>
          <button class="close-button" type="button" aria-label="关闭米游社登录" @click="closeMiyousheLogin">×</button>
        </div>
        <div v-if="miyousheLoginState" class="qr-login-content">
          <img
            v-if="miyousheLoginState.qrCodeDataUrl"
            :src="miyousheLoginState.qrCodeDataUrl"
            alt="米游社登录二维码"
            width="280"
            height="280"
          >
          <div v-else class="qr-login-result" :class="miyousheLoginState.status">
            {{ miyousheLoginState.status === 'confirmed' ? '✓' : '!' }}
          </div>
          <strong>{{ miyousheLoginState.message }}</strong>
          <p v-if="miyousheLoginState.status === 'waiting_confirmation'">请回到米游社 App 完成授权，窗口会自动更新。</p>
          <p v-else-if="miyousheLoginState.status === 'confirmed'">现在可以使用“同步个人数据”读取米游社数据。</p>
          <p v-else-if="miyousheLoginState.status === 'expired'">出于安全考虑，二维码不会自动长期续期。</p>
          <p v-else>二维码有效期约 5 分钟，应用不会读取浏览器 Cookie。</p>
        </div>
        <div class="login-actions">
          <button
            v-if="miyousheLoginState?.status === 'expired'"
            class="primary-button"
            type="button"
            @click="startMiyousheLogin"
          >重新获取二维码</button>
          <button class="secondary-button" type="button" @click="closeMiyousheLogin">
            {{ miyousheLoginState?.status === 'confirmed' ? '完成' : '取消' }}
          </button>
        </div>
      </section>
    </div>
    <div v-if="kuroCredentialOpen" class="modal-backdrop login-backdrop" @click.self="closeKuroCommunityLogin">
      <section class="editor-modal kuro-credential-modal" role="dialog" aria-modal="true" aria-label="登录库街区">
        <div class="modal-header">
          <div><h2>登录库街区</h2><p>登录后可同步鸣潮挑战与地图探索进度</p></div>
          <button
            class="close-button"
            type="button"
            aria-label="关闭库街区登录"
            :disabled="kuroCredentialBusy"
            @click="closeKuroCommunityLogin"
          >×</button>
        </div>
        <div class="kuro-credential-form">
          <label v-if="kuroLoginPhase === 'phone'">
            手机号
            <input
              v-model="kuroLoginPhone"
              type="tel"
              inputmode="numeric"
              maxlength="11"
              autocomplete="tel"
              spellcheck="false"
              placeholder="请输入库街区绑定的手机号"
              :disabled="kuroCredentialBusy"
            >
          </label>
          <button
            v-if="kuroLoginPhase === 'phone'"
            class="primary-button"
            type="button"
            :disabled="kuroCredentialBusy || !/^1\d{10}$/.test(kuroLoginPhone.trim())"
            @click="sendKuroCommunitySms"
          >{{ kuroCredentialBusy ? '等待验证…' : '验证并发送短信' }}</button>
          <label v-if="kuroLoginPhase === 'code'">
            短信验证码
            <input
              v-model="kuroLoginCode"
              type="text"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              spellcheck="false"
              placeholder="请输入 6 位验证码"
              :disabled="kuroCredentialBusy"
            >
          </label>
          <button
            v-if="kuroLoginPhase === 'code'"
            class="primary-button"
            type="button"
            :disabled="kuroCredentialBusy || !/^\d{6}$/.test(kuroLoginCode.trim())"
            @click="completeKuroCommunityLogin"
          >{{ kuroCredentialBusy ? '登录中…' : '登录并读取角色' }}</button>
          <label v-if="kuroLoginPhase === 'role'">
            同步角色
            <select v-model="kuroSelectedRoleKey" :disabled="kuroCredentialBusy">
              <option value="" disabled>请选择角色</option>
              <option
                v-for="role in kuroCredentialRoles"
                :key="kuroRoleKey(role)"
                :value="kuroRoleKey(role)"
              >{{ role.roleName }} · {{ role.serverName || role.serverId }} · {{ role.roleId }}</option>
            </select>
          </label>
          <p v-if="kuroCredentialMessage" class="credential-import-message">{{ kuroCredentialMessage }}</p>
          <p class="recycle-hint">验证成功后，登录凭据会加密保存在本机。</p>
        </div>
        <div class="login-actions">
          <button
            v-if="kuroLoginPhase === 'role'"
            class="primary-button"
            type="button"
            :disabled="kuroCredentialBusy || !kuroSelectedRoleKey"
            @click="saveKuroCommunityLogin"
          >{{ kuroCredentialBusy ? '验证中…' : '验证并保存' }}</button>
          <button
            class="secondary-button"
            type="button"
            :disabled="kuroCredentialBusy"
            @click="closeKuroCommunityLogin"
          >取消</button>
        </div>
      </section>
    </div>
    <div
      v-if="draggingPanel && panelDragPreviewStyle"
      class="panel-drag-preview"
      :style="panelDragPreviewStyle"
      aria-hidden="true"
    >
      <span class="panel-drag-preview-grip">
        <span></span><span></span><span></span><span></span><span></span><span></span>
      </span>
      <span class="panel-icon" :class="`panel-icon-${draggingPanel.section}`">
        <svg v-if="draggingPanel.section === 'tasks'" viewBox="0 0 24 24"><path d="M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>
        <svg v-else-if="draggingPanel.section === 'events'" viewBox="0 0 24 24"><path d="M12 3v18M3 12h18"/><path d="M5.6 5.6 18.4 18.4M18.4 5.6 5.6 18.4"/><circle cx="12" cy="12" r="4"/></svg>
        <svg v-else-if="draggingPanel.section === 'cycles'" viewBox="0 0 24 24"><path d="M20 8a8 8 0 1 0 .3 7"/><path d="M20 3v5h-5"/><path d="M12 7v5l3 2"/></svg>
        <svg v-else-if="draggingPanel.section === 'exploration'" viewBox="0 0 24 24"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></svg>
        <svg v-else viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="m8 9 2 2 4-4M8 15h8"/></svg>
      </span>
      <span class="panel-drag-preview-copy">
        <strong>{{ draggingPanel.title }}</strong>
        <small>拖动调整位置</small>
      </span>
    </div>
  </main>
</template>
