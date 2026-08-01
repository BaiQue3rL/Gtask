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
  KuroCommunityRole,
  MiyousheQrLoginState,
  PersonalSyncTarget,
  SemanticReviewSummary,
  SyncResult,
  SyncProgressUpdate,
  SyncScope,
  SyncTarget,
  SyncTargetState,
  SyncSettings
} from '../../shared/contracts'
import { readHiddenGameIds, writeHiddenGameIds } from './game-visibility'
import { kuroRoleKey } from './kuro-role-key'
import { compareChecklistItems } from './checklist-sort'
import { resolveAdaptiveColumnLayout } from './adaptive-column-layout'
import {
  buildMapTreeRows,
  collectMapBranchKeys,
  distributeMapTreeRows,
  type ChecklistTreeRow
} from './map-tree'
import {
  CODEX_PROXY_REPAIR_PROMPT,
  CODEX_PROXY_WARNING,
  isCodexConnectionRetry
} from './codex-proxy-diagnostic'
import { toCodexWorkerPreferencesIpcPayload } from './codex-worker-preferences'
import {
  credentialProviderForSyncResult,
  credentialProviderFromSyncMessage
} from './sync-credential-notice'
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
  syncTarget?: Exclude<SyncTarget, 'all'>
}

const panels: ChecklistPanel[] = [
  { title: '任务', section: 'tasks', categories: ['main_quest', 'side_quest'], defaultCategory: 'side_quest', allowCreate: false, allowClear: false, syncTarget: 'tasks' },
  { title: '活动', section: 'events', categories: ['limited_event'], defaultCategory: 'limited_event', syncTarget: 'events' },
  { title: '周期事项', section: 'cycles', categories: ['weekly', 'endgame'], defaultCategory: 'endgame', syncTarget: 'cycles' },
  { title: '地图探索', section: 'exploration', categories: ['exploration'], defaultCategory: 'exploration', syncTarget: 'exploration' }
]
const personalReviewTargets: PersonalSyncTarget[] = ['events', 'cycles', 'exploration']

const workspaceElement = ref<HTMLElement | null>(null)
const checklistColumnElements: Array<HTMLElement | null> = []
const adaptiveColumnHeight = ref<number | null>(null)
const constrainedColumnIndex = ref<number | null>(null)
let adaptiveResizeObserver: ResizeObserver | null = null
let adaptiveLayoutFrame: number | null = null
const panelColumns: ChecklistPanel[][] = [
  [panels[0], panels[2]],
  [panels[1]],
  [panels[3]]
]
const checklistColumnRefSetters = panelColumns.map((_, index) => (element: unknown) => {
  setChecklistColumnElement(element instanceof Element ? element : null, index)
})

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
const gameIcons: Record<GameId, string> = {
  genshin: genshinIcon,
  'star-rail': starRailIcon,
  zenless: zenlessIcon,
  'wuthering-waves': wutheringWavesIcon
}
const hiddenGameIds = ref<GameId[]>(readHiddenGameIds(window.localStorage))
const items = ref<ChecklistItem[]>([])
const archivedItems = ref<ChecklistItem[]>([])
const appInfo = ref<AppInfo | null>(null)
const loading = ref(true)
const restoringGameView = ref(false)
const saving = ref(false)
const errorMessage = ref('')
const selectedGameId = ref<GameId>('genshin')
const showIncompleteOnly = ref(false)
const activityTagFilter = ref('')
const activityTagMenuOpen = ref(false)
const sectionSyncMenuOpen = ref<ChecklistSection | null>(null)
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
const semanticReviewSummaryByKey = ref<Record<string, SemanticReviewSummary>>({})
const editingItem = ref<ChecklistItem | null>(null)
const dismissedCodexProxyJobId = ref('')
const codexProxyPromptCopied = ref(false)
const codexRepairStage = ref<'none' | 'proxy_applied' | 'https_applied'>('none')
const codexRepairBusy = ref(false)
const codexPluginBusy = ref(false)
const codexPluginMessage = ref('')
const codexWorkerPreferences = ref<CodexWorkerPreferences>({
  model: 'inherit',
  reasoningEffort: 'inherit'
})
const codexWorkerPreferencesBusy = ref(false)
const codexWorkerPreferencesMessage = ref('')
let miyousheLoginTimer: number | null = null
let semanticReviewTimer: number | null = null
const personalReviewTotals = new Map<string, number>()
const semanticReviewLastRemaining = new Map<string, number>()
const semanticReviewLastUpdatedAt = new Map<string, string>()

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
const editorExamples = computed(() => gameEditorExamples[selectedGameId.value])
const visibleGames = computed(() => games.value.filter((game) => !hiddenGameIds.value.includes(game.id)))
const gameCredentialStatuses = computed(() => credentialStatuses.value)
const aiScheduleAvailable = computed(() =>
  Boolean(aiScheduleAgent.value?.connected || aiScheduleAgent.value?.codexPluginInstalled)
)
const publicSyncProgresses = computed<SyncProgressUpdate[]>(() =>
  activeAiJobs.value.map((job) => ({
    gameId: job.gameId,
    target: job.target,
    source: 'public_schedule',
    phase: job.progressPhase,
    status: job.status === 'pending' ? 'waiting' : 'running',
    message: job.message ?? (job.status === 'pending' ? '等待 Codex 接单' : 'Codex 正在处理'),
    current: job.progressCurrent,
    total: job.progressTotal,
    updatedAt: job.progressUpdatedAt
  }))
)
const publicSyncProgress = computed<SyncProgressUpdate | null>(() =>
  publicSyncProgresses.value[0] ?? null
)
const liveSyncProgress = computed(() =>
  [
    ...publicSyncProgresses.value,
    ...Object.values(personalSyncProgressByKey.value)
  ].filter(
    (progress): progress is SyncProgressUpdate =>
      Boolean(
        progress &&
        progress.gameId === selectedGameId.value &&
        ['waiting', 'running', 'verification_required'].includes(progress.status)
      )
  )
)
const showCodexProxyWarning = computed(() =>
  isCodexConnectionRetry(publicSyncProgress.value) &&
  Boolean(activeAiJob.value?.id) &&
  dismissedCodexProxyJobId.value !== activeAiJob.value?.id
)
watch(() => activeAiJob.value?.id, (jobId, previousJobId) => {
  if (jobId === previousJobId) return
  codexRepairStage.value = 'none'
  dismissedCodexProxyJobId.value = ''
})
const hasActivePublicSync = computed(() =>
  activeAiJobs.value.some((job) => job.gameId === selectedGameId.value)
)
const syncing = computed(() =>
  [...activeSyncRequests.value].some((key) => key.startsWith(`${selectedGameId.value}:`))
)
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
  if (syncNotice.value?.credentialProvider) return syncNotice.value.credentialProvider
  const message = syncNotice.value?.message ?? ''
  return credentialProviderFromSyncMessage(message)
})
const incompleteCount = computed(() => items.value.filter((item) => !item.completed).length)
const globalSyncState = computed(() => syncTargetStates.value.find((state) => state.target === 'all'))
const hasEstablishedCatalog = computed(() => items.value.some((item) =>
  !['main_quest', 'side_quest', 'custom'].includes(item.category)
))
const needsInitialSync = computed(() =>
  !syncSettings.value?.initialGuideDismissed &&
  !hasEstablishedCatalog.value &&
  !globalSyncState.value?.lastSuccessAt
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
function displaySyncMessage(message: string): string {
  return message
    .replaceAll('公开排期', '公开资料')
    .replaceAll('AI 排期', 'AI 资料')
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown)
  try {
    ;[games.value, appInfo.value, aiScheduleAgent.value] = await Promise.all([
      window.gacha.listGames(),
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
      loadActiveAiJobs(),
      refreshSemanticReviewProgress()
    ])
  } catch (error) {
    showError(error)
  } finally {
    loading.value = false
  }
  await nextTick()
  startAdaptiveColumnObserver()
})

const removeSyncListener = window.gacha.onSyncCompleted((result) => {
  if (result.gameId !== selectedGameId.value) return
  syncNotice.value = { status: result.status, message: displaySyncMessage(result.message) }
  void Promise.all([
    loadItems(),
    loadSyncSettings(),
    loadSyncTargetStates()
  ])
})
const removeChecklistListener = window.gacha.onChecklistChanged(() => {
  void Promise.all([
    loadItems(),
    loadArchivedItems(),
    loadSyncSettings(),
    loadSyncTargetStates(),
    loadAiScheduleAgentStatus(),
    loadActiveAiJobs(),
    refreshSemanticReviewProgress()
  ])
    .then(() => {
      const settings = syncSettings.value
      if (!settings?.message || settings.status === 'idle') return
      syncNotice.value = {
        status: settings.status === 'success'
          ? 'success'
          : settings.status === 'error'
            ? 'error'
            : 'partial',
        message: displaySyncMessage(settings.message)
      }
    })
})
const removeSyncProgressListener = window.gacha.onSyncProgress((progress) => {
  if (progress.source === 'personal_data') {
    if (progress.target === 'all' || progress.target === 'tasks') return
    if (progress.status === 'cancelled') {
      const next = { ...personalSyncProgressByKey.value }
      delete next[personalProgressKey(progress.gameId, progress.target)]
      personalSyncProgressByKey.value = next
      if (progress.gameId === selectedGameId.value) {
        syncNotice.value = { status: 'cancelled', message: '已取消' }
      }
      return
    }
    personalSyncProgressByKey.value = {
      ...personalSyncProgressByKey.value,
      [personalProgressKey(progress.gameId, progress.target)]: progress
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
}, 60_000)
const progressTimer = window.setInterval(() => {
  if (activeAiJobs.value.length > 0) void loadActiveAiJobs()
}, 2_000)
semanticReviewTimer = window.setInterval(() => {
  if (Object.entries(semanticReviewSummaryByKey.value).some(
    ([key, summary]) =>
      key.startsWith(`${selectedGameId.value}:`) &&
      summary.pendingCount + summary.claimedCount > 0
  )) {
    void refreshSemanticReviewProgress()
  }
}, 2_000)

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  removeSyncListener()
  removeChecklistListener()
  removeSyncProgressListener()
  window.clearInterval(clockTimer)
  window.clearInterval(agentTimer)
  window.clearInterval(progressTimer)
  if (semanticReviewTimer !== null) window.clearInterval(semanticReviewTimer)
  semanticReviewTimer = null
  adaptiveResizeObserver?.disconnect()
  adaptiveResizeObserver = null
  if (adaptiveLayoutFrame !== null) window.cancelAnimationFrame(adaptiveLayoutFrame)
  adaptiveLayoutFrame = null
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
  syncNotice.value = null
  activeAiJob.value = null
  activeAiJobs.value = []
  sectionSyncMenuOpen.value = null
  activityTagMenuOpen.value = false
  recycleBinOpen.value = false
  activityTagFilter.value = ''
  try {
    await Promise.all([
      loadItems({ showLoading: true, preserveScroll: false }),
      loadArchivedItems(),
      loadSyncSettings(),
      loadSyncTargetStates(),
      loadPersonalSyncTargets(),
      loadActiveAiJobs(),
      refreshSemanticReviewProgress()
    ])
    const savedScroll = checklistScrollByGame.get(gameId)
    if (selectedGameId.value === gameId && savedScroll) {
      await restoreChecklistScroll(savedScroll)
    } else {
      await nextTick()
    }
  } finally {
    if (selectedGameId.value === gameId) restoringGameView.value = false
  }
})

interface ChecklistScrollSnapshot {
  workspaceTop: number
  workspaceLeft: number
  listPositions: Array<{ top: number; left: number }>
}

function captureChecklistScroll(): ChecklistScrollSnapshot {
  return {
    workspaceTop: workspaceElement.value?.scrollTop ?? 0,
    workspaceLeft: workspaceElement.value?.scrollLeft ?? 0,
    listPositions: [...(workspaceElement.value?.querySelectorAll<HTMLElement>('.item-list') ?? [])]
      .map((element) => ({ top: element.scrollTop, left: element.scrollLeft }))
  }
}

function measureNaturalColumnHeight(element: HTMLElement): number {
  const wasConstrained = element.classList.contains('checklist-column-constrained')
  const previousHeight = element.style.getPropertyValue('--adaptive-column-height')
  const previousPriority = element.style.getPropertyPriority('--adaptive-column-height')
  if (wasConstrained) {
    element.classList.remove('checklist-column-constrained')
    element.style.removeProperty('--adaptive-column-height')
  }
  const hiddenListHeight = [...element.querySelectorAll<HTMLElement>('.item-list')]
    .reduce((total, list) => total + Math.max(0, list.scrollHeight - list.clientHeight), 0)
  const naturalHeight = element.scrollHeight + hiddenListHeight
  if (wasConstrained) {
    element.classList.add('checklist-column-constrained')
    if (previousHeight) {
      element.style.setProperty('--adaptive-column-height', previousHeight, previousPriority)
    }
  }
  return naturalHeight
}

function updateAdaptiveColumnLayout(): void {
  const columns = checklistColumnElements.slice(0, 2)
  if (columns.length < 2 || columns.some((element) => !element)) {
    adaptiveColumnHeight.value = null
    constrainedColumnIndex.value = null
    return
  }
  const heights = columns.map((element) => measureNaturalColumnHeight(element!))
  const layout = resolveAdaptiveColumnLayout(heights)
  if (!layout) {
    adaptiveColumnHeight.value = null
    constrainedColumnIndex.value = null
    return
  }
  if (
    adaptiveColumnHeight.value === layout.height &&
    constrainedColumnIndex.value === layout.constrainedIndex
  ) return
  adaptiveColumnHeight.value = layout.height
  constrainedColumnIndex.value = layout.constrainedIndex
}

function scheduleAdaptiveColumnLayout(): void {
  if (adaptiveLayoutFrame !== null) window.cancelAnimationFrame(adaptiveLayoutFrame)
  adaptiveLayoutFrame = window.requestAnimationFrame(() => {
    adaptiveLayoutFrame = null
    updateAdaptiveColumnLayout()
  })
}

function startAdaptiveColumnObserver(): void {
  adaptiveResizeObserver?.disconnect()
  adaptiveResizeObserver = new ResizeObserver(() => scheduleAdaptiveColumnLayout())
  for (const element of checklistColumnElements.slice(0, 2)) {
    if (element) adaptiveResizeObserver.observe(element)
  }
  scheduleAdaptiveColumnLayout()
}

function setChecklistColumnElement(element: Element | null, index: number): void {
  const previous = checklistColumnElements[index]
  const htmlElement = element instanceof HTMLElement ? element : null
  if (previous === htmlElement) return
  if (previous) adaptiveResizeObserver?.unobserve(previous)
  checklistColumnElements[index] = htmlElement
  if (htmlElement && index < 2) adaptiveResizeObserver?.observe(htmlElement)
  scheduleAdaptiveColumnLayout()
}

async function restoreChecklistScroll(snapshot: ChecklistScrollSnapshot): Promise<void> {
  const restore = (): void => {
    workspaceElement.value?.scrollTo({
      top: snapshot.workspaceTop,
      left: snapshot.workspaceLeft,
      behavior: 'auto'
    })
    const lists = workspaceElement.value?.querySelectorAll<HTMLElement>('.item-list') ?? []
    lists.forEach((element, index) => {
      const position = snapshot.listPositions[index]
      if (!position) return
      element.scrollTo({ top: position.top, left: position.left, behavior: 'auto' })
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
      scheduleAdaptiveColumnLayout()
    }
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  } finally {
    if (showLoading && selectedGameId.value === gameId) loading.value = false
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

async function dismissInitialSyncGuide(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const settings = await window.gacha.dismissInitialSyncGuide(gameId)
    if (selectedGameId.value === gameId) syncSettings.value = settings
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
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
      ? '公开资料'
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
  } catch (error) {
    showError(error)
  }
}

async function loadActiveAiJobs(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const jobs = await window.gacha.listActiveAiScheduleJobs(gameId)
    if (selectedGameId.value === gameId) {
      activeAiJobs.value = jobs
      activeAiJob.value = jobs[0] ?? null
    }
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

async function refreshSemanticReviewProgress(
  requestedTarget?: PersonalSyncTarget
): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const targets = requestedTarget ? [requestedTarget] : personalReviewTargets
    const summaries = await Promise.all(
      targets.map(async (target) => ({
        target,
        summary: await window.gacha.getSemanticReviewSummary(gameId, target)
      }))
    )
    if (selectedGameId.value !== gameId) return
    let completedAny = false
    const completedDecisions: SemanticReviewSummary['latestDecision'][] = []
    const nextSummaries = { ...semanticReviewSummaryByKey.value }
    const nextProgress = { ...personalSyncProgressByKey.value }
    for (const { target, summary } of summaries) {
      const key = personalProgressKey(gameId, target)
      const previousSummary = semanticReviewSummaryByKey.value[key]
      const previousRemaining = previousSummary
        ? previousSummary.pendingCount + previousSummary.claimedCount
        : 0
      nextSummaries[key] = summary
      const remaining = summary.pendingCount + summary.claimedCount
      if (remaining > 0) {
        const waitingForCatalog = summary.waitingForCatalogCount > 0
        const catalogJobActive = activeAiJobs.value.some(
          (job) =>
            job.gameId === gameId &&
            (job.target === target || job.target === 'all')
        )
        if (waitingForCatalog && !catalogJobActive) {
          delete nextProgress[key]
          syncNotice.value = {
            status: 'partial',
            message: '个人数据已暂存，但规范清单尚未完成；请重新同步进度以继续补建清单'
          }
          continue
        }
        const total = Math.max(personalReviewTotals.get(key) ?? 0, remaining)
        personalReviewTotals.set(key, total)
        if (
          remaining !== semanticReviewLastRemaining.get(key) ||
          !semanticReviewLastUpdatedAt.get(key)
        ) {
          semanticReviewLastRemaining.set(key, remaining)
          semanticReviewLastUpdatedAt.set(key, new Date().toISOString())
        }
        nextProgress[key] = {
          gameId,
          target,
          source: 'personal_data',
          phase: summary.claimedCount > 0 ? 'verifying' : 'queued',
          status: summary.claimedCount > 0 ? 'running' : 'waiting',
          message: summary.claimedCount > 0
            ? `Codex 正在核验个人${target === 'events' ? '活动' : target === 'cycles' ? '周期事项' : '地图'}数据，剩余 ${remaining} 条`
            : waitingForCatalog
              ? '个人数据已暂存，正在先建立完整的公开规范清单'
              : '排队中，等待可用的 Codex 处理',
          current: summary.claimedCount > 0 ? Math.max(0, total - remaining) : null,
          total: summary.claimedCount > 0 ? total : null,
          updatedAt: semanticReviewLastUpdatedAt.get(key)!
        }
        continue
      }
      if (previousRemaining > 0 || (personalReviewTotals.get(key) ?? 0) > 0) {
        delete nextProgress[key]
        personalReviewTotals.delete(key)
        semanticReviewLastRemaining.delete(key)
        semanticReviewLastUpdatedAt.delete(key)
        completedAny = true
        completedDecisions.push(summary.latestDecision)
      }
    }
    semanticReviewSummaryByKey.value = nextSummaries
    personalSyncProgressByKey.value = nextProgress
    if (completedAny) {
      const cancelled = completedDecisions.some(
        (decision) => decision?.status === 'rejected' && decision.message === '用户已取消'
      )
      const rejected = completedDecisions.some(
        (decision) => decision?.status === 'rejected'
      )
      syncNotice.value = cancelled
        ? { status: 'cancelled', message: '已取消' }
        : rejected
          ? { status: 'partial', message: 'Codex 核验结束，部分数据未写入，可重新同步' }
          : { status: 'success', message: '个人进度已由 Codex 核验并合并' }
      await Promise.all([loadItems(), loadSyncSettings(), loadSyncTargetStates()])
    }
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

const syncProgressPhaseLabels: Record<SyncProgressUpdate['phase'], string> = {
  queued: '排队中',
  fetching: '读取数据',
  searching: '联网检索',
  verifying: '交叉核验',
  structuring: '整理数据',
  writing: '写入清单',
  retrying: '正在重试',
  verification: '等待验证',
  merging: '安全合并',
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
    return `${personalPlatform.value}${syncProgressTargetLabels[progress.target]}进度同步`
  }
  if (progress.target === 'tasks') return 'Codex 版更校时'
  return `Codex ${syncProgressTargetLabels[progress.target]}清单同步`
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
  if (
    progress.source !== 'public_schedule' ||
    progress.status !== 'waiting' ||
    activeAiJob.value?.status !== 'pending'
  ) {
    return progress.message
  }
  if (
    progress.message &&
    progress.message !== '等待 Codex 接单' &&
    !progress.message.includes('已提交给 AI')
  ) {
    return progress.message
  }
  const waitingMs = clockNow.value - new Date(progress.updatedAt).getTime()
  if (progress.message.includes('重新排队')) {
    return '上次处理长时间没有进度，已重新排队等待 Codex 接单'
  }
  if (waitingMs < 10_000) return '同步任务已提交，正在启动本机 Codex'
  if (waitingMs < 60_000) return '本机 Codex 正在启动并连接同步插件'
  return '排队中；Codex 可用后会自动继续，无需重新同步'
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
    const [statuses, listedBackups, preferences] = await Promise.all([
      window.gacha.listCredentialStatuses(),
      window.gacha.listBackups(),
      window.gacha.getCodexWorkerPreferences()
    ])
    credentialStatuses.value = statuses
    backups.value = listedBackups
    codexWorkerPreferences.value = preferences
    codexWorkerPreferencesMessage.value = ''
  } catch (error) {
    showError(error)
  }
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
  } catch (error) {
    showError(error)
  }
}

async function updateCodexPlugin(): Promise<void> {
  codexPluginBusy.value = true
  codexPluginMessage.value = '正在更新插件…'
  try {
    const result = await window.gacha.updateCodexPlugin()
    codexPluginMessage.value = `${result.message}；新同步任务将使用最新版。`
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
    codexWorkerPreferencesMessage.value = '已保存，新启动的后台同步任务将使用此设置。'
  } catch (error) {
    codexWorkerPreferencesMessage.value = ''
    showError(error)
  } finally {
    codexWorkerPreferencesBusy.value = false
  }
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
    ? '检测到 Codex 连接反复重试。软件会读取系统代理解析到的本地端口，仅显式应用于本软件启动的 Codex 进程；不会修改 Windows 或 Codex 配置。重连会消耗少量额外 Token，是否继续？'
    : '显式应用当前代理后仍未解决连接重试。软件将关闭本次 Codex 进程的 Responses WebSocket，改用已验证的 HTTPS 兼容连接；不会修改 Codex 配置。重连会消耗少量额外 Token，是否继续？')
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

function personalProgressKey(gameId: GameId, target: PersonalSyncTarget): string {
  return `${gameId}:${target}`
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
    (job) => job.target === target || job.target === 'all' || target === 'all'
  )
}

function hasActivePersonalSyncForTarget(target: PersonalSyncTarget): boolean {
  const progress = personalSyncProgressByKey.value[
    personalProgressKey(selectedGameId.value, target)
  ]
  return isSyncRequestActive('personal_data', target) || Boolean(
    progress && ['waiting', 'running', 'verification_required'].includes(progress.status)
  )
}

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
      message: result.message
    }
    await Promise.all([
      loadActiveAiJobs(),
      loadSyncSettings(),
      loadSyncTargetStates(),
      refreshSemanticReviewProgress()
    ])
  } catch (error) {
    showError(error)
  } finally {
    const remaining = new Set(cancellingSyncKeys.value)
    remaining.delete(key)
    cancellingSyncKeys.value = remaining
  }
}

async function runSync(scope: SyncScope, target: SyncTarget = 'all'): Promise<void> {
  const gameId = selectedGameId.value
  if (isSyncRequestActive('public_schedule', target, gameId)) return
  sectionSyncMenuOpen.value = null
  setSyncRequestActive(gameId, 'public_schedule', target, true)
  syncNotice.value = null
  try {
    const result = await window.gacha.syncGame(gameId, scope, target, {
      outputLocale: document.documentElement.lang || 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    })
    if (selectedGameId.value === gameId) {
      syncNotice.value = { status: result.status, message: displaySyncMessage(result.message) }
      await Promise.all([loadItems(), loadSyncSettings(), loadSyncTargetStates(), loadActiveAiJobs()])
    }
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  } finally {
    setSyncRequestActive(gameId, 'public_schedule', target, false)
  }
}

async function runPersonalSync(target: SyncTarget): Promise<void> {
  if (target === 'all' || target === 'tasks') return
  const gameId = selectedGameId.value
  if (hasActivePersonalSyncForTarget(target)) return
  let keepReviewProgress = false
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
      syncNotice.value = {
        status: result.status,
        message: displaySyncMessage(result.message),
        credentialProvider
      }
      const pendingReview = result.sources.reduce(
        (count, source) => count + (source.pendingReview ?? 0),
        0
      )
      if (pendingReview > 0) {
        keepReviewProgress = true
        personalReviewTotals.set(progressKey, pendingReview)
        await loadActiveAiJobs()
        await refreshSemanticReviewProgress(target)
      }
      await Promise.all([loadItems(), loadSyncSettings(), loadSyncTargetStates()])
      if (credentialProvider) await openCredentialSettings(credentialProvider)
    }
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  } finally {
    setSyncRequestActive(gameId, 'personal_data', target, false)
    if (selectedGameId.value === gameId && !keepReviewProgress) {
      const remainingProgress = { ...personalSyncProgressByKey.value }
      delete remainingProgress[progressKey]
      personalSyncProgressByKey.value = remainingProgress
    }
  }
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
  return panel.section === 'exploration'
    ? distributeMapTreeRows(rows, 2)
    : [rows]
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
    const updated = await window.gacha.updateChecklistItem({
      id: item.id,
      completed: !item.completed
    })
    const index = items.value.findIndex((candidate) => candidate.id === updated.id)
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    if (index >= 0) items.value[index] = updated
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
    (item) => categories.includes(item.category) && item.completed && !isPersistentItem(item)
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

function isExpired(value: string): boolean {
  return new Date(value).getTime() <= clockNow.value
}

function isUrgentDeadline(value: string): boolean {
  const remaining = new Date(value).getTime() - clockNow.value
  return remaining > 0 && remaining < 72 * 60 * 60 * 1_000
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
  <main class="app-shell" @click="sectionSyncMenuOpen = null; activityTagMenuOpen = false">
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
          type="button"
          :aria-current="selectedGameId === game.id ? 'page' : undefined"
          @click="selectedGameId = game.id"
        >
          <img class="game-icon" :src="gameIcons[game.id]" alt="" aria-hidden="true">
          {{ game.name }}
        </button>
      </nav>
      <div class="sidebar-footer">
        <button type="button" @click="recycleBinOpen = true">♲ 回收站 <span>{{ archivedItems.length }}</span></button>
        <button type="button" @click="openSettings">⚙ 设置</button>
      </div>
    </aside>

    <section ref="workspaceElement" class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">本地任务总览</p>
          <h1>{{ selectedGame?.name ?? 'Gtask' }}</h1>
        </div>
        <div class="topbar-actions">
          <button
            class="toolbar-button"
            :class="{ active: showIncompleteOnly }"
            type="button"
            :aria-pressed="showIncompleteOnly"
            @click="showIncompleteOnly = !showIncompleteOnly"
          >
            ◇ 只看未完成
          </button>
          <button
            class="toolbar-button"
            type="button"
            :disabled="syncing || hasActivePublicSync || !aiScheduleAvailable"
            :title="aiScheduleAgent?.connected
              ? `已连接 ${aiScheduleAgent.name}`
              : aiScheduleAgent?.codexPluginInstalled
                ? '已安装 Codex 插件；点击后将自动启动 Codex 处理资料任务'
                : '刷新清单需要连接 Codex/MCP'"
            @click="runSync('public_schedule')"
          >
            {{ hasActivePublicSync ? 'AI 处理中…' : syncing ? '同步中…' : aiScheduleAvailable ? '↻ 刷新清单' : '↻ 未连接 AI' }}
          </button>
          <span
            class="sync-indicator"
            :class="syncStateClass(globalSyncState)"
            :title="syncStateTimestamp(globalSyncState)
              ? `同步时间：${new Date(syncStateTimestamp(globalSyncState)!).toLocaleString()}`
              : '尚未完成全局同步'"
          >
            <strong>全局清单 · {{ syncStateLabel(globalSyncState) }}</strong>
            <time v-if="syncStateTimestamp(globalSyncState)">{{ formatSyncTimestamp(syncStateTimestamp(globalSyncState)!) }}</time>
          </span>
        </div>
      </header>

      <p v-if="errorMessage" class="error-banner" role="alert">{{ errorMessage }}</p>
      <div v-if="needsInitialSync" class="onboarding-banner">
        <div>
          <strong>建立你的第一份清单</strong>
          <small>可以同步公开资料，也可以直接在活动、周期或地图版块同步个人进度。</small>
        </div>
        <button class="onboarding-primary" type="button" :disabled="syncing || hasActivePublicSync" @click="aiScheduleAvailable ? runSync('public_schedule', 'all') : settingsOpen = true">
          {{ aiScheduleAvailable ? '同步公开资料' : '连接 Codex' }}
        </button>
        <button
          class="onboarding-dismiss"
          type="button"
          aria-label="关闭初始同步提示"
          @click="dismissInitialSyncGuide"
        >
          ×
        </button>
      </div>
      <div v-if="liveSyncProgress.length" class="sync-progress-stack" aria-live="polite">
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
      <div v-if="syncNotice" class="sync-banner" :class="syncNotice.status" aria-live="polite">
        <span>{{ syncNotice.message }}</span>
        <button
          v-if="syncNoticeCredentialProvider"
          type="button"
          @click="openCredentialSettings(syncNoticeCredentialProvider)"
        >前往登录</button>
      </div>
      <section class="summary-grid">
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

      <section v-if="loading" class="panel centered" role="status" aria-live="polite">正在读取本地清单…</section>
      <div
        v-else
        class="checklist-content-frame"
        :class="{ 'restoring-scroll': restoringGameView }"
      >
        <section class="content-grid">
          <div
            v-for="(column, columnIndex) in panelColumns"
            :key="columnIndex"
            :ref="checklistColumnRefSetters[columnIndex]"
            class="checklist-column"
            :class="{
              'checklist-column-wide': columnIndex === panelColumns.length - 1,
              'checklist-column-constrained': columnIndex === constrainedColumnIndex
            }"
            :style="columnIndex === constrainedColumnIndex && adaptiveColumnHeight !== null
              ? { '--adaptive-column-height': `${adaptiveColumnHeight}px` }
              : undefined"
          >
            <article
              v-for="panel in column"
              :key="panel.title"
              class="panel checklist-card"
              :class="`panel-${panel.section}`"
            >
              <div class="section-header">
                <div class="section-title">
                <h2>
                  <span class="panel-icon" :class="`panel-icon-${panel.section}`" aria-hidden="true">
                    <svg v-if="panel.section === 'tasks'" viewBox="0 0 24 24"><path d="M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>
                    <svg v-else-if="panel.section === 'events'" viewBox="0 0 24 24"><path d="M12 3v18M3 12h18"/><path d="M5.6 5.6 18.4 18.4M18.4 5.6 5.6 18.4"/><circle cx="12" cy="12" r="4"/></svg>
                    <svg v-else-if="panel.section === 'cycles'" viewBox="0 0 24 24"><path d="M20 8a8 8 0 1 0 .3 7"/><path d="M20 3v5h-5"/><path d="M12 7v5l3 2"/></svg>
                    <svg v-else viewBox="0 0 24 24"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></svg>
                  </span>
                  {{ panel.title }}
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
                    >↻ 同步 ▾</button>
                    <div v-if="sectionSyncMenuOpen === panel.section" class="dropdown-menu section-sync-menu" role="menu">
                      <button
                        role="menuitem"
                        type="button"
                        :disabled="!aiScheduleAvailable || isSyncRequestActive('public_schedule', panel.syncTarget) || hasActivePublicSyncForTarget(panel.syncTarget)"
                        @click="runSync('public_schedule', panel.syncTarget)"
                      >同步清单</button>
                      <button
                        v-if="personalSyncTargets.includes(panel.syncTarget)"
                        role="menuitem"
                        type="button"
                        :disabled="hasActivePersonalSyncForTarget(panel.syncTarget as PersonalSyncTarget)"
                        @click="runPersonalSync(panel.syncTarget)"
                      >同步进度</button>
                    </div>
                  </div>
                  <button
                    v-if="panel.allowClear !== false"
                    class="clear-completed-button"
                    type="button"
                    :disabled="!items.some((item) => panel.categories.includes(item.category) && item.completed && !isPersistentItem(item))"
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
                      <span>{{ activityTagFilter || '全部玩法' }}</span><i>⌄</i>
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
              <div class="item-list" :class="{ 'map-item-columns': panel.section === 'exploration' }">
                <div
                  v-for="(itemColumn, itemColumnIndex) in panelItemColumns(panel)"
                  :key="itemColumnIndex"
                  class="item-list-column"
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
                      <span v-if="row.item.resetRule" class="reset-detail">{{ row.item.resetRule }}</span>
                      <span
                        v-if="row.item.source !== 'manual' && row.item.lastSyncedAt"
                        class="source-detail"
                        :title="`${row.item.source === 'public_schedule' ? '公开资料' : '个人数据'} · 同步于 ${formatLocalTime(row.item.lastSyncedAt)}${row.item.sourceUrl ? ` · ${row.item.sourceUrl}` : ''}`"
                      >
                        {{ row.item.source === 'public_schedule' ? '公开资料' : '个人数据' }}
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
                </div>
                <p v-if="panelItems(panel).length === 0" class="empty-text">暂无事项</p>
              </div>
              <button v-if="panel.allowCreate !== false" class="add-button" type="button" @click="openCreate(panel.defaultCategory)">＋ 新增{{ panel.title }}</button>
            </article>
          </div>
        </section>

        <section class="panel custom-list">
          <div class="section-header">
            <h2>自定义清单</h2>
            <button
              class="clear-completed-button"
              type="button"
              :disabled="!items.some((item) => item.category === 'custom' && item.completed)"
              @click="archiveCompletedSection('custom', ['custom'], '自定义清单')"
            >删除已完成</button>
          </div>
          <div class="custom-grid">
            <div
              v-for="item in itemsFor(['custom'])"
              :key="item.id"
              class="checklist-row"
              :class="{ completed: item.completed }"
            >
              <button
                class="check-button"
                type="button"
                :aria-label="item.completed ? '标为未完成' : '标为完成'"
                @click="toggleCompleted(item)"
              >{{ item.completed ? '✓' : '' }}</button>
              <button class="item-main" type="button" @click="openEdit(item)">
                <span class="item-title">{{ item.title }}</span>
              </button>
              <button class="more-button" type="button" aria-label="编辑" @click="openEdit(item)">⋮</button>
            </div>
          </div>
          <p v-if="itemsFor(['custom']).length === 0" class="empty-text">暂无自定义事项</p>
          <button class="add-button" type="button" @click="openCreate('custom')">＋ 新增自定义事项</button>
        </section>
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
          <button v-if="editingItem && !isPersistentItem(editingItem)" class="danger-button" type="button" @click="archiveItem(editingItem)">删除</button>
          <span></span>
          <button class="secondary-button" type="button" @click="editorOpen = false">取消</button>
          <button class="primary-button" type="submit" :disabled="saving || !form.title.trim()">{{ saving ? '保存中…' : '保存' }}</button>
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
        <p class="recycle-hint">已删除事项保留在本机；远端同步不会自动恢复它们。</p>
        <div class="recycle-list">
          <div v-for="item in archivedItems" :key="item.id" class="recycle-row">
            <div>
              <strong>{{ item.title }}</strong>
              <span>{{ categoryLabels[item.category] }} · {{ item.source === 'manual' ? '手动' : '同步' }}</span>
            </div>
            <button class="secondary-button" type="button" @click="restoreItem(item)">恢复</button>
          </div>
          <p v-if="archivedItems.length === 0" class="empty-text">回收站为空</p>
        </div>
      </section>
    </div>

    <div v-if="settingsOpen" class="modal-backdrop" @click.self="settingsOpen = false">
      <section class="editor-modal recycle-modal" role="dialog" aria-modal="true" aria-label="设置">
        <div class="modal-header">
          <div><p class="eyebrow">本机设置</p><h2>设置</h2></div>
          <button class="close-button" type="button" aria-label="关闭设置" @click="settingsOpen = false">×</button>
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
        <h3 class="settings-heading">公开资料 AI</h3>
        <div class="ai-provider-box codex-provider-box">
          <div class="ai-provider-heading">
            <div>
              <strong>Codex 资料同步插件</strong>
              <span>{{ aiScheduleAgent?.connected
                ? `Agent 已连接 · ${aiScheduleAgent.name}`
                : aiScheduleAgent?.codexPluginInstalled
                  ? '已安装 · 同步时将自动启动 Codex'
                  : '未安装或未启用' }}</span>
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
              <span>{{ codexWorkerPreferencesMessage || '仅影响 Gtask 后台任务，不修改 Codex 全局配置。' }}</span>
              <button
                class="primary-button settings-action-button"
                type="button"
                :disabled="codexWorkerPreferencesBusy"
                @click="saveCodexWorkerPreferences"
              >{{ codexWorkerPreferencesBusy ? '保存中…' : '保存设置' }}</button>
            </div>
          </div>
          <div v-if="!aiScheduleAgent?.codexPluginInstalled" class="codex-setup-guide">
            <ol>
              <li>打开安装页，在 Codex 中确认安装。</li>
              <li>返回后重新检测，即可开始同步。</li>
            </ol>
            <div class="codex-setup-actions">
              <button class="secondary-button wide-action-button" type="button" @click="openCodexPlugin">打开 Codex 安装页</button>
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
        <p class="recycle-hint">插件不会静默安装；启用后同步会自动调用 Codex。</p>
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
        <p class="recycle-hint">本地数据位于系统“文档”目录的 GachaTaskManager；backups 子目录保留最近 30 份每日备份，手动与安全备份不自动清理。</p>
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
        <p class="settings-note">米游社使用二维码登录；鸣潮在应用内完成库街区手机号、滑块和短信验证。Token 与 DID 均由应用自动取得并只在本机加密保存。</p>
      </section>
    </div>
    <div v-if="miyousheLoginOpen" class="modal-backdrop login-backdrop" @click.self="closeMiyousheLogin">
      <section class="editor-modal login-modal" role="dialog" aria-modal="true" aria-label="米游社扫码登录">
        <div class="modal-header">
          <div><h2>米游社扫码登录</h2><p>凭据只会经 Windows DPAPI 加密保存在本机</p></div>
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
          <p v-else-if="miyousheLoginState.status === 'confirmed'">现在可以使用“同步进度”读取米游社个人数据。</p>
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
          <p class="recycle-hint">DID 由应用自动生成，Token 不会显示或进入剪贴板；角色数据权限验证成功后才会通过 Windows DPAPI 加密保存。</p>
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
  </main>
</template>
