<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type {
  AppInfo,
  ChecklistCategory,
  ChecklistItem,
  GameId,
  GameSummary
} from '../../shared/contracts'

interface ChecklistPanel {
  title: string
  icon: string
  categories: ChecklistCategory[]
  defaultCategory: ChecklistCategory
}

const panels: ChecklistPanel[] = [
  { title: '任务', icon: '▣', categories: ['main_quest', 'side_quest'], defaultCategory: 'side_quest' },
  { title: '活动', icon: '♧', categories: ['limited_event', 'permanent_event'], defaultCategory: 'limited_event' },
  { title: '周期事项', icon: '◴', categories: ['weekly', 'endgame'], defaultCategory: 'weekly' },
  { title: '地图探索', icon: '◇', categories: ['exploration'], defaultCategory: 'exploration' }
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

const games = ref<GameSummary[]>([])
const items = ref<ChecklistItem[]>([])
const appInfo = ref<AppInfo | null>(null)
const loading = ref(true)
const saving = ref(false)
const errorMessage = ref('')
const selectedGameId = ref<GameId>('genshin')
const showIncompleteOnly = ref(false)
const editorOpen = ref(false)
const editingItem = ref<ChecklistItem | null>(null)

const form = reactive({
  category: 'custom' as ChecklistCategory,
  title: '',
  progressPercent: null as number | null,
  endsAt: '',
  resetRule: ''
})

const selectedGame = computed(() => games.value.find((game) => game.id === selectedGameId.value))
const incompleteCount = computed(() => items.value.filter((item) => !item.completed).length)
const completedCount = computed(() => {
  const weekStart = startOfCurrentWeek()
  return items.value.filter((item) => item.completedAt && new Date(item.completedAt) >= weekStart).length
})
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
  try {
    ;[games.value, appInfo.value] = await Promise.all([
      window.gacha.listGames(),
      window.gacha.getAppInfo()
    ])
    await loadItems()
  } catch (error) {
    showError(error)
  } finally {
    loading.value = false
  }
})

watch(selectedGameId, () => void loadItems())

async function loadItems(): Promise<void> {
  loading.value = true
  errorMessage.value = ''
  try {
    items.value = await window.gacha.listChecklistItems(selectedGameId.value)
  } catch (error) {
    showError(error)
  } finally {
    loading.value = false
  }
}

function itemsFor(categories: ChecklistCategory[]): ChecklistItem[] {
  return items.value.filter(
    (item) => categories.includes(item.category) && (!showIncompleteOnly.value || !item.completed)
  )
}

function openCreate(category: ChecklistCategory): void {
  editingItem.value = null
  form.category = category
  form.title = ''
  form.progressPercent = null
  form.endsAt = ''
  form.resetRule = category === 'weekly' ? '每周一重置' : ''
  editorOpen.value = true
}

function openEdit(item: ChecklistItem): void {
  editingItem.value = item
  form.category = item.category
  form.title = item.title
  form.progressPercent = item.progressPercent
  form.endsAt = toLocalDateTime(item.endsAt)
  form.resetRule = item.resetRule ?? ''
  editorOpen.value = true
}

async function saveItem(): Promise<void> {
  if (!form.title.trim() || saving.value) return
  saving.value = true
  errorMessage.value = ''
  try {
    const common = {
      category: form.category,
      title: form.title,
      progressPercent: form.category === 'exploration' ? normalizeProgress(form.progressPercent) : null,
      endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
      resetRule: form.resetRule.trim() || null
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
    const updated = await window.gacha.updateChecklistItem({ id: item.id, completed: !item.completed })
    const index = items.value.findIndex((candidate) => candidate.id === item.id)
    if (index >= 0) items.value[index] = updated
  } catch (error) {
    showError(error)
  }
}

async function archiveItem(item: ChecklistItem): Promise<void> {
  if (!window.confirm(`确定删除“${item.title}”吗？`)) return
  try {
    await window.gacha.archiveChecklistItem(item.id)
    items.value = items.value.filter((candidate) => candidate.id !== item.id)
    editorOpen.value = false
  } catch (error) {
    showError(error)
  }
}

function normalizeProgress(value: number | null): number | null {
  if (value === null || value === undefined || value === ('' as unknown)) return null
  return Math.min(100, Math.max(0, Number(value)))
}

function toLocalDateTime(value: string | null): string {
  if (!value) return ''
  const date = new Date(value)
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function countdown(value: string): string {
  const diff = new Date(value).getTime() - Date.now()
  if (diff <= 0) return '已到期'
  const days = Math.floor(diff / 86_400_000)
  const hours = Math.floor((diff % 86_400_000) / 3_600_000)
  return days > 0 ? `剩余 ${days} 天 ${hours} 小时` : `剩余 ${hours} 小时`
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
  <main class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brand-mark">✦</span>幻游清单</div>
      <button class="overview active" type="button"><span>▦</span>总览</button>
      <p class="section-label">我的游戏</p>
      <nav class="game-list" aria-label="支持的游戏">
        <button
          v-for="game in games"
          :key="game.id"
          class="game-button"
          :class="{ selected: selectedGameId === game.id }"
          type="button"
          @click="selectedGameId = game.id"
        >
          <span class="game-dot" :style="{ '--game-accent': game.accent }"></span>
          {{ game.name }}
        </button>
      </nav>
      <div class="sidebar-footer">⚙ 设置</div>
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
            @click="showIncompleteOnly = !showIncompleteOnly"
          >
            ◇ 只看未完成
          </button>
          <button class="toolbar-button" type="button" @click="loadItems">↻ 刷新清单</button>
          <span class="status-pill"><i></i>纯手动模式</span>
        </div>
      </header>

      <p v-if="errorMessage" class="error-banner">{{ errorMessage }}</p>

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

      <section v-if="loading" class="panel centered">正在读取本地清单…</section>
      <template v-else>
        <section class="content-grid">
          <article v-for="panel in panels" :key="panel.title" class="panel checklist-card">
            <h2><span>{{ panel.icon }}</span>{{ panel.title }}</h2>
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
                <button class="item-main" type="button" @click="openEdit(item)">
                  <span class="item-title">{{ item.title }}</span>
                  <span class="item-details">
                    <b>{{ categoryLabels[item.category] }}</b>
                    <span v-if="item.progressPercent !== null">{{ item.progressPercent }}%</span>
                    <span v-if="item.endsAt" class="deadline">{{ countdown(item.endsAt) }}</span>
                    <span v-else-if="item.resetRule">{{ item.resetRule }}</span>
                  </span>
                </button>
                <button class="more-button" type="button" aria-label="编辑" @click="openEdit(item)">⋮</button>
              </div>
              <p v-if="itemsFor(panel.categories).length === 0" class="empty-text">暂无事项</p>
            </div>
            <button class="add-button" type="button" @click="openCreate(panel.defaultCategory)">＋ 新增{{ panel.title }}</button>
          </article>
        </section>

        <section class="panel custom-list">
          <h2>自定义清单</h2>
          <div class="custom-grid">
            <div
              v-for="item in itemsFor(['custom'])"
              :key="item.id"
              class="checklist-row"
              :class="{ completed: item.completed }"
            >
              <button class="check-button" type="button" @click="toggleCompleted(item)">{{ item.completed ? '✓' : '' }}</button>
              <button class="item-main" type="button" @click="openEdit(item)">
                <span class="item-title">{{ item.title }}</span>
              </button>
              <button class="more-button" type="button" @click="openEdit(item)">⋮</button>
            </div>
          </div>
          <p v-if="itemsFor(['custom']).length === 0" class="empty-text">暂无自定义事项</p>
          <button class="add-button" type="button" @click="openCreate('custom')">＋ 新增自定义事项</button>
        </section>
      </template>

      <footer v-if="appInfo" class="dev-footer">v{{ appInfo.version }} · 数据仅保存在本机</footer>
    </section>

    <div v-if="editorOpen" class="modal-backdrop" @click.self="editorOpen = false">
      <form class="editor-modal" @submit.prevent="saveItem">
        <div class="modal-header">
          <div><p class="eyebrow">{{ selectedGame?.name }}</p><h2>{{ editingItem ? '编辑事项' : '新增事项' }}</h2></div>
          <button class="close-button" type="button" @click="editorOpen = false">×</button>
        </div>

        <label>事项名称<input v-model="form.title" maxlength="100" autofocus placeholder="例如：刷角色突破素材" /></label>
        <label>分类
          <select v-model="form.category">
            <option v-for="(label, category) in categoryLabels" :key="category" :value="category">{{ label }}</option>
          </select>
        </label>
        <label v-if="form.category === 'exploration'">探索进度（%）<input v-model.number="form.progressPercent" type="number" min="0" max="100" /></label>
        <label v-if="['limited_event', 'endgame'].includes(form.category)">结束时间<input v-model="form.endsAt" type="datetime-local" /></label>
        <label v-if="['weekly', 'endgame'].includes(form.category)">重置规则<input v-model="form.resetRule" placeholder="例如：每周一重置" /></label>

        <div class="modal-actions">
          <button v-if="editingItem" class="danger-button" type="button" @click="archiveItem(editingItem)">删除</button>
          <span></span>
          <button class="secondary-button" type="button" @click="editorOpen = false">取消</button>
          <button class="primary-button" type="submit" :disabled="saving || !form.title.trim()">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </form>
    </div>
  </main>
</template>
