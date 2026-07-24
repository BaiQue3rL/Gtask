<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type {
  AiScheduleAgentStatus,
  AiScheduleJob,
  AppInfo,
  BackupSummary,
  ChecklistCategory,
  ChecklistItem,
  ChecklistSection,
  CreateChecklistItemInput,
  CredentialProvider,
  CredentialStatus,
  GameId,
  GameSummary,
  KuroCommunityRole,
  MiyousheQrLoginState,
  PersonalSyncTarget,
  SyncResult,
  SyncProgressUpdate,
  SyncScope,
  SyncTarget,
  SyncTargetState,
  SyncSettings
} from '../../shared/contracts'
import { readHiddenGameIds, writeHiddenGameIds } from './game-visibility'
import { kuroRoleKey } from './kuro-role-key'

interface ChecklistPanel {
  title: string
  icon: string
  section: ChecklistSection
  categories: ChecklistCategory[]
  defaultCategory: ChecklistCategory
  allowCreate?: boolean
  allowClear?: boolean
  syncTarget?: Exclude<SyncTarget, 'all'>
}

const panels: ChecklistPanel[] = [
  { title: '任务', icon: '▣', section: 'tasks', categories: ['main_quest', 'side_quest'], defaultCategory: 'side_quest', allowCreate: false, allowClear: false, syncTarget: 'tasks' },
  { title: '活动', icon: '♧', section: 'events', categories: ['limited_event', 'permanent_event'], defaultCategory: 'limited_event', syncTarget: 'events' },
  { title: '周期事项', icon: '◴', section: 'cycles', categories: ['weekly', 'endgame'], defaultCategory: 'endgame', syncTarget: 'cycles' },
  { title: '地图探索', icon: '◇', section: 'exploration', categories: ['exploration'], defaultCategory: 'exploration', syncTarget: 'exploration' }
]
const panelColumns: ChecklistPanel[][] = [
  [panels[0], panels[2]],
  [panels[1], panels[3]]
]

const categoryLabels: Record<ChecklistCategory, string> = {
  main_quest: '主线任务',
  side_quest: '支线任务',
  limited_event: '限时活动',
  permanent_event: '常驻活动',
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
      permanent_event: '例如：七圣召唤', weekly: '例如：周常', endgame: '例如：深境螺旋',
      exploration: '例如：枫丹廷区', custom: '例如：刷角色突破素材'
    },
    parentTitle: '例如：枫丹',
    modeKey: '例如：深境螺旋 / 幻想真境剧诗',
    resetRule: '例如：本期结束时间以游戏内为准'
  },
  'star-rail': {
    titles: {
      main_quest: '例如：开拓任务', side_quest: '例如：冒险任务', limited_event: '例如：折纸小鸟对对碰',
      permanent_event: '例如：模拟宇宙', weekly: '例如：周常', endgame: '例如：混沌回忆',
      exploration: '例如：黄金的时刻', custom: '例如：刷行迹材料'
    },
    parentTitle: '例如：匹诺康尼',
    modeKey: '例如：混沌回忆 / 虚构叙事',
    resetRule: '例如：本期名称与结束时间以游戏内为准'
  },
  zenless: {
    titles: {
      main_quest: '例如：主线任务', side_quest: '例如：代理人秘闻', limited_event: '例如：嗯呢从天降',
      permanent_event: '例如：零号空洞', weekly: '例如：周常', endgame: '例如：式舆防卫战',
      exploration: '例如：六分街', custom: '例如：刷驱动盘'
    },
    parentTitle: '例如：新艾利都',
    modeKey: '例如：式舆防卫战 / 危局强袭战',
    resetRule: '例如：本期结束时间以游戏内为准'
  },
  'wuthering-waves': {
    titles: {
      main_quest: '例如：潮汐任务', side_quest: '例如：危行任务', limited_event: '例如：限时活动',
      permanent_event: '例如：常驻活动', weekly: '例如：周常', endgame: '例如：逆境深塔',
      exploration: '例如：乘霄山', custom: '例如：刷声骸'
    },
    parentTitle: '例如：瑝珑',
    modeKey: '例如：逆境深塔 / 冥歌海墟',
    resetRule: '例如：本期结束时间以游戏内为准'
  }
}

const games = ref<GameSummary[]>([])
const hiddenGameIds = ref<GameId[]>(readHiddenGameIds(window.localStorage))
const items = ref<ChecklistItem[]>([])
const archivedItems = ref<ChecklistItem[]>([])
const appInfo = ref<AppInfo | null>(null)
const loading = ref(true)
const saving = ref(false)
const errorMessage = ref('')
const selectedGameId = ref<GameId>('genshin')
const showIncompleteOnly = ref(false)
const activityTagFilter = ref('')
const sectionSyncMenuOpen = ref<ChecklistSection | null>(null)
const syncing = ref(false)
const syncSettings = ref<SyncSettings | null>(null)
const syncTargetStates = ref<SyncTargetState[]>([])
const personalSyncTargets = ref<PersonalSyncTarget[]>([])
const syncNotice = ref<{ status: SyncResult['status']; message: string } | null>(null)
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
const personalSyncProgress = ref<SyncProgressUpdate | null>(null)
const editingItem = ref<ChecklistItem | null>(null)
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
const editorExamples = computed(() => gameEditorExamples[selectedGameId.value])
const visibleGames = computed(() => games.value.filter((game) => !hiddenGameIds.value.includes(game.id)))
const gameCredentialStatuses = computed(() => credentialStatuses.value)
const aiScheduleAvailable = computed(() =>
  Boolean(aiScheduleAgent.value?.connected || aiScheduleAgent.value?.codexPluginInstalled)
)
const publicSyncProgress = computed<SyncProgressUpdate | null>(() => {
  const job = activeAiJob.value
  if (!job) return null
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
})
const liveSyncProgress = computed(() =>
  [publicSyncProgress.value, personalSyncProgress.value].filter(
    (progress): progress is SyncProgressUpdate =>
      Boolean(
        progress &&
        progress.gameId === selectedGameId.value &&
        ['waiting', 'running', 'verification_required'].includes(progress.status)
      )
  )
)
const hasActivePublicSync = computed(() =>
  Boolean(
    publicSyncProgress.value &&
    publicSyncProgress.value.gameId === selectedGameId.value &&
    ['waiting', 'running'].includes(publicSyncProgress.value.status)
  )
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
const incompleteCount = computed(() => items.value.filter((item) => !item.completed).length)
const globalSyncState = computed(() => syncTargetStates.value.find((state) => state.target === 'all'))
const needsInitialSync = computed(() => !globalSyncState.value?.lastSuccessAt)
const completedCount = computed(() => {
  const weekStart = startOfCurrentWeek()
  return items.value.filter((item) => item.completedAt && new Date(item.completedAt) >= weekStart).length
})
const activityTagOptions = computed(() => [...new Set(
  items.value
    .filter((item) => ['limited_event', 'permanent_event'].includes(item.category))
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
      loadActiveAiJob()
    ])
  } catch (error) {
    showError(error)
  } finally {
    loading.value = false
  }
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
    loadActiveAiJob()
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
    personalSyncProgress.value = progress
    return
  }
  if (progress.gameId === selectedGameId.value) void loadActiveAiJob()
})
const clockTimer = window.setInterval(() => {
  clockNow.value = Date.now()
}, 1_000)
const agentTimer = window.setInterval(() => {
  void loadAiScheduleAgentStatus()
}, 60_000)
const progressTimer = window.setInterval(() => {
  if (activeAiJob.value) void loadActiveAiJob()
}, 2_000)

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
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
  sectionSyncMenuOpen.value = null
  editorOpen.value = false
  recycleBinOpen.value = false
  settingsOpen.value = false
}

watch(selectedGameId, () => {
  syncNotice.value = null
  personalSyncProgress.value = null
  activeAiJob.value = null
  sectionSyncMenuOpen.value = null
  recycleBinOpen.value = false
  activityTagFilter.value = ''
  void Promise.all([
    loadItems(),
    loadArchivedItems(),
    loadSyncSettings(),
    loadSyncTargetStates(),
    loadPersonalSyncTargets(),
    loadActiveAiJob()
  ])
})

async function loadItems(): Promise<void> {
  const gameId = selectedGameId.value
  loading.value = true
  errorMessage.value = ''
  try {
    const loadedItems = await window.gacha.listChecklistItems(gameId)
    if (selectedGameId.value === gameId) items.value = loadedItems
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  } finally {
    if (selectedGameId.value === gameId) loading.value = false
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

async function loadAiScheduleAgentStatus(): Promise<void> {
  try {
    aiScheduleAgent.value = await window.gacha.getAiScheduleAgentStatus()
  } catch (error) {
    showError(error)
  }
}

async function loadActiveAiJob(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const job = await window.gacha.getActiveAiScheduleJob(gameId)
    if (selectedGameId.value === gameId) activeAiJob.value = job
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

const syncProgressPhaseLabels: Record<SyncProgressUpdate['phase'], string> = {
  queued: '等待接单',
  fetching: '读取数据',
  searching: '联网检索',
  verifying: '交叉核验',
  structuring: '整理数据',
  writing: '写入清单',
  retrying: '正在重试',
  verification: '等待验证',
  merging: '安全合并',
  completed: '同步完成',
  failed: '同步失败'
}

function syncProgressTitle(progress: SyncProgressUpdate): string {
  if (progress.source !== 'public_schedule') return `${personalPlatform.value}进度同步`
  return progress.target === 'tasks' ? 'Codex 版更校时' : 'Codex 公开资料同步'
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
  return progress.status === 'running' &&
    clockNow.value - new Date(progress.updatedAt).getTime() > 30_000
}

function syncProgressAge(progress: SyncProgressUpdate): string {
  const seconds = Math.max(0, Math.floor((clockNow.value - new Date(progress.updatedAt).getTime()) / 1_000))
  return seconds < 60 ? `${seconds} 秒前更新` : `${Math.floor(seconds / 60)} 分钟前更新`
}

function syncProgressMessage(progress: SyncProgressUpdate): string {
  if (
    progress.source !== 'public_schedule' ||
    progress.status !== 'waiting' ||
    activeAiJob.value?.status !== 'pending'
  ) {
    return progress.message
  }
  const waitingMs = clockNow.value - new Date(progress.updatedAt).getTime()
  if (waitingMs < 10_000) return '等待 Codex 启动并领取同步任务'
  if (waitingMs < 30_000) return 'Codex 尚未接单，可能正在启动或建立网络连接'
  return 'Codex 仍在启动或连接；接单前的内部重试次数暂不可见'
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
    ;[credentialStatuses.value, backups.value] = await Promise.all([
      window.gacha.listCredentialStatuses(),
      window.gacha.listBackups()
    ])
  } catch (error) {
    showError(error)
  }
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

async function runSync(scope: SyncScope, target: SyncTarget = 'all'): Promise<void> {
  const gameId = selectedGameId.value
  sectionSyncMenuOpen.value = null
  syncing.value = true
  syncNotice.value = null
  try {
    const result = await window.gacha.syncGame(gameId, scope, target)
    if (selectedGameId.value === gameId) {
      syncNotice.value = { status: result.status, message: displaySyncMessage(result.message) }
      await Promise.all([loadItems(), loadSyncSettings(), loadSyncTargetStates(), loadActiveAiJob()])
    }
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  } finally {
    syncing.value = false
  }
}

async function runPersonalSync(target: SyncTarget = 'all'): Promise<void> {
  const gameId = selectedGameId.value
  sectionSyncMenuOpen.value = null
  syncing.value = true
  syncNotice.value = null
  personalSyncProgress.value = null
  try {
    const result = await window.gacha.syncPersonalData(gameId, target)
    if (selectedGameId.value === gameId) {
      syncNotice.value = { status: result.status, message: displaySyncMessage(result.message) }
      await Promise.all([loadItems(), loadSyncSettings(), loadSyncTargetStates()])
    }
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  } finally {
    syncing.value = false
    if (selectedGameId.value === gameId) personalSyncProgress.value = null
  }
}

function itemsFor(categories: ChecklistCategory[]): ChecklistItem[] {
  return items.value.filter(
    (item) =>
      categories.includes(item.category) &&
      (!showIncompleteOnly.value || !item.completed) &&
      (
        !activityTagFilter.value ||
        !['limited_event', 'permanent_event'].includes(item.category) ||
        item.activityTags.includes(activityTagFilter.value)
      )
  )
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
      activityTags: ['limited_event', 'permanent_event'].includes(form.category)
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
  try {
    await window.gacha.updateChecklistItem({ id: item.id, completed: !item.completed })
    await loadItems()
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
  <main class="app-shell" @click="sectionSyncMenuOpen = null">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">✦</span>幻游清单</div>
      <button class="overview active" type="button"><span>▦</span>总览</button>
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
          <span class="game-dot" :style="{ '--game-accent': game.accent }"></span>
          {{ game.name }}
        </button>
      </nav>
      <div class="sidebar-footer">
        <button type="button" @click="recycleBinOpen = true">♲ 回收站 <span>{{ archivedItems.length }}</span></button>
        <button type="button" @click="openSettings">⚙ 设置</button>
      </div>
    </aside>

    <section class="workspace">
      <header class="topbar">
        <div>
          <p class="eyebrow">本地任务总览</p>
          <h1>{{ selectedGame?.name ?? '幻游清单' }}</h1>
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
                ? '已安装 Codex 插件；点击后在 Codex 处理资料任务'
                : '刷新清单需要连接 Codex/MCP'"
            @click="runSync('public_schedule')"
          >
            {{ hasActivePublicSync ? 'AI 处理中…' : syncing ? '同步中…' : aiScheduleAvailable ? '↻ 刷新清单' : '↻ 未连接 AI' }}
          </button>
          <span
            class="sync-indicator"
            :class="{ synced: Boolean(globalSyncState?.lastSuccessAt) }"
            :title="globalSyncState?.lastSuccessAt
              ? `最后全局同步：${new Date(globalSyncState.lastSuccessAt).toLocaleString()}`
              : '尚未完成全局同步'"
          >
            <strong>全局清单 · {{ globalSyncState?.lastSuccessAt ? '已同步' : '未同步' }}</strong>
            <time v-if="globalSyncState?.lastSuccessAt">{{ formatSyncTimestamp(globalSyncState.lastSuccessAt) }}</time>
          </span>
        </div>
      </header>

      <p v-if="errorMessage" class="error-banner" role="alert">{{ errorMessage }}</p>
      <div v-if="needsInitialSync" class="onboarding-banner">
        <div>
          <strong>先完成一次初始全局同步</strong>
        </div>
        <button type="button" :disabled="syncing || hasActivePublicSync" @click="aiScheduleAvailable ? runSync('public_schedule', 'all') : settingsOpen = true">
          {{ aiScheduleAvailable ? '开始初始同步' : '配置 Codex/MCP' }}
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
              {{ syncProgressStalled(progress) ? `进度暂未变化 · ${syncProgressAge(progress)}` : syncProgressAge(progress) }}
            </small>
          </div>
          <button
            v-if="progress.source === 'public_schedule' && activeAiJob?.status === 'pending' && aiScheduleAgent?.codexPluginInstalled"
            type="button"
            @click="openCodexPlugin"
          >打开 Codex 接单</button>
        </article>
      </div>
      <div v-else-if="syncNotice" class="sync-banner" :class="syncNotice.status" aria-live="polite">
        <span>{{ syncNotice.message }}</span>
        <button
          v-if="aiScheduleAgent?.codexPluginInstalled && !aiScheduleAgent?.connected && syncNotice.status === 'partial' && !activeAiJob"
          type="button"
          @click="openCodexPlugin"
        >打开 Codex 处理</button>
      </div>
      <section class="summary-grid">
        <article class="summary-card">
          <span class="summary-icon coral">□</span>
          <div><small>未完成</small><strong>{{ incompleteCount }}<em> 项</em></strong></div>
        </article>
        <article class="summary-card">
          <span class="summary-icon gold">⌛</span>
          <div><small>即将到期</small><strong>{{ expiringCount }}<em> 项</em></strong></div>
        </article>
        <article class="summary-card">
          <span class="summary-icon green">✓</span>
          <div><small>本周完成</small><strong>{{ completedCount }}<em> 项</em></strong></div>
        </article>
      </section>

      <section v-if="loading" class="panel centered" role="status" aria-live="polite">正在读取本地清单…</section>
      <template v-else>
        <section class="content-grid">
          <div v-for="(column, columnIndex) in panelColumns" :key="columnIndex" class="checklist-column">
            <article v-for="panel in column" :key="panel.title" class="panel checklist-card">
              <div class="section-header">
                <div class="section-title">
                  <h2><span>{{ panel.icon }}</span>{{ panel.title }}</h2>
                  <span
                    v-if="panel.syncTarget"
                    class="section-sync-indicator"
                    :class="{ synced: Boolean(syncTargetState(panel.syncTarget)?.lastSuccessAt) }"
                    :title="syncTargetState(panel.syncTarget)?.lastSuccessAt
                      ? `最后同步：${new Date(syncTargetState(panel.syncTarget)!.lastSuccessAt!).toLocaleString()}`
                      : '该版块尚未同步'"
                  >
                    {{ syncTargetState(panel.syncTarget)?.lastSuccessAt ? '已同步' : '未同步' }}
                    <time v-if="syncTargetState(panel.syncTarget)?.lastSuccessAt">
                      {{ formatSyncTimestamp(syncTargetState(panel.syncTarget)!.lastSuccessAt!) }}
                    </time>
                  </span>
                </div>
                <div class="section-actions">
                  <button
                    v-if="panel.syncTarget === 'tasks'"
                    class="section-sync-button"
                    type="button"
                    :disabled="syncing || !aiScheduleAvailable || hasActivePublicSync"
                    @click="runSync('public_schedule', 'tasks')"
                  >↻ 版更校时</button>
                  <div v-else-if="panel.syncTarget" class="dropdown" @click.stop>
                    <button
                      class="section-sync-button"
                      type="button"
                      :disabled="syncing"
                      aria-haspopup="menu"
                      :aria-expanded="sectionSyncMenuOpen === panel.section"
                      @click="sectionSyncMenuOpen = sectionSyncMenuOpen === panel.section ? null : panel.section"
                    >↻ 同步 ▾</button>
                    <div v-if="sectionSyncMenuOpen === panel.section" class="dropdown-menu section-sync-menu" role="menu">
                      <button role="menuitem" type="button" :disabled="!aiScheduleAvailable || hasActivePublicSync" @click="runSync('public_schedule', panel.syncTarget)">同步清单</button>
                      <button
                        v-if="personalSyncTargets.includes(panel.syncTarget)"
                        role="menuitem"
                        type="button"
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
              </div>
              <label v-if="panel.section === 'events' && activityTagOptions.length > 0" class="activity-tag-filter">
                <span>玩法筛选</span>
                <select v-model="activityTagFilter">
                  <option value="">全部玩法</option>
                  <option v-for="tag in activityTagOptions" :key="tag" :value="tag">{{ tag }}</option>
                </select>
              </label>
              <div class="item-list">
                <div
                  v-for="item in itemsFor(panel.categories)"
                  :key="item.id"
                  class="checklist-row"
                  :class="{ completed: item.completed }"
                >
                  <button class="check-button" type="button" :aria-label="item.completed ? '标为未完成' : '标为完成'" @click="toggleCompleted(item)">
                    {{ item.completed ? '✓' : '' }}
                  </button>
                  <button class="item-main" type="button" :title="item.title" @click="openEdit(item)">
                    <span class="item-title">{{ item.title }}</span>
                    <span class="item-details">
                      <b>{{ categoryLabels[item.category] }}</b>
                      <span
                        v-for="tag in item.activityTags"
                        :key="tag"
                        class="activity-tag"
                      >{{ tag }}</span>
                      <span v-if="item.parentTitle">{{ item.parentTitle }}</span>
                      <span v-if="item.category === 'exploration' && item.progressPercent !== null">
                        {{ item.progressPercent }}%
                      </span>
                      <span v-if="item.resetRule" class="reset-detail">{{ item.resetRule }}</span>
                      <span
                        v-if="item.source !== 'manual' && item.lastSyncedAt"
                        class="source-detail"
                        :title="`${item.source === 'public_schedule' ? '公开资料' : '个人数据'} · 同步于 ${formatLocalTime(item.lastSyncedAt)}${item.sourceUrl ? ` · ${item.sourceUrl}` : ''}`"
                      >
                        {{ item.source === 'public_schedule' ? '公开资料' : '个人数据' }}
                      </span>
                    </span>
                    <span v-if="item.startsAt && isUpcoming(item.startsAt)" class="item-timing deadline upcoming">{{ countdown(item.startsAt, '距离开始') }}</span>
                    <span
                      v-else-if="item.endsAt"
                      class="item-timing deadline"
                      :class="{ expired: isExpired(item.endsAt), urgent: isUrgentDeadline(item.endsAt) }"
                    >{{ countdown(item.endsAt) }}</span>
                  </button>
                  <button class="more-button" type="button" aria-label="编辑" @click="openEdit(item)">⋮</button>
                </div>
                <p v-if="itemsFor(panel.categories).length === 0" class="empty-text">暂无事项</p>
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
      </template>

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
        <label v-if="['limited_event', 'permanent_event'].includes(form.category)">
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
          <button class="close-button" type="button" aria-label="关闭回收站" @click="recycleBinOpen = false">×</button>
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
        <p class="recycle-hint">隐藏不玩的游戏只会移除左侧入口，不会删除任何清单或同步数据。</p>
        <div class="game-visibility-list">
          <label v-for="game in games" :key="game.id" class="game-visibility-row">
            <span><i class="game-dot" :style="{ '--game-accent': game.accent }"></i>{{ game.name }}</span>
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
                  ? '已安装 · 可先排队再由 Codex 领取'
                  : '未安装或未启用' }}</span>
            </div>
            <button
              class="secondary-button"
              type="button"
              @click="openCodexPlugin"
            >{{ aiScheduleAgent?.codexPluginInstalled ? '打开 Codex' : '安装 / 启用' }}</button>
          </div>
        </div>
        <p class="recycle-hint">公开资料统一由 Codex/MCP 联网检索、交叉验证并结构化回写。首次点击“安装 / 启用”会打开本机插件页，由 Codex 完成安装；应用不会直接修改 Codex 缓存。</p>
        <h3 class="settings-heading data-heading">登录凭据</h3>
        <p class="recycle-hint">登录完全可选。凭据仅通过 Windows 安全存储加密后保存在本机，不读取浏览器 Cookie。</p>
        <div class="recycle-list">
          <div v-for="status in gameCredentialStatuses" :key="status.provider" class="recycle-row">
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
              >{{ status.stored ? '重新登录' : '手机号登录' }}</button>
              <button
                class="danger-button"
                type="button"
                :disabled="!status.stored"
                @click="clearCredential(status.provider)"
              >清除凭据</button>
            </div>
          </div>
        </div>
        <div class="settings-title-row">
          <h3 class="settings-heading data-heading">本地数据与备份</h3>
          <button class="secondary-button" type="button" :disabled="backingUp" @click="createBackup">
            {{ backingUp ? '备份中…' : '立即备份' }}
          </button>
        </div>
        <div class="data-location">
          <span>{{ appInfo?.dataPath }}</span>
          <button class="secondary-button" type="button" @click="openDataDirectory">打开目录</button>
        </div>
        <p class="recycle-hint">数据库位于 data 子目录；backups 子目录保留最近 30 份每日备份，手动与安全备份不自动清理。</p>
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
