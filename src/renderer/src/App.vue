<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type {
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
  GameVersionSummary,
  KuroCommunityRole,
  MiyousheQrLoginState,
  PersonalSyncTarget,
  RenderingMode,
  RenderingModeState,
  RemoteCatalogCheckResult,
  SoftwareUpdateCheckResult,
  SoftwareUpdateSettings,
  SyncProgressUpdate,
  SyncTarget,
  SyncTargetState,
  SyncSettings
} from '../../shared/contracts'
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
  orderPersonalSyncTargets,
  waitForPersonalSyncCooldown
} from './progress-sync'
import {
  buildMapTreeRows,
  collectMapBranchKeys,
  filterIncompleteMapTreeRows,
  type ChecklistTreeRow
} from './map-tree'
import { filterChecklistPanels } from './panel-visibility'
import {
  applyPersonalProgressUpdate,
  isTerminalPersonalProgress,
  personalProgressKey
} from './personal-sync-progress'
import { credentialProviderForSyncResult } from './sync-credential-notice'
import { isChecklistItemComplete } from './checklist-completion'
import { claimStartupAutoSync } from './startup-auto-sync'
import {
  filterUpcomingBaselineItems,
  readShowUpcomingBaselineItems,
  writeShowUpcomingBaselineItems
} from './upcoming-visibility'
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
  syncTarget?: PersonalSyncTarget
}

interface ConfirmationDialogState {
  eyebrow: string
  title: string
  message: string
  detail: string
  confirmLabel: string
  onConfirm: () => Promise<void>
}

const panels: ChecklistPanel[] = [
  { title: '活动', section: 'events', categories: ['limited_event'], defaultCategory: 'limited_event', syncTarget: 'events', allowCreate: false, allowClear: false },
  { title: '周期', section: 'cycles', categories: ['endgame'], defaultCategory: 'endgame', syncTarget: 'cycles', allowCreate: false, allowClear: false },
  { title: '地图', section: 'exploration', categories: ['exploration'], defaultCategory: 'exploration', syncTarget: 'exploration', allowCreate: false, allowClear: false },
  { title: '自定义清单', section: 'custom', categories: ['custom'], defaultCategory: 'custom', createLabel: '自定义事项', allowCreate: true, allowClear: true }
]
const panelBySection = new Map(panels.map((panel) => [panel.section, panel]))

const workspaceElement = ref<HTMLElement | null>(null)

const categoryLabels: Record<ChecklistCategory, string> = {
  limited_event: '限时活动',
  endgame: '深渊/挑战模式',
  exploration: '地图',
  custom: '自定义事项'
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
const showUpcomingBaselineItems = ref(readShowUpcomingBaselineItems(window.localStorage))
const globalPersonalSyncBusy = ref(false)
const collapsedMapKeys = ref(new Set<string>())
const collapsedMapKeysByGame = new Map<GameId, Set<string>>()
const knownMapBranchKeysByGame = new Map<GameId, Set<string>>()
const checklistScrollByGame = new Map<GameId, ChecklistScrollSnapshot>()
const activeSyncRequests = ref(new Set<string>())
const syncSettings = ref<SyncSettings | null>(null)
const syncSettingsByGame = ref<Partial<Record<GameId, SyncSettings>>>({})
const syncTargetStates = ref<SyncTargetState[]>([])
const personalSyncTargets = ref<PersonalSyncTarget[]>([])
const clockNow = ref(Date.now())
const editorOpen = ref(false)
const recycleBinOpen = ref(false)
const settingsOpen = ref(false)
const confirmationDialog = ref<ConfirmationDialogState | null>(null)
const confirmationBusy = ref(false)
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
const personalSyncProgressByKey = ref<Record<string, SyncProgressUpdate>>({})
const editingItem = ref<ChecklistItem | null>(null)
const renderingModeState = ref<RenderingModeState | null>(null)
const renderingModeSelection = ref<RenderingMode>('compatibility')
const renderingModeBusy = ref(false)
const renderingModeMessage = ref('')
const softwareUpdateSettings = ref<SoftwareUpdateSettings>({
  autoCheckEnabled: true,
  updateSource: 'auto',
  lastSuccessfulCheckAt: null,
  lastAutomaticCheckAt: null
})
const softwareUpdateBusy = ref(false)
const softwareUpdateMessage = ref('')
const remoteCatalogUpdateBusy = ref(false)
const remoteCatalogUpdateMessage = ref('')
const remoteCatalogManualRetryAt = ref<string | null>(null)
const remoteCatalogManualRetryMinutes = computed(() => {
  if (!remoteCatalogManualRetryAt.value) return 0
  return Math.max(0, Math.ceil(
    (Date.parse(remoteCatalogManualRetryAt.value) - clockNow.value) / 60_000
  ))
})
const loginRequiredOpen = ref(false)
const pendingPersonalSyncIntent = ref<{
  gameId: GameId
  target: PersonalSyncTarget | 'all'
} | null>(null)
let startupAutoSyncStarted = false
let miyousheLoginTimer: number | null = null

const form = reactive({
  category: 'custom' as ChecklistCategory,
  title: ''
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
const orderedGames = computed(() => orderGamesByVersion(
  games.value,
  gameVersionSummaries.value,
  clockNow.value
))
const visibleGames = computed(() => orderedGames.value.filter(
  (game) => !hiddenGameIds.value.includes(game.id)
))
const gameCredentialStatuses = computed(() => credentialStatuses.value)
const displayItems = computed(() => filterUpcomingBaselineItems(
  items.value,
  clockNow.value,
  showUpcomingBaselineItems.value
))
onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('wheel', handlePanelDragWheel, { capture: true, passive: false })
  window.addEventListener('blur', endPanelDrag)
  try {
    ;[
      games.value,
      gameVersionSummaries.value,
      appInfo.value
    ] = await Promise.all([
      window.gtask.listGames(),
      window.gtask.listGameVersionSummaries(),
      window.gtask.getAppInfo()
    ])
    if (hiddenGameIds.value.includes(selectedGameId.value)) {
      selectedGameId.value = visibleGames.value[0]?.id ?? 'genshin'
    }
    await Promise.all([
      loadItems(),
      loadArchivedItems(),
      loadSyncSettings(),
      loadAllSyncSettings(),
      loadSyncTargetStates(),
      loadPersonalSyncTargets(),
      loadCredentialStatuses()
    ])
    void runStartupAutoSync()
  } catch (error) {
    showError(error)
  } finally {
    loading.value = false
  }
})

const removeSyncListener = window.gtask.onSyncCompleted((result) => {
  if (result.gameId !== selectedGameId.value) return
  void Promise.all([
    loadItems(),
    loadGameVersionSummaries(),
    loadSyncSettings(),
    loadSyncTargetStates()
  ])
})
const removeChecklistListener = window.gtask.onChecklistChanged(() => {
  void Promise.all([
    loadItems(),
    loadGameVersionSummaries(),
    loadArchivedItems(),
    loadSyncSettings(),
    loadSyncTargetStates()
  ])
})
const removeSyncProgressListener = window.gtask.onSyncProgress((progress) => {
  if (progress.source === 'personal_data') {
    if (progress.target === 'all' || progress.target === 'tasks') return
    personalSyncProgressByKey.value = applyPersonalProgressUpdate(
      personalSyncProgressByKey.value,
      progress
    )
    if (isTerminalPersonalProgress(progress)) {
      if (progress.gameId === selectedGameId.value) {
        void Promise.all([
          loadItems(),
          loadSyncSettings(),
          loadSyncTargetStates()
        ])
      }
      return
    }
    return
  }
})
const clockTimer = window.setInterval(() => {
  clockNow.value = Date.now()
}, 1_000)
onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('wheel', handlePanelDragWheel, true)
  window.removeEventListener('blur', endPanelDrag)
  removeSyncListener()
  removeChecklistListener()
  removeSyncProgressListener()
  window.clearInterval(clockTimer)
  stopMiyousheLoginPolling()
})

function handleGlobalKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  if (confirmationDialog.value) {
    closeConfirmationDialog()
    return
  }
  if (miyousheLoginOpen.value) {
    void closeMiyousheLogin()
    return
  }
  if (kuroCredentialOpen.value) {
    void closeKuroCommunityLogin()
    return
  }
  if (loginRequiredOpen.value) {
    loginRequiredOpen.value = false
    pendingPersonalSyncIntent.value = null
    return
  }
  editorOpen.value = false
  recycleBinOpen.value = false
  settingsOpen.value = false
}

function openConfirmationDialog(dialog: ConfirmationDialogState): void {
  if (confirmationBusy.value) return
  confirmationDialog.value = dialog
}

function closeConfirmationDialog(): void {
  if (confirmationBusy.value) return
  confirmationDialog.value = null
}

async function confirmDialogAction(): Promise<void> {
  const dialog = confirmationDialog.value
  if (!dialog || confirmationBusy.value) return
  confirmationBusy.value = true
  try {
    await dialog.onConfirm()
    if (confirmationDialog.value === dialog) confirmationDialog.value = null
  } catch (error) {
    showError(error)
  } finally {
    confirmationBusy.value = false
  }
}

watch(selectedGameId, async (gameId, previousGameId) => {
  if (previousGameId) {
    checklistScrollByGame.set(previousGameId, captureChecklistScroll())
  }
  restoringGameView.value = true
  items.value = []
  draggingPanelSection.value = null
  panelDropTarget.value = null
  recycleBinOpen.value = false
  let savedScroll: ChecklistScrollSnapshot | undefined
  try {
    await Promise.all([
      loadItems({ showLoading: true, preserveScroll: false }),
      loadArchivedItems(),
      loadSyncSettings(),
      loadSyncTargetStates(),
      loadPersonalSyncTargets()
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
    const loadedItems = await window.gtask.listChecklistItems(gameId)
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
    gameVersionSummaries.value = await window.gtask.listGameVersionSummaries()
  } catch (error) {
    showError(error)
  }
}

async function loadSyncSettings(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const loadedSettings = await window.gtask.getSyncSettings(gameId)
    syncSettingsByGame.value = { ...syncSettingsByGame.value, [gameId]: loadedSettings }
    if (selectedGameId.value === gameId) syncSettings.value = loadedSettings
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

async function loadAllSyncSettings(): Promise<void> {
  try {
    const settings = await Promise.all(games.value.map((game) =>
      window.gtask.getSyncSettings(game.id)
    ))
    syncSettingsByGame.value = Object.fromEntries(
      settings.map((entry) => [entry.gameId, entry])
    ) as Partial<Record<GameId, SyncSettings>>
    syncSettings.value = syncSettingsByGame.value[selectedGameId.value] ?? null
  } catch (error) {
    showError(error)
  }
}

async function loadCredentialStatuses(): Promise<void> {
  credentialStatuses.value = await window.gtask.listCredentialStatuses()
}

async function saveAutoSyncPreference(gameId: GameId, enabled: boolean): Promise<void> {
  const previous = syncSettingsByGame.value[gameId]
  if (!previous) return
  syncSettingsByGame.value = {
    ...syncSettingsByGame.value,
    [gameId]: { ...previous, autoSyncEnabled: enabled }
  }
  try {
    const saved = await window.gtask.updateSyncSettings(gameId, { autoSyncEnabled: enabled })
    syncSettingsByGame.value = { ...syncSettingsByGame.value, [gameId]: saved }
    if (selectedGameId.value === gameId) syncSettings.value = saved
  } catch (error) {
    syncSettingsByGame.value = { ...syncSettingsByGame.value, [gameId]: previous }
    showError(error)
  }
}

function credentialProviderForGame(gameId: GameId): CredentialProvider {
  return gameId === 'wuthering-waves' ? 'kuro-community' : 'miyoushe'
}

async function ensurePersonalSyncCredential(
  gameId: GameId,
  target: PersonalSyncTarget | 'all',
  interactive = true
): Promise<boolean> {
  credentialStatuses.value = await window.gtask.listCredentialStatuses()
  const provider = credentialProviderForGame(gameId)
  const credential = credentialStatuses.value.find((status) => status.provider === provider)
  if (credential?.stored) return true
  if (interactive) {
    pendingPersonalSyncIntent.value = { gameId, target }
    loginRequiredOpen.value = true
  }
  return false
}

async function runPersonalSyncBatch(
  gameId = selectedGameId.value,
  interactive = true
): Promise<boolean> {
  if (globalPersonalSyncBusy.value) return false
  globalPersonalSyncBusy.value = true
  try {
    if (!await ensurePersonalSyncCredential(gameId, 'all', interactive)) return false
    const supportedTargets = orderPersonalSyncTargets(
      await window.gtask.getPersonalSyncTargets(gameId)
    )
    if (supportedTargets.length === 0) {
      if (interactive && selectedGameId.value === gameId) {
        errorMessage.value = '这个游戏暂时不能同步进度'
      }
      return false
    }
    for (let index = 0; index < supportedTargets.length; index += 1) {
      if (index > 0) await waitForPersonalSyncCooldown()
      if (!await runPersonalSync(supportedTargets[index], gameId, true)) return false
    }
    return true
  } catch (error) {
    if (interactive && selectedGameId.value === gameId) showError(error)
    return false
  } finally {
    globalPersonalSyncBusy.value = false
  }
}

async function runStartupAutoSync(): Promise<void> {
  if (startupAutoSyncStarted) return
  startupAutoSyncStarted = true
  const enabledGames = games.value.filter(
    (game) => syncSettingsByGame.value[game.id]?.autoSyncEnabled
  )
  if (enabledGames.length === 0 || !claimStartupAutoSync(window.localStorage)) return
  for (const game of enabledGames) {
    await runPersonalSyncBatch(game.id, false)
  }
}

async function loadSyncTargetStates(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const states = await window.gtask.getSyncTargetStates(gameId)
    if (selectedGameId.value === gameId) syncTargetStates.value = states
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

async function loadPersonalSyncTargets(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const targets = await window.gtask.getPersonalSyncTargets(gameId)
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
  if (state.status === 'success') return '已同步'
  if (state.status === 'stale') return '部分同步'
  if (state.status === 'error') return '同步失败'
  if (state.status === 'verification_required') return '需要验证'
  return '同步中'
}

function syncStateClass(state: SyncTargetState | undefined): string {
  return state?.status ?? 'idle'
}

async function loadArchivedItems(): Promise<void> {
  const gameId = selectedGameId.value
  try {
    const loadedItems = await window.gtask.listArchivedChecklistItems(gameId)
    if (selectedGameId.value === gameId) archivedItems.value = loadedItems
  } catch (error) {
    if (selectedGameId.value === gameId) showError(error)
  }
}

async function openSettings(): Promise<void> {
  settingsOpen.value = true
  try {
    const [
      statuses,
      listedBackups,
      loadedRenderingMode,
      loadedUpdateSettings,
      loadedCatalogStatus
    ] = await Promise.all([
      window.gtask.listCredentialStatuses(),
      window.gtask.listBackups(),
      window.gtask.getRenderingModeState(),
      window.gtask.getSoftwareUpdateSettings(),
      window.gtask.getRemoteCatalogUpdateStatus()
    ])
    credentialStatuses.value = statuses
    backups.value = listedBackups
    await loadAllSyncSettings()
    renderingModeState.value = loadedRenderingMode
    renderingModeSelection.value = loadedRenderingMode.configured
    renderingModeMessage.value = ''
    softwareUpdateSettings.value = loadedUpdateSettings
    softwareUpdateMessage.value = ''
    remoteCatalogManualRetryAt.value = loadedCatalogStatus.manualRetryAt
    remoteCatalogUpdateMessage.value = ''
  } catch (error) {
    showError(error)
  }
}

function closeSettings(): void {
  settingsOpen.value = false
}

function isGameVisible(gameId: GameId): boolean {
  return !hiddenGameIds.value.includes(gameId)
}

function toggleGameVisibility(gameId: GameId): void {
  const currentlyVisible = isGameVisible(gameId)
  if (currentlyVisible && visibleGames.value.length === 1) {
    errorMessage.value = '至少要显示一款游戏'
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

function saveUpcomingBaselineVisibility(enabled: boolean): void {
  try {
    showUpcomingBaselineItems.value = writeShowUpcomingBaselineItems(
      window.localStorage,
      enabled
    )
  } catch (error) {
    showError(error)
  }
}

async function createBackup(): Promise<void> {
  if (backingUp.value) return
  backingUp.value = true
  try {
    await window.gtask.createBackup()
    backups.value = await window.gtask.listBackups()
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
    const restarting = await window.gtask.restoreBackup(backup.fileName)
    if (!restarting) restoringBackup.value = null
  } catch (error) {
    restoringBackup.value = null
    showError(error)
  }
}

async function clearCredential(provider: CredentialProvider): Promise<void> {
  const platform = provider === 'miyoushe' ? '米游社' : '库街区'
  if (!window.confirm(`确定清除${platform}的登录信息吗？`)) return
  try {
    await window.gtask.clearCredential(provider)
    credentialStatuses.value = await window.gtask.listCredentialStatuses()
  } catch (error) {
    showError(error)
  }
}

async function startMiyousheLogin(): Promise<void> {
  if (startingMiyousheLogin.value) return
  startingMiyousheLogin.value = true
  stopMiyousheLoginPolling()
  try {
    miyousheLoginState.value = await window.gtask.startMiyousheQrLogin()
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
    const nextState = await window.gtask.pollMiyousheQrLogin(state.sessionId)
    if (miyousheLoginState.value?.sessionId !== state.sessionId) return
    miyousheLoginState.value = nextState
    if (nextState.status === 'confirmed') {
      stopMiyousheLoginPolling()
      credentialStatuses.value = await window.gtask.listCredentialStatuses()
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
  const shouldResumeSync = miyousheLoginState.value?.status === 'confirmed'
  const finished = ['confirmed', 'expired'].includes(miyousheLoginState.value?.status ?? '')
  stopMiyousheLoginPolling()
  miyousheLoginOpen.value = false
  miyousheLoginState.value = null
  if (sessionId && !finished) {
    try {
      await window.gtask.cancelMiyousheQrLogin(sessionId)
    } catch {
      // Closing the UI remains safe even if the in-memory session already expired.
    }
  }
  if (shouldResumeSync) await resumePendingPersonalSync()
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
      await window.gtask.cancelKuroCommunityLogin(sessionId)
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
    const state = await window.gtask.sendKuroCommunitySms(kuroLoginPhone.value)
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
    const result = await window.gtask.completeKuroCommunityLogin(
      kuroLoginSessionId.value,
      kuroLoginCode.value
    )
    kuroCredentialRoles.value = result.roles
    kuroSelectedRoleKey.value = result.roles.length === 1 ? kuroRoleKey(result.roles[0]) : ''
    kuroLoginPhase.value = 'role'
    kuroCredentialMessage.value = result.roles.length === 1
      ? '已经找到角色，确认后就能保存'
      : `找到了 ${result.roles.length} 个角色，请选择要同步的角色`
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
    kuroCredentialMessage.value = '角色选择失效了，请重新登录后再选一次'
    return
  }
  kuroCredentialBusy.value = true
  kuroCredentialMessage.value = '正在确认库街区能否读取这个角色…'
  try {
    await window.gtask.storeKuroCommunityLogin(
      kuroLoginSessionId.value,
      role.roleId,
      role.serverId
    )
    credentialStatuses.value = await window.gtask.listCredentialStatuses()
    kuroCredentialBusy.value = false
    await closeKuroCommunityLogin()
    await resumePendingPersonalSync()
  } catch (error) {
    kuroCredentialMessage.value = error instanceof Error
      ? error.message
      : '库街区登录信息验证失败，请重试'
    showError(error)
    kuroCredentialBusy.value = false
  }
}

async function beginPendingPersonalLogin(): Promise<void> {
  const intent = pendingPersonalSyncIntent.value
  if (!intent) return
  loginRequiredOpen.value = false
  if (credentialProviderForGame(intent.gameId) === 'miyoushe') {
    await startMiyousheLogin()
  } else {
    openKuroCommunityLogin()
  }
}

async function resumePendingPersonalSync(): Promise<void> {
  const intent = pendingPersonalSyncIntent.value
  pendingPersonalSyncIntent.value = null
  if (!intent) return
  if (intent.target === 'all') {
    await runPersonalSyncBatch(intent.gameId)
  } else {
    await runPersonalSync(intent.target, intent.gameId)
  }
}

async function openDataDirectory(): Promise<void> {
  try {
    await window.gtask.openDataDirectory()
  } catch (error) {
    showError(error)
  }
}

async function saveRenderingMode(): Promise<void> {
  if (renderingModeBusy.value) return
  renderingModeBusy.value = true
  renderingModeMessage.value = '正在保存…'
  try {
    const state = await window.gtask.updateRenderingMode(renderingModeSelection.value)
    renderingModeState.value = state
    if (!state.restartRequired) {
      renderingModeMessage.value = '已经在使用这个模式。'
      return
    }
    renderingModeMessage.value = '已保存，正在重启 Gtask…'
    await window.gtask.restartApp()
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
    softwareUpdateSettings.value = await window.gtask.updateSoftwareUpdateSettings({
      autoCheckEnabled: softwareUpdateSettings.value.autoCheckEnabled,
      updateSource: softwareUpdateSettings.value.updateSource
    })
    softwareUpdateMessage.value = '设置已保存'
  } catch (error) {
    softwareUpdateSettings.value = await window.gtask.getSoftwareUpdateSettings()
    softwareUpdateMessage.value = ''
    showError(error)
  } finally {
    softwareUpdateBusy.value = false
  }
}

async function checkSoftwareUpdate(): Promise<void> {
  if (softwareUpdateBusy.value) return
  remoteCatalogUpdateMessage.value = ''
  softwareUpdateBusy.value = true
  softwareUpdateMessage.value = '正在检查更新…'
  try {
    const result: SoftwareUpdateCheckResult = await window.gtask.checkSoftwareUpdate()
    softwareUpdateMessage.value = result.message
    softwareUpdateSettings.value = await window.gtask.getSoftwareUpdateSettings()
    if (result.outcome === 'update_available' && result.releaseUrl) {
      const confirmed = window.confirm(`${result.message}，是否查看更新？`)
      if (confirmed) await window.gtask.openExternalUrl(result.releaseUrl)
    }
  } catch (error) {
    softwareUpdateMessage.value = '暂时无法检查更新，请稍后重试'
    showError(error)
  } finally {
    softwareUpdateBusy.value = false
  }
}

async function checkRemoteCatalogUpdate(): Promise<void> {
  if (remoteCatalogUpdateBusy.value || remoteCatalogManualRetryMinutes.value > 0) return
  softwareUpdateMessage.value = ''
  remoteCatalogUpdateBusy.value = true
  remoteCatalogUpdateMessage.value = '正在更新活动和任务…'
  try {
    const result: RemoteCatalogCheckResult = await window.gtask.checkRemoteCatalogUpdate()
    remoteCatalogUpdateMessage.value = result.message
    remoteCatalogManualRetryAt.value = result.manualRetryAt
  } catch (error) {
    remoteCatalogUpdateMessage.value = '暂时无法更新活动和任务，请稍后重试'
    showError(error)
  } finally {
    remoteCatalogUpdateBusy.value = false
  }
}

function formatUpdateCheckTime(value: string | null): string {
  if (!value) return '还没检查过'
  return `上次检查 ${new Date(value).toLocaleString('zh-CN', { hour12: false })}`
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

function hasActivePersonalSyncForTarget(
  target: PersonalSyncTarget,
  gameId = selectedGameId.value
): boolean {
  const progress = personalSyncProgressByKey.value[
    personalProgressKey(gameId, target)
  ]
  return isSyncRequestActive('personal_data', target, gameId) || Boolean(
    progress && ['waiting', 'running', 'verification_required'].includes(progress.status)
  )
}

const hasActivePersonalSync = computed(() =>
  personalSyncTargets.value.some((target) => hasActivePersonalSyncForTarget(target))
)
const globalSyncBusy = computed(() =>
  globalPersonalSyncBusy.value ||
  hasActivePersonalSync.value
)

const visiblePanels = computed(() => filterChecklistPanels(
  orderedPanels.value,
  displayItems.value.map((item) => ({
    category: item.category,
    completed: isChecklistItemComplete(item)
  })),
  showIncompleteOnly.value
))

async function runPersonalSync(
  target: PersonalSyncTarget,
  gameId = selectedGameId.value,
  credentialChecked = false
): Promise<boolean> {
  if (hasActivePersonalSyncForTarget(target, gameId)) return false
  if (!credentialChecked && !await ensurePersonalSyncCredential(gameId, target)) return false
  setSyncRequestActive(gameId, 'personal_data', target, true)
  const progressKey = personalProgressKey(gameId, target)
  const nextProgress = { ...personalSyncProgressByKey.value }
  delete nextProgress[progressKey]
  personalSyncProgressByKey.value = nextProgress
  try {
    const result = await window.gtask.syncPersonalData(gameId, target, {
      outputLocale: document.documentElement.lang || 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    })
    if (selectedGameId.value === gameId) {
      const credentialProvider = credentialProviderForSyncResult(result)
      await Promise.all([loadItems(), loadSyncSettings(), loadSyncTargetStates()])
      if (credentialProvider) {
        pendingPersonalSyncIntent.value = { gameId, target }
        loginRequiredOpen.value = true
      }
    }
    return result.status !== 'error' && result.status !== 'cancelled' &&
      !credentialProviderForSyncResult(result)
  } catch {
    return false
  } finally {
    setSyncRequestActive(gameId, 'personal_data', target, false)
    if (selectedGameId.value === gameId) {
      const remainingProgress = { ...personalSyncProgressByKey.value }
      delete remainingProgress[progressKey]
      personalSyncProgressByKey.value = remainingProgress
    }
  }
}

function itemsFor(categories: ChecklistCategory[]): ChecklistItem[] {
  return displayItems.value.filter(
    (item) =>
      categories.includes(item.category) &&
      (!showIncompleteOnly.value || !isChecklistItemComplete(item))
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
  const rows = buildMapTreeRows(
    visible,
    collapsedMapKeys.value,
    displayItems.value.filter((item) => item.category === 'exploration'),
    !showIncompleteOnly.value
  )
  return showIncompleteOnly.value ? filterIncompleteMapTreeRows(rows) : rows
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
  if (section === 'custom') openEdit(item)
}

function openCreate(category: ChecklistCategory): void {
  if (category !== 'custom') return
  editingItem.value = null
  form.category = 'custom'
  form.title = ''
  editorOpen.value = true
}

function openEdit(item: ChecklistItem): void {
  if (item.category !== 'custom' || item.source !== 'manual') return
  editingItem.value = item
  form.category = 'custom'
  form.title = item.title
  editorOpen.value = true
}

async function saveItem(): Promise<void> {
  if (!form.title.trim() || saving.value) return
  saving.value = true
  errorMessage.value = ''
  try {
    const common: Omit<CreateChecklistItemInput, 'gameId'> = {
      category: 'custom',
      title: form.title,
      activityTags: [],
      progressPercent: null,
      parentTitle: null,
      startsAt: null,
      endsAt: null,
      resetRule: null,
      scheduleKind: null,
      resetWeekday: null,
      timeZone: null,
      modeKey: null,
      recurrenceRule: null
    }
    const saved = editingItem.value
      ? await window.gtask.updateChecklistItem({ id: editingItem.value.id, ...common })
      : await window.gtask.createChecklistItem({ gameId: selectedGameId.value, ...common })

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
    const updatedItems = await window.gtask.setChecklistCompletion(item.id, !item.completed)
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

function archiveItem(item: ChecklistItem): void {
  openConfirmationDialog({
    eyebrow: selectedGame.value?.name ?? '自定义清单',
    title: '删除事项',
    message: `确定删除“${item.title}”吗？`,
    detail: '删除后可以从回收站恢复。',
    confirmLabel: '删除',
    onConfirm: async () => {
      await window.gtask.archiveChecklistItem(item.id)
      items.value = items.value.filter((candidate) => candidate.id !== item.id)
      archivedItems.value.unshift(item)
      editorOpen.value = false
    }
  })
}

function archiveCompletedSection(
  section: ChecklistSection,
  categories: ChecklistCategory[],
  sectionTitle: string
): void {
  const completedItems = items.value.filter(
    (item) => categories.includes(item.category) && item.completed && item.source === 'manual'
  )
  if (completedItems.length === 0) return
  const gameId = selectedGameId.value
  openConfirmationDialog({
    eyebrow: selectedGame.value?.name ?? '自定义清单',
    title: '删除已完成事项',
    message: `确定删除“${sectionTitle}”中的 ${completedItems.length} 个已完成事项吗？`,
    detail: '删除后可以从回收站恢复。',
    confirmLabel: '删除已完成',
    onConfirm: async () => {
      await window.gtask.archiveCompletedSection({ gameId, section })
      await Promise.all([loadItems(), loadArchivedItems()])
    }
  })
}

async function restoreItem(item: ChecklistItem): Promise<void> {
  try {
    const restored = await window.gtask.restoreChecklistItem(item.id)
    archivedItems.value = archivedItems.value.filter((candidate) => candidate.id !== item.id)
    items.value.push(restored)
  } catch (error) {
    showError(error)
  }
}

function emptyRecycleBin(): void {
  const count = archivedItems.value.length
  if (count === 0) return
  const gameId = selectedGameId.value
  openConfirmationDialog({
    eyebrow: selectedGame.value?.name ?? '游戏',
    title: '清空回收站',
    message: `确定永久删除回收站中的 ${count} 个事项吗？`,
    detail: '删除后无法恢复。',
    confirmLabel: '永久删除',
    onConfirm: async () => {
      const deleted = await window.gtask.emptyRecycleBin(gameId)
      if (deleted > 0) archivedItems.value = []
    }
  })
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

function showError(error: unknown): void {
  errorMessage.value = error instanceof Error ? error.message : '操作失败，请重试'
}
</script>

<template>
  <main class="app-shell">
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
          <p class="eyebrow">我的任务</p>
          <h1>{{ selectedGame?.name ?? 'Gtask' }}</h1>
        </div>
        <div v-if="!loading && !restoringGameView" class="topbar-actions">
          <label class="incomplete-filter-control">
            <span class="incomplete-filter-label">只看未完成</span>
            <input
              v-model="showIncompleteOnly"
              class="toggle-switch-input"
              type="checkbox"
              aria-label="只看未完成"
            >
            <span class="toggle-switch" aria-hidden="true">
              <span class="toggle-switch-thumb"></span>
            </span>
          </label>
        </div>
      </header>

      <p v-if="!loading && !restoringGameView && errorMessage" class="error-banner" role="alert">{{ errorMessage }}</p>

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
            'motion-suppressed': draggingPanelSection !== null || globalSyncBusy
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
                      <svg v-if="panel.section === 'events'" viewBox="0 0 24 24"><path d="M12 3v18M3 12h18"/><path d="M5.6 5.6 18.4 18.4M18.4 5.6 5.6 18.4"/><circle cx="12" cy="12" r="4"/></svg>
                      <svg v-else-if="panel.section === 'cycles'" viewBox="0 0 24 24"><path d="M20 8a8 8 0 1 0 .3 7"/><path d="M20 3v5h-5"/><path d="M12 7v5l3 2"/></svg>
                      <svg v-else-if="panel.section === 'exploration'" viewBox="0 0 24 24"><path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3V6Z"/><path d="M9 3v15M15 6v15"/></svg>
                      <svg v-else viewBox="0 0 24 24"><path d="M5 4h14v16H5z"/><path d="m8 9 2 2 4-4M8 15h8"/></svg>
                    </span>
                    <span class="section-title-text">{{ panel.title }}</span>
                  </h2>
                  <span
                    v-if="panel.syncTarget && personalSyncTargets.includes(panel.syncTarget)"
                    class="section-sync-indicator"
                    :class="syncStateClass(syncTargetState(panel.syncTarget))"
                    :title="syncStateTimestamp(syncTargetState(panel.syncTarget))
                      ? `同步时间：${new Date(syncStateTimestamp(syncTargetState(panel.syncTarget))!).toLocaleString()}`
                      : '这个版块还没同步'"
                  >
                    {{ syncStateLabel(syncTargetState(panel.syncTarget)) }}
                    <time v-if="syncStateTimestamp(syncTargetState(panel.syncTarget))">
                      {{ formatSyncTimestamp(syncStateTimestamp(syncTargetState(panel.syncTarget))!) }}
                    </time>
                  </span>
                </div>
                <div class="section-actions">
                  <div
                    v-if="panel.syncTarget && personalSyncTargets.includes(panel.syncTarget)"
                    class="section-sync-control"
                  >
                    <button
                      class="section-sync-button"
                      type="button"
                      :disabled="hasActivePersonalSyncForTarget(panel.syncTarget)"
                      @click="runPersonalSync(panel.syncTarget)"
                    >
                      <span>↻ 同步进度</span>
                    </button>
                  </div>
                  <button
                    v-if="panel.allowClear === true"
                    class="clear-completed-button"
                    type="button"
                    :disabled="!items.some((item) => panel.categories.includes(item.category) && item.completed && item.source === 'manual')"
                    @click="archiveCompletedSection(panel.section, panel.categories, panel.title)"
                  >删除已完成</button>
                </div>
              </div>
              <div class="item-list panel-item-columns">
                <TransitionGroup
                  v-for="(itemColumn, itemColumnIndex) in panelItemColumns(panel)"
                  :key="itemColumnIndex"
                  name="checklist-flow"
                  tag="div"
                  class="item-list-column"
                  :class="{ 'motion-suppressed': globalSyncBusy }"
                >
                  <div
                    v-for="row in itemColumn"
                    :key="row.item.id"
                    class="checklist-row"
                    :class="{
                      completed: row.item.completed,
                      'map-tree-row': panel.section === 'exploration',
                      'has-item-menu': panel.section === 'custom'
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
                    <span class="item-identity">
                      <span class="item-title">{{ row.item.title }}</span>
                      <span
                        v-for="tag in row.item.activityTags"
                        :key="tag"
                        class="activity-tag"
                      >{{ tag }}</span>
                      <span v-if="row.item.category === 'exploration' && row.displayProgressPercent !== null" class="item-progress">
                        {{ row.displayProgressPercent }}%
                      </span>
                    </span>
                    <span v-if="row.item.startsAt && isUpcoming(row.item.startsAt)" class="item-timing deadline upcoming">{{ countdown(row.item.startsAt, '距离开始') }}</span>
                    <span
                      v-else-if="row.item.endsAt"
                      class="item-timing deadline"
                      :class="{ expired: isExpired(row.item.endsAt), urgent: isUrgentDeadline(row.item.endsAt) }"
                    >{{ countdown(row.item.endsAt) }}</span>
                  </button>
                    <button v-if="panel.section === 'custom'" class="more-button" type="button" aria-label="编辑" @click="openEdit(row.item)">⋮</button>
                  </div>
                </TransitionGroup>
                <p v-if="panelItems(panel).length === 0" class="empty-text">这里还没有事项</p>
              </div>
              <button v-if="panel.allowCreate === true" class="add-button" type="button" @click="openCreate(panel.defaultCategory)">
                <span class="add-button-label"><span class="add-button-icon" aria-hidden="true">＋</span>新增{{ panel.createLabel ?? panel.title }}</span>
              </button>
          </article>
          <p v-if="visiblePanels.length === 0" key="filtered-empty" class="filtered-empty-state">
            没有未完成的事项
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

        <label>事项名称<input v-model="form.title" maxlength="100" autofocus placeholder="例如：刷角色突破素材" /></label>

        <div class="modal-actions">
          <button v-if="editingItem?.source === 'manual'" class="danger-button" type="button" @click="archiveItem(editingItem)">删除</button>
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
        <p class="recycle-hint">删除的自定义事项会先放在这里，随时可以恢复。</p>
        <div class="recycle-list">
          <div v-for="item in archivedItems" :key="item.id" class="recycle-row">
            <div>
              <strong>{{ item.title }}</strong>
              <span>{{ categoryLabels[item.category] }} · 手动事项</span>
            </div>
            <button class="secondary-button" type="button" @click="restoreItem(item)">恢复</button>
          </div>
          <p v-if="archivedItems.length === 0" class="empty-text">回收站里还没有内容</p>
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
        <p class="recycle-hint">隐藏游戏只会收起侧栏入口，不会删除数据。</p>
        <div class="game-visibility-list">
          <label v-for="game in games" :key="game.id" class="game-visibility-row">
            <span class="settings-game-label"><img class="game-icon" :src="gameIcons[game.id]" alt="" aria-hidden="true">{{ game.name }}</span>
            <input
              class="toggle-switch-input"
              type="checkbox"
              :checked="isGameVisible(game.id)"
              :disabled="isGameVisible(game.id) && visibleGames.length === 1"
              :aria-label="`显示 ${game.name}`"
              @change="toggleGameVisibility(game.id)"
            >
            <span class="toggle-switch" aria-hidden="true">
              <span class="toggle-switch-thumb"></span>
            </span>
          </label>
        </div>
        <h3 class="settings-heading">启动后自动同步</h3>
        <p class="recycle-hint">打开 Gtask 时自动同步所选游戏的个人进度；10 分钟内重复打开不会再次同步。</p>
        <div class="game-visibility-list">
          <label v-for="game in games" :key="`auto-sync:${game.id}`" class="game-visibility-row">
            <span class="settings-game-label"><img class="game-icon" :src="gameIcons[game.id]" alt="" aria-hidden="true">{{ game.name }}</span>
            <input
              class="toggle-switch-input"
              type="checkbox"
              :checked="syncSettingsByGame[game.id]?.autoSyncEnabled ?? false"
              :aria-label="`启动后自动同步 ${game.name}`"
              @change="saveAutoSyncPreference(game.id, ($event.target as HTMLInputElement).checked)"
            >
            <span class="toggle-switch" aria-hidden="true">
              <span class="toggle-switch-thumb"></span>
            </span>
          </label>
        </div>
        <h3 class="settings-heading">显示内容</h3>
        <div class="settings-box software-update-box">
          <label class="software-update-toggle">
            <span>
              <strong>显示还没开始的事项</strong>
              <small>默认隐藏还没开始的活动和任务，开始后会自动显示。</small>
            </span>
            <input
              class="toggle-switch-input"
              type="checkbox"
              :checked="showUpcomingBaselineItems"
              aria-label="显示还没开始的事项"
              @change="saveUpcomingBaselineVisibility(($event.target as HTMLInputElement).checked)"
            >
            <span class="toggle-switch" aria-hidden="true">
              <span class="toggle-switch-thumb"></span>
            </span>
          </label>
        </div>
        <h3 class="settings-heading">版块顺序</h3>
        <div class="panel-order-setting">
          <div>
            <strong>{{ selectedGame?.name }}</strong>
            <span>在总览里拖动标题旁的手柄，就能调整版块顺序。</span>
          </div>
          <button
            class="secondary-button settings-action-button"
            type="button"
            :disabled="panelOrderIsDefault"
            @click="resetPanelOrder"
          >默认顺序</button>
        </div>
        <h3 class="settings-heading">显示设置</h3>
        <div class="settings-box rendering-provider-box">
          <label class="rendering-mode-field">
            <span>显示模式</span>
            <select v-model="renderingModeSelection">
              <option value="compatibility">兼容模式（推荐）· 和游戏一起运行更稳定</option>
              <option value="accelerated">GPU 加速 · 更流畅</option>
            </select>
          </label>
          <div class="settings-control-footer">
            <span>{{ renderingModeMessage || (renderingModeState?.active === 'compatibility'
              ? '现在使用兼容模式，可以减少游戏、显卡驱动或叠加工具造成的残影。'
              : '现在使用 GPU 加速；如果和游戏一起运行时出现残影，请改回兼容模式。') }}</span>
            <button
              class="primary-button settings-action-button"
              type="button"
              :disabled="renderingModeBusy"
              @click="saveRenderingMode"
            >{{ renderingModeBusy ? '保存中…' : renderingModeSelection === renderingModeState?.active ? '保存设置' : '保存并重启' }}</button>
          </div>
        </div>
        <h3 class="settings-heading">软件更新</h3>
        <div class="settings-box software-update-box">
          <label class="software-update-toggle">
            <span>
              <strong>启动后自动检查更新</strong>
              <small>自动检查软件、活动和任务更新；24 小时内不会重复检查。</small>
            </span>
            <input
              v-model="softwareUpdateSettings.autoCheckEnabled"
              class="toggle-switch-input"
              type="checkbox"
              :disabled="softwareUpdateBusy || remoteCatalogUpdateBusy"
              aria-label="启动后自动检查更新"
              @change="saveSoftwareUpdatePreference"
            >
            <span class="toggle-switch" aria-hidden="true">
              <span class="toggle-switch-thumb"></span>
            </span>
          </label>
          <label class="software-update-source-field">
            <span>更新来源</span>
            <select
              v-model="softwareUpdateSettings.updateSource"
              :disabled="softwareUpdateBusy || remoteCatalogUpdateBusy"
              aria-label="更新来源"
              @change="saveSoftwareUpdatePreference"
            >
              <option value="auto">自动（Gitee 优先）</option>
              <option value="gitee">Gitee 镜像</option>
              <option value="github">GitHub</option>
            </select>
          </label>
          <div class="software-update-footer">
            <span>
              <strong>当前版本 v{{ appInfo?.version ?? '—' }}</strong>
              <small>{{ remoteCatalogUpdateMessage || softwareUpdateMessage || formatUpdateCheckTime(softwareUpdateSettings.lastSuccessfulCheckAt) }}</small>
            </span>
            <div class="software-update-actions">
              <button
                class="secondary-button settings-action-button"
                type="button"
                :disabled="softwareUpdateBusy || remoteCatalogUpdateBusy || remoteCatalogManualRetryMinutes > 0"
                @click="checkRemoteCatalogUpdate"
              >{{ remoteCatalogUpdateBusy ? '更新中…' : remoteCatalogManualRetryMinutes > 0 ? `${remoteCatalogManualRetryMinutes}分重试` : '更新清单' }}</button>
              <button
                class="secondary-button settings-action-button"
                type="button"
                :disabled="softwareUpdateBusy || remoteCatalogUpdateBusy"
                @click="checkSoftwareUpdate"
              >{{ softwareUpdateBusy ? '检查中…' : '检查更新' }}</button>
            </div>
          </div>
        </div>
        <h3 class="settings-heading data-heading">登录信息</h3>
        <p class="recycle-hint">不登录也能正常使用；登录信息会由 Windows 加密后保存在本机。</p>
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
        <p class="recycle-hint">数据保存在系统“文档\Gtask”目录，自动保留最近 30 份每日备份。</p>
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
          <p v-if="backups.length === 0" class="empty-text">还没有备份</p>
        </div>
        <p class="settings-note">米游社支持扫码登录，库街区支持手机号登录；登录信息只会加密保存在本机。</p>
      </section>
    </div>
    <div v-if="loginRequiredOpen" class="modal-backdrop login-backdrop" @click.self="loginRequiredOpen = false">
      <section class="prompt-modal login-required-modal" role="dialog" aria-modal="true" aria-labelledby="login-required-title">
        <div class="modal-header">
          <div><p class="eyebrow">同步进度</p><h2 id="login-required-title">需要登录</h2></div>
          <button class="close-button" type="button" aria-label="取消登录" @click="loginRequiredOpen = false; pendingPersonalSyncIntent = null">×</button>
        </div>
        <p>同步进度需要登录{{ pendingPersonalSyncIntent && credentialProviderForGame(pendingPersonalSyncIntent.gameId) === 'kuro-community' ? '库街区' : '米游社' }}。</p>
        <div class="prompt-actions">
          <button class="secondary-button" type="button" @click="loginRequiredOpen = false; pendingPersonalSyncIntent = null">取消</button>
          <button class="primary-button" type="button" @click="beginPendingPersonalLogin">登录</button>
        </div>
      </section>
    </div>
    <div v-if="miyousheLoginOpen" class="modal-backdrop login-backdrop" @click.self="closeMiyousheLogin">
      <section class="editor-modal login-modal" role="dialog" aria-modal="true" aria-label="米游社扫码登录">
        <div class="modal-header">
          <div><h2>米游社扫码登录</h2><p>登录信息只保存在本机</p></div>
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
          <p v-else-if="miyousheLoginState.status === 'confirmed'">登录成功，现在可以同步进度了。</p>
          <p v-else-if="miyousheLoginState.status === 'expired'">为了安全，二维码过期后需要手动重新获取。</p>
          <p v-else>二维码大约 5 分钟内有效；Gtask 不会读取浏览器 Cookie。</p>
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
          <div><h2>登录库街区</h2><p>登录后可同步鸣潮挑战与地图进度</p></div>
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
          >{{ kuroCredentialBusy ? '等待验证…' : '获取短信验证码' }}</button>
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
          >{{ kuroCredentialBusy ? '登录中…' : '登录并选择角色' }}</button>
          <label v-if="kuroLoginPhase === 'role'">
            选择角色
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
          <p class="recycle-hint">确认角色后，登录信息会加密保存在本机。</p>
        </div>
        <div class="login-actions">
          <button
            v-if="kuroLoginPhase === 'role'"
            class="primary-button"
            type="button"
            :disabled="kuroCredentialBusy || !kuroSelectedRoleKey"
            @click="saveKuroCommunityLogin"
          >{{ kuroCredentialBusy ? '验证中…' : '确认并保存' }}</button>
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
      v-if="confirmationDialog"
      class="modal-backdrop confirmation-backdrop"
      @click.self="closeConfirmationDialog"
    >
      <section
        class="prompt-modal confirmation-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirmation-title"
        aria-describedby="confirmation-message confirmation-detail"
      >
        <div class="confirmation-header">
          <div class="confirmation-heading">
            <span class="confirmation-icon" aria-hidden="true">!</span>
            <div>
              <p class="eyebrow">{{ confirmationDialog.eyebrow }}</p>
              <h2 id="confirmation-title">{{ confirmationDialog.title }}</h2>
            </div>
          </div>
          <button
            class="close-button"
            type="button"
            aria-label="取消操作"
            :disabled="confirmationBusy"
            @click="closeConfirmationDialog"
          >×</button>
        </div>
        <p id="confirmation-message" class="confirmation-message">{{ confirmationDialog.message }}</p>
        <p id="confirmation-detail" class="confirmation-detail">{{ confirmationDialog.detail }}</p>
        <div class="prompt-actions confirmation-actions">
          <button
            class="secondary-button"
            type="button"
            :disabled="confirmationBusy"
            autofocus
            @click="closeConfirmationDialog"
          >取消</button>
          <button
            class="danger-button confirmation-danger-button"
            type="button"
            :disabled="confirmationBusy"
            @click="confirmDialogAction"
          >{{ confirmationBusy ? '处理中…' : confirmationDialog.confirmLabel }}</button>
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
        <svg v-if="draggingPanel.section === 'events'" viewBox="0 0 24 24"><path d="M12 3v18M3 12h18"/><path d="M5.6 5.6 18.4 18.4M18.4 5.6 5.6 18.4"/><circle cx="12" cy="12" r="4"/></svg>
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
