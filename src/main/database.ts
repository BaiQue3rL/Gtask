import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { getWeeklyPeriod } from './periods'
import type {
  ChecklistCategory,
  ChecklistItem,
  ChecklistSource,
  AiScheduleAgentStatus,
  AiScheduleJob,
  CreateChecklistItemInput,
  GameId,
  GameSummary,
  SyncScope,
  SyncTarget,
  SyncTargetState,
  SyncSettings,
  SyncStatus,
  UpdateChecklistItemInput
} from '../shared/contracts'
import type { NormalizedSyncItem, SyncMergeResult } from './sync/types'

const DEFAULT_GAMES: GameSummary[] = [
  {
    id: 'genshin',
    name: '原神',
    shortName: '原神',
    accent: '#79a9ff',
    sortOrder: 10,
    enabled: true
  },
  {
    id: 'star-rail',
    name: '崩坏：星穹铁道',
    shortName: '星铁',
    accent: '#a77cff',
    sortOrder: 20,
    enabled: true
  },
  {
    id: 'zenless',
    name: '绝区零',
    shortName: '绝区零',
    accent: '#ff8a47',
    sortOrder: 30,
    enabled: true
  },
  {
    id: 'wuthering-waves',
    name: '鸣潮',
    shortName: '鸣潮',
    accent: '#59d7e7',
    sortOrder: 40,
    enabled: true
  }
]

export const CURRENT_SCHEMA_VERSION = 11

const AI_AGENT_MAX_AGE_MS = 5 * 60 * 1000
const AI_JOB_CLAIM_MAX_AGE_MS = 15 * 60 * 1000
const REQUIRED_ENDGAME_MODES: Record<GameId, ReadonlyArray<readonly [string, string]>> = {
  genshin: [
    ['spiral-abyss', '深境螺旋'],
    ['imaginarium-theater', '幻想真境剧诗'],
    ['stygian-onslaught', '幽境危战']
  ],
  'star-rail': [
    ['memory-of-chaos', '混沌回忆'],
    ['pure-fiction', '虚构叙事'],
    ['apocalyptic-shadow', '末日幻影'],
    ['anomaly-arbitration', '异相仲裁']
  ],
  zenless: [
    ['shiyu-defense', '式舆防卫战'],
    ['deadly-assault', '危局强袭战']
  ],
  'wuthering-waves': [
    ['tower-of-adversity', '逆境深塔'],
    ['whimpering-wastes', '冥歌海墟']
  ]
}

export class AppDatabase {
  private readonly database: DatabaseSync

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    try {
      this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
      this.migrate()
      this.seedGames()
      this.seedQuestChecklists()
      this.ensureWeeklyForInitializedGames()
      this.normalizeWeeklySchedules()
      this.resetDueWeeklyItems()
      this.markStaleSyncStates()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  listGames(): GameSummary[] {
    const rows = this.database
      .prepare(`
        SELECT
          id,
          name,
          short_name AS shortName,
          accent,
          sort_order AS sortOrder,
          enabled
        FROM games
        ORDER BY sort_order ASC
      `)
      .all() as Array<Omit<GameSummary, 'enabled'> & { enabled: number }>

    return rows.map((row) => ({ ...row, enabled: Boolean(row.enabled) }))
  }

  getDataVersion(): number {
    const row = this.database.prepare('PRAGMA data_version').get() as { data_version: number }
    return Number(row.data_version)
  }

  readConsistently<T>(operation: () => T): T {
    this.database.exec('BEGIN')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  getSyncSettings(gameId: string): SyncSettings {
    const row = this.database
      .prepare(`
        SELECT
          game_id AS gameId,
          run_mode AS runMode,
          auto_scope AS autoScope,
          status,
          last_scope AS lastScope,
          last_attempt_at AS lastAttemptAt,
          last_success_at AS lastSuccessAt,
          message
        FROM sync_states
        WHERE game_id = ?
      `)
      .get(gameId)

    if (!row) throw new Error('游戏同步设置不存在')
    return row as unknown as SyncSettings
  }

  getSyncTargetStates(gameId: GameId): SyncTargetState[] {
    const rows = this.database.prepare(`
      SELECT target, last_success_at AS lastSuccessAt
      FROM sync_target_states
      WHERE game_id = ?
    `).all(gameId) as Array<{ target: SyncTargetState['target']; lastSuccessAt: string }>
    const timestamps = new Map(rows.map((row) => [row.target, row.lastSuccessAt]))
    return (['all', 'events', 'cycles', 'exploration'] as const).map((target) => ({
      gameId,
      target,
      lastSuccessAt: timestamps.get(target) ?? null
    }))
  }

  recordSyncTargetSuccess(
    gameId: GameId,
    target: SyncTarget,
    reference = new Date(),
    includeGlobal = false
  ): void {
    if (target === 'tasks') return
    const targets = target === 'all'
      ? includeGlobal
        ? (['all', 'events', 'cycles', 'exploration'] as const)
        : (['events', 'cycles', 'exploration'] as const)
      : [target]
    const timestamp = reference.toISOString()
    const statement = this.database.prepare(`
      INSERT INTO sync_target_states(game_id, target, last_success_at)
      VALUES (?, ?, ?)
      ON CONFLICT(game_id, target) DO UPDATE SET last_success_at = excluded.last_success_at
    `)
    for (const resolvedTarget of targets) statement.run(gameId, resolvedTarget, timestamp)
  }

  recordSyncAttempt(gameId: string, scope: SyncScope): void {
    const now = new Date().toISOString()
    this.database
      .prepare(`
        UPDATE sync_states
        SET status = 'idle', last_scope = ?, last_attempt_at = ?, message = NULL, updated_at = ?
        WHERE game_id = ?
      `)
      .run(scope, now, now, gameId)
  }

  recordPersonalSyncAttempt(gameId: string): void {
    const now = new Date().toISOString()
    this.database
      .prepare(`
        UPDATE sync_states
        SET status = 'idle', last_scope = NULL, last_attempt_at = ?, message = NULL, updated_at = ?
        WHERE game_id = ?
      `)
      .run(now, now, gameId)
  }

  recordSyncOutcome(
    gameId: string,
    status: SyncStatus,
    message: string,
    successfulDataReceived = status === 'success'
  ): void {
    const now = new Date().toISOString()
    const lastSuccessAt = successfulDataReceived ? now : null
    this.database
      .prepare(`
        UPDATE sync_states
        SET status = ?,
            last_success_at = COALESCE(?, last_success_at),
            message = ?,
            updated_at = ?
        WHERE game_id = ?
      `)
      .run(status, lastSuccessAt, message, now, gameId)
  }

  registerAiScheduleAgent(
    agentId: string,
    name: string,
    reference = new Date()
  ): AiScheduleAgentStatus {
    const now = reference.toISOString()
    this.database.prepare(`
      INSERT INTO ai_schedule_agents(id, name, last_seen_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        last_seen_at = excluded.last_seen_at,
        updated_at = excluded.updated_at
    `).run(agentId, name, now, now, now)
    return { connected: true, codexPluginInstalled: false, agentId, name, lastSeenAt: now }
  }

  getAiScheduleAgentStatus(reference = new Date()): AiScheduleAgentStatus {
    const threshold = new Date(reference.getTime() - AI_AGENT_MAX_AGE_MS).toISOString()
    const row = this.database.prepare(`
      SELECT id AS agentId, name, last_seen_at AS lastSeenAt
      FROM ai_schedule_agents
      WHERE last_seen_at >= ?
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(threshold) as Omit<AiScheduleAgentStatus, 'connected' | 'codexPluginInstalled'> | undefined
    return row ? { connected: true, codexPluginInstalled: false, ...row } : {
      connected: false,
      codexPluginInstalled: false,
      agentId: null,
      name: null,
      lastSeenAt: null
    }
  }

  createAiScheduleJob(
    gameId: GameId,
    scope: SyncScope,
    reference = new Date(),
    allowWithoutAgent = false,
    target: SyncTarget = 'all',
    userTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  ): AiScheduleJob {
    const agent = this.getAiScheduleAgentStatus(reference)
    if (!agent.connected && !allowWithoutAgent) {
      throw new Error('尚未连接具备联网搜索能力的 AI 资料 Agent')
    }
    this.requeueStaleAiScheduleJobs(reference)
    const active = this.database.prepare(`
      SELECT id, scope, target FROM ai_schedule_jobs
      WHERE game_id = ? AND status IN ('pending', 'claimed')
      ORDER BY requested_at ASC LIMIT 1
    `).get(gameId) as { id: string; scope: SyncScope; target: SyncTarget } | undefined
    if (active) {
      if (active.target !== target) {
        throw new Error(`该游戏已有“${active.target}”版块同步任务等待处理`)
      }
      if (scope === 'public_and_personal' && active.scope === 'public_schedule') {
        const now = reference.toISOString()
        this.database.prepare(`
          UPDATE ai_schedule_jobs SET scope = 'public_and_personal', updated_at = ? WHERE id = ?
        `).run(now, active.id)
        this.database.prepare(`
          UPDATE sync_states SET last_scope = 'public_and_personal', updated_at = ? WHERE game_id = ?
        `).run(now, gameId)
      }
      return this.getAiScheduleJob(active.id)
    }
    const id = randomUUID()
    const now = reference.toISOString()
    this.database.prepare(`
      INSERT INTO ai_schedule_jobs(
        id, game_id, scope, target, user_timezone, status, requested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(id, gameId, scope, target, userTimeZone, now, now)
    this.database.prepare(`
      UPDATE sync_states
      SET status = 'idle', last_scope = ?, last_attempt_at = ?,
          message = '公开资料任务已提交给 AI，等待检索', updated_at = ?
      WHERE game_id = ?
    `).run(scope, now, now, gameId)
    return this.getAiScheduleJob(id)
  }

  claimAiScheduleJob(agentId: string, reference = new Date()): AiScheduleJob | null {
    return this.runTransaction(() => {
      const agent = this.database.prepare('SELECT name FROM ai_schedule_agents WHERE id = ?').get(agentId)
      if (!agent) throw new Error('AI 资料 Agent 尚未登记')
      const now = reference.toISOString()
      this.database.prepare(`UPDATE ai_schedule_agents SET last_seen_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, agentId)
      this.requeueStaleAiScheduleJobs(reference)
      const pending = this.database.prepare(`
        SELECT id FROM ai_schedule_jobs WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 1
      `).get() as { id: string } | undefined
      if (!pending) return null
      this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET status = 'claimed', agent_id = ?, claimed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(agentId, now, now, pending.id)
      return this.getAiScheduleJob(pending.id)
    })
  }

  applyAiScheduleJob(
    jobId: string,
    agentId: string,
    items: NormalizedSyncItem[],
    evidence: unknown,
    reference = new Date()
  ): { job: AiScheduleJob; merge: SyncMergeResult } {
    const job = this.getAiScheduleJob(jobId)
    if (job.status !== 'claimed' || job.agentId !== agentId) {
      throw new Error('AI 资料任务未由当前 Agent 领取或已经结束')
    }
    const targetCategories: Partial<Record<SyncTarget, ChecklistCategory[]>> = {
      events: ['limited_event'],
      cycles: ['weekly', 'endgame'],
      exploration: ['exploration'],
      tasks: []
    }
    const allowedCategories = targetCategories[job.target]
    if (allowedCategories) {
      const invalid = items.find((item) => !allowedCategories.includes(item.category))
      if (invalid) throw new Error(`当前任务只允许回写“${job.target}”版块数据`)
    }
    const includesCycles = job.target === 'all' || job.target === 'cycles'
    if (includesCycles) {
      const requiredModes = REQUIRED_ENDGAME_MODES[job.gameId]
      const submittedModes = new Set(items
        .filter((item) => item.category === 'endgame')
        .map((item) => item.modeKey))
      const missing = requiredModes
        .filter(([modeKey]) => !submittedModes.has(modeKey))
        .map(([, title]) => title)
      if (missing.length > 0) {
        throw new Error(`${job.gameId} 周期同步缺少：${missing.join('、')}；已保留原清单，请重新核验`)
      }
    }
    const mergedItems = includesCycles && !items.some((item) => item.category === 'weekly')
      ? [...items, {
          remoteKey: `weekly:${job.gameId}`,
          category: 'weekly' as const,
          title: '周常'
        }]
      : items
    const merge = this.mergeSyncedItems(job.gameId, 'public_schedule', mergedItems, reference.toISOString())
    const now = reference.toISOString()
    const message = `AI 资料同步完成：新增 ${merge.added}，更新 ${merge.updated}，保护 ${merge.preserved}`
    this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'completed', completed_at = ?, evidence_json = ?, message = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND agent_id = ?
    `).run(now, JSON.stringify(evidence), message, now, jobId, agentId)
    const current = this.getSyncSettings(job.gameId)
    const personalIssue = job.scope === 'public_and_personal' &&
      ['error', 'stale', 'verification_required'].includes(current.status)
    const finalStatus = personalIssue
      ? current.status === 'verification_required'
        ? 'verification_required'
        : 'stale'
      : 'success'
    const finalMessage = personalIssue && current.message
      ? `${message}；${current.message}`
      : message
    this.recordSyncOutcome(job.gameId, finalStatus, finalMessage, true)
    this.recordSyncTargetSuccess(job.gameId, job.target, reference, true)
    return { job: this.getAiScheduleJob(jobId), merge }
  }

  failAiScheduleJob(jobId: string, agentId: string, message: string, reference = new Date()): AiScheduleJob {
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'failed', completed_at = ?, message = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND agent_id = ?
    `).run(now, message, now, jobId, agentId)
    if (result.changes === 0) throw new Error('AI 资料任务未由当前 Agent 领取或已经结束')
    const job = this.getAiScheduleJob(jobId)
    this.recordSyncOutcome(job.gameId, 'error', message, false)
    return job
  }

  private getAiScheduleJob(id: string): AiScheduleJob {
    const row = this.database.prepare(`
      SELECT j.id, j.game_id AS gameId, j.scope, j.target,
        j.user_timezone AS userTimeZone, j.status,
        j.requested_at AS requestedAt, j.claimed_at AS claimedAt,
        j.completed_at AS completedAt, j.agent_id AS agentId,
        a.name AS agentName, j.message
      FROM ai_schedule_jobs j
      LEFT JOIN ai_schedule_agents a ON a.id = j.agent_id
      WHERE j.id = ?
    `).get(id) as AiScheduleJob | undefined
    if (!row) throw new Error('AI 资料任务不存在')
    return row
  }

  private requeueStaleAiScheduleJobs(reference: Date): number {
    const threshold = new Date(reference.getTime() - AI_JOB_CLAIM_MAX_AGE_MS).toISOString()
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'pending', agent_id = NULL, claimed_at = NULL,
          message = 'Agent 超时，任务已重新排队', updated_at = ?
      WHERE status = 'claimed' AND claimed_at < ?
    `).run(now, threshold)
    return Number(result.changes)
  }

  markStaleSyncStates(reference = new Date(), maximumAgeMs = 24 * 60 * 60 * 1000): number {
    const threshold = new Date(reference.getTime() - maximumAgeMs).toISOString()
    const result = this.database
      .prepare(`
        UPDATE sync_states
        SET status = 'stale',
            message = COALESCE(message, '上次成功数据已超过 24 小时'),
            updated_at = ?
        WHERE status = 'success'
          AND last_success_at IS NOT NULL
          AND last_success_at < ?
      `)
      .run(reference.toISOString(), threshold)
    return Number(result.changes)
  }

  listChecklistItems(gameId: string): ChecklistItem[] {
    const rows = this.database
      .prepare(`
        SELECT
          id,
          game_id AS gameId,
          category,
          title,
          completed,
          progress_percent AS progressPercent,
          parent_title AS parentTitle,
          starts_at AS startsAt,
          ends_at AS endsAt,
          reset_rule AS resetRule,
          period_key AS periodKey,
          schedule_kind AS scheduleKind,
          reset_weekday AS resetWeekday,
          timezone AS timeZone,
          mode_key AS modeKey,
          recurrence_rule AS recurrenceRule,
          source,
          remote_key AS remoteKey,
          source_url AS sourceUrl,
          manual_completion_locked AS manualCompletionLocked,
          last_synced_at AS lastSyncedAt,
          completed_at AS completedAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM checklist_items
        WHERE game_id = ? AND archived = 0
        ORDER BY
          completed ASC,
          CASE
            WHEN completed = 0
              AND ends_at IS NOT NULL
              AND julianday(ends_at) BETWEEN julianday('now') AND julianday('now', '+1 day')
            THEN 0
            ELSE 1
          END,
          CASE category
            WHEN 'main_quest' THEN 10
            WHEN 'side_quest' THEN 20
            WHEN 'limited_event' THEN 30
            WHEN 'permanent_event' THEN 40
            WHEN 'weekly' THEN 50
            WHEN 'endgame' THEN 60
            WHEN 'exploration' THEN 70
            ELSE 80
          END,
          CASE WHEN ends_at IS NULL THEN 1 ELSE 0 END,
          ends_at ASC,
          created_at ASC
      `)
      .all(gameId) as unknown[]

    return rows.map((row) => this.mapChecklistItem(row))
  }

  listArchivedChecklistItems(gameId: string): ChecklistItem[] {
    const rows = this.database
      .prepare(`
        SELECT
          id,
          game_id AS gameId,
          category,
          title,
          completed,
          progress_percent AS progressPercent,
          parent_title AS parentTitle,
          starts_at AS startsAt,
          ends_at AS endsAt,
          reset_rule AS resetRule,
          period_key AS periodKey,
          schedule_kind AS scheduleKind,
          reset_weekday AS resetWeekday,
          timezone AS timeZone,
          mode_key AS modeKey,
          recurrence_rule AS recurrenceRule,
          source,
          remote_key AS remoteKey,
          source_url AS sourceUrl,
          manual_completion_locked AS manualCompletionLocked,
          last_synced_at AS lastSyncedAt,
          completed_at AS completedAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM checklist_items
        WHERE game_id = ? AND archived = 1
        ORDER BY updated_at DESC
      `)
      .all(gameId) as unknown[]

    return rows.map((row) => this.mapChecklistItem(row))
  }

  createChecklistItem(input: CreateChecklistItemInput): ChecklistItem {
    if (input.category === 'main_quest' || input.category === 'side_quest') {
      throw new Error('主线任务和支线任务是每款游戏唯一的状态项，不能重复新增')
    }
    const id = randomUUID()
    const now = new Date().toISOString()
    const scheduleKind = input.scheduleKind ?? this.defaultScheduleKind(input.category)
    const resetWeekday = scheduleKind === 'weekly' ? 1 : input.resetWeekday ?? null
    const timeZone = scheduleKind === 'weekly' ? input.timeZone ?? 'Asia/Shanghai' : input.timeZone ?? null
    const weeklyPeriod =
      scheduleKind === 'weekly' ? getWeeklyPeriod(new Date(), resetWeekday ?? 1, timeZone ?? 'Asia/Shanghai') : null
    const startsAt = input.startsAt ?? weeklyPeriod?.startsAt ?? null
    const endsAt = input.endsAt ?? weeklyPeriod?.endsAt ?? null
    this.assertTimeWindow(startsAt, endsAt)

    this.database
      .prepare(`
        INSERT INTO checklist_items(
          id, game_id, category, title, progress_percent, parent_title, starts_at, ends_at,
          reset_rule, period_key, schedule_kind, reset_weekday, timezone, mode_key,
          recurrence_rule, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
      `)
      .run(
        id,
        input.gameId,
        input.category,
        input.title,
        input.progressPercent ?? null,
        input.parentTitle ?? null,
        startsAt,
        endsAt,
        input.resetRule ?? null,
        weeklyPeriod?.key ?? null,
        scheduleKind,
        resetWeekday,
        timeZone,
        input.modeKey ?? null,
        null,
        now,
        now
      )

    if (input.category === 'exploration' && input.progressPercent === 100) {
      return this.updateChecklistItem({ id, completed: true })
    }
    return this.getChecklistItem(id)
  }

  createChecklistItems(inputs: CreateChecklistItemInput[]): ChecklistItem[] {
    return this.runTransaction(() => inputs.map((input) => this.createChecklistItem(input)))
  }

  updateChecklistItem(input: UpdateChecklistItemInput): ChecklistItem {
    const current = this.getChecklistItem(input.id)
    const category = input.category ?? current.category
    const requestedCompleted =
      category === 'exploration' && input.progressPercent !== undefined
        ? input.progressPercent === 100
        : input.completed
    const completed = requestedCompleted ?? current.completed
    const manualCompletionLocked =
      requestedCompleted === undefined ? current.manualCompletionLocked : requestedCompleted
    const completedAt =
      requestedCompleted === undefined
        ? current.completedAt
        : requestedCompleted
          ? current.completedAt ?? new Date().toISOString()
          : null
    if (
      (category === 'main_quest' || category === 'side_quest') &&
      category !== current.category
    ) {
      throw new Error('不能把其他事项改为主线或支线状态项')
    }
    const categoryChanged = category !== current.category
    const scheduleKind =
      input.scheduleKind === undefined
        ? categoryChanged
          ? this.defaultScheduleKind(category)
          : current.scheduleKind
        : input.scheduleKind
    const resetWeekday =
      scheduleKind === 'weekly'
        ? 1
        : input.resetWeekday === undefined
          ? categoryChanged
            ? null
            : current.resetWeekday
          : input.resetWeekday
    const timeZone =
      input.timeZone === undefined
        ? scheduleKind === 'weekly'
          ? current.timeZone ?? 'Asia/Shanghai'
          : categoryChanged
            ? null
            : current.timeZone
        : input.timeZone
    const weeklyPeriod =
      scheduleKind === 'weekly'
        ? getWeeklyPeriod(new Date(), resetWeekday ?? 1, timeZone ?? 'Asia/Shanghai')
        : null
    const startsAt =
      input.startsAt === undefined ? weeklyPeriod?.startsAt ?? current.startsAt : input.startsAt
    const endsAt = input.endsAt === undefined ? weeklyPeriod?.endsAt ?? current.endsAt : input.endsAt
    this.assertTimeWindow(startsAt, endsAt)

    this.database
      .prepare(`
        UPDATE checklist_items SET
          category = ?,
          title = ?,
          completed = ?,
          progress_percent = ?,
          parent_title = ?,
          starts_at = ?,
          ends_at = ?,
          reset_rule = ?,
          period_key = ?,
          schedule_kind = ?,
          reset_weekday = ?,
          timezone = ?,
          mode_key = ?,
          recurrence_rule = ?,
          manual_completion_locked = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ? AND archived = 0
      `)
      .run(
        category,
        input.title ?? current.title,
        completed ? 1 : 0,
        input.progressPercent === undefined ? current.progressPercent : input.progressPercent,
        input.parentTitle === undefined ? current.parentTitle : input.parentTitle,
        startsAt,
        endsAt,
        input.resetRule === undefined ? current.resetRule : input.resetRule,
        weeklyPeriod?.key ?? (categoryChanged ? null : current.periodKey),
        scheduleKind,
        resetWeekday,
        timeZone,
        input.modeKey === undefined ? (categoryChanged ? null : current.modeKey) : input.modeKey,
        null,
        manualCompletionLocked ? 1 : 0,
        completedAt,
        new Date().toISOString(),
        input.id
      )

    return this.getChecklistItem(input.id)
  }

  updateChecklistItems(inputs: UpdateChecklistItemInput[]): ChecklistItem[] {
    return this.runTransaction(() => inputs.map((input) => this.updateChecklistItem(input)))
  }

  archiveChecklistItem(id: string): void {
    if (this.isPersistentChecklistId(id)) throw new Error('固定清单事项不能删除')
    const result = this.database
      .prepare(`
        UPDATE checklist_items
        SET archived = 1, updated_at = ?
        WHERE id = ? AND archived = 0
      `)
      .run(new Date().toISOString(), id)

    if (result.changes === 0) throw new Error('清单事项不存在或已删除')
  }

  archiveChecklistItems(ids: string[]): number {
    return this.runTransaction(() => {
      for (const id of ids) this.archiveChecklistItem(id)
      return ids.length
    })
  }

  restoreChecklistItem(id: string): ChecklistItem {
    const result = this.database
      .prepare(`
        UPDATE checklist_items
        SET archived = 0, updated_at = ?
        WHERE id = ? AND archived = 1
      `)
      .run(new Date().toISOString(), id)

    if (result.changes === 0) throw new Error('回收站事项不存在或已恢复')
    this.resetDueWeeklyItems()
    return this.getChecklistItem(id)
  }

  archiveCompletedSection(gameId: string, categories: ChecklistCategory[]): number {
    if (categories.length === 0) return 0
    const placeholders = categories.map(() => '?').join(', ')
    const result = this.database
      .prepare(`
        UPDATE checklist_items
        SET archived = 1, updated_at = ?
        WHERE game_id = ?
          AND category IN (${placeholders})
          AND completed = 1
          AND archived = 0
          AND id NOT IN (
            game_id || ':main_quest',
            game_id || ':side_quest',
            game_id || ':weekly'
          )
      `)
      .run(new Date().toISOString(), gameId, ...categories)

    return Number(result.changes)
  }

  mergeSyncedItems(
    gameId: GameId,
    source: Exclude<ChecklistSource, 'manual'>,
    items: NormalizedSyncItem[],
    syncedAt = new Date().toISOString()
  ): SyncMergeResult {
    const result: SyncMergeResult = { added: 0, updated: 0, preserved: 0 }
    const seenRemoteKeys = new Set<string>()

    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const item of items) {
        if (item.category === 'weekly') {
          const weeklyPeriod = getWeeklyPeriod(new Date(syncedAt), 1, 'Asia/Shanghai')
          item.scheduleKind = 'weekly'
          item.resetWeekday = 1
          item.timeZone = 'Asia/Shanghai'
          item.resetRule = '每周一重置'
          item.periodKey = weeklyPeriod.key
          item.startsAt = weeklyPeriod.startsAt
          item.endsAt = weeklyPeriod.endsAt
        }
        const remoteKey = item.remoteKey.trim()
        if (!remoteKey || remoteKey.length > 200) throw new Error('远端事项标识格式不正确')
        this.assertTimeWindow(item.startsAt ?? null, item.endsAt ?? null)
        if (seenRemoteKeys.has(remoteKey)) throw new Error(`同步数据包含重复标识：${remoteKey}`)
        seenRemoteKeys.add(remoteKey)

        const identity = this.findSyncIdentity(gameId, source, item, remoteKey, syncedAt)

        if (identity?.archived) {
          result.preserved += 1
          continue
        }

        if (!identity) {
          const id = item.category === 'weekly' ? `${gameId}:weekly` : randomUUID()
          const inferredCompletion = item.category === 'exploration' && item.progressPercent !== undefined
            ? item.progressPercent === 100
            : item.completed
          const remoteCompleted = source === 'personal_sync' && inferredCompletion === true
          this.database
            .prepare(`
              INSERT INTO checklist_items(
                id, game_id, category, title, completed, progress_percent, parent_title,
                starts_at, ends_at, reset_rule, period_key, schedule_kind,
                reset_weekday, timezone, mode_key, recurrence_rule, source, remote_key,
                source_url, completed_at, last_synced_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              id,
              gameId,
              item.category,
              item.title,
              remoteCompleted ? 1 : 0,
              source === 'personal_sync'
                ? item.progressPercent ?? null
                : item.category === 'exploration'
                  ? 0
                  : null,
              item.parentTitle ?? null,
              item.startsAt ?? null,
              item.endsAt ?? null,
              item.resetRule ?? null,
              item.periodKey ?? null,
              item.scheduleKind ?? this.defaultScheduleKind(item.category),
              item.resetWeekday ?? null,
              item.timeZone ?? null,
              item.modeKey ?? null,
              null,
              source,
              remoteKey,
              item.sourceUrl ?? null,
              remoteCompleted ? syncedAt : null,
              syncedAt,
              syncedAt,
              syncedAt
            )
          result.added += 1
          continue
        }

        const current = this.getChecklistItem(identity.id)
        const preservePublicSchedule =
          source === 'personal_sync' && current.source === 'public_schedule'
        const resolvedSource =
          source === 'public_schedule' || current.source === 'public_schedule'
            ? 'public_schedule'
            : 'personal_sync'
        const currentCompleted = current.completed
        const currentCompletedAt = current.completedAt
        const manualCompletionLocked = current.manualCompletionLocked
        const inferredCompletion = item.category === 'exploration' && item.progressPercent !== undefined
          ? item.progressPercent === 100
          : item.completed
        const acceptsRemoteCompletion = source === 'personal_sync' && inferredCompletion !== undefined
        const completionProtected =
          acceptsRemoteCompletion && inferredCompletion === false && manualCompletionLocked
        const completed = completionProtected
          ? currentCompleted
          : acceptsRemoteCompletion
            ? inferredCompletion!
            : currentCompleted
        const completedAt = completed
          ? currentCompletedAt ?? syncedAt
          : acceptsRemoteCompletion
            ? null
            : currentCompletedAt
        const startsAt =
          preservePublicSchedule || item.startsAt === undefined ? current.startsAt : item.startsAt
        const endsAt =
          preservePublicSchedule || item.endsAt === undefined ? current.endsAt : item.endsAt
        this.assertTimeWindow(startsAt, endsAt)

        this.database
          .prepare(`
            UPDATE checklist_items SET
              category = ?,
              title = ?,
              completed = ?,
              progress_percent = ?,
              parent_title = ?,
              starts_at = ?,
              ends_at = ?,
              reset_rule = ?,
              period_key = ?,
              schedule_kind = ?,
              reset_weekday = ?,
              timezone = ?,
              mode_key = ?,
              recurrence_rule = ?,
              source = ?,
              source_url = ?,
              manual_completion_locked = ?,
              completed_at = ?,
              last_synced_at = ?,
              updated_at = ?
            WHERE id = ? AND archived = 0
          `)
          .run(
            preservePublicSchedule ? current.category : item.category,
            preservePublicSchedule ? current.title : item.title,
            completed ? 1 : 0,
            source === 'public_schedule' || item.progressPercent === undefined
              ? current.progressPercent
              : item.progressPercent,
            item.parentTitle === undefined ? current.parentTitle : item.parentTitle,
            startsAt,
            endsAt,
            preservePublicSchedule || item.resetRule === undefined ? current.resetRule : item.resetRule,
            item.periodKey === undefined ? current.periodKey : item.periodKey,
            preservePublicSchedule || item.scheduleKind === undefined
              ? current.scheduleKind
              : item.scheduleKind,
            preservePublicSchedule || item.resetWeekday === undefined
              ? current.resetWeekday
              : item.resetWeekday,
            preservePublicSchedule || item.timeZone === undefined ? current.timeZone : item.timeZone,
            preservePublicSchedule || item.modeKey === undefined ? current.modeKey : item.modeKey,
            null,
            resolvedSource,
            preservePublicSchedule || item.sourceUrl === undefined ? current.sourceUrl : item.sourceUrl,
            manualCompletionLocked ? 1 : 0,
            completedAt,
            syncedAt,
            syncedAt,
            current.id
          )
        result.updated += 1
        if (completionProtected) result.preserved += 1
      }
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private findSyncIdentity(
    gameId: GameId,
    source: Exclude<ChecklistSource, 'manual'>,
    item: NormalizedSyncItem,
    remoteKey: string,
    syncedAt: string
  ): { id: string; archived: number; source: ChecklistSource } | undefined {
    if (item.category === 'exploration') {
      return this.database.prepare(`
        SELECT id, archived, source
        FROM checklist_items
        WHERE game_id = ?
          AND category = 'exploration'
          AND source <> 'manual'
          AND (
            remote_key = ?
            OR (? IS NOT NULL AND mode_key = ?)
            OR title = ?
          )
        ORDER BY CASE WHEN remote_key = ? THEN 0 ELSE 1 END,
          CASE WHEN ? IS NOT NULL AND mode_key = ? THEN 0 ELSE 1 END,
          CASE WHEN source = 'public_schedule' THEN 0 ELSE 1 END,
          updated_at DESC
        LIMIT 1
      `).get(
        gameId,
        remoteKey,
        item.modeKey ?? null,
        item.modeKey ?? null,
        item.title,
        remoteKey,
        item.modeKey ?? null,
        item.modeKey ?? null
      ) as { id: string; archived: number; source: ChecklistSource } | undefined
    }

    if (item.category === 'limited_event') {
      return this.database.prepare(`
        SELECT id, archived, source
        FROM checklist_items
        WHERE game_id = ?
          AND category = 'limited_event'
          AND source <> 'manual'
          AND (
            remote_key = ?
            OR (? IS NOT NULL AND mode_key = ?)
            OR (
              title = ?
              AND starts_at IS NOT NULL AND ends_at IS NOT NULL
              AND ? IS NOT NULL AND ? IS NOT NULL
              AND julianday(starts_at) <= julianday(?)
              AND julianday(ends_at) >= julianday(?)
            )
          )
        ORDER BY CASE WHEN remote_key = ? THEN 0 ELSE 1 END,
          CASE WHEN ? IS NOT NULL AND mode_key = ? THEN 0 ELSE 1 END,
          CASE WHEN source = 'public_schedule' THEN 0 ELSE 1 END,
          updated_at DESC
        LIMIT 1
      `).get(
        gameId,
        remoteKey,
        item.modeKey ?? null,
        item.modeKey ?? null,
        item.title,
        item.startsAt ?? null,
        item.endsAt ?? null,
        item.endsAt ?? null,
        item.startsAt ?? null,
        remoteKey,
        item.modeKey ?? null,
        item.modeKey ?? null
      ) as { id: string; archived: number; source: ChecklistSource } | undefined
    }

    if (item.category === 'endgame' && source === 'public_schedule') {
      return this.database.prepare(`
        SELECT id, archived, source
        FROM checklist_items
        WHERE game_id = ?
          AND category = 'endgame'
          AND source <> 'manual'
          AND (
            (remote_key = ? AND period_key IS ?)
            OR (? IS NOT NULL AND mode_key = ? AND period_key IS ?)
            OR (? IS NOT NULL AND mode_key = ? AND source = 'personal_sync'
              AND starts_at IS NOT NULL AND ends_at IS NOT NULL
              AND julianday(starts_at) <= julianday(?)
              AND julianday(ends_at) >= julianday(?))
          )
        ORDER BY CASE WHEN remote_key = ? THEN 0 ELSE 1 END,
          CASE WHEN period_key IS ? THEN 0 ELSE 1 END,
          CASE WHEN source = 'public_schedule' THEN 0 ELSE 1 END,
          updated_at DESC
        LIMIT 1
      `).get(
        gameId,
        remoteKey,
        item.periodKey ?? null,
        item.modeKey ?? null,
        item.modeKey ?? null,
        item.periodKey ?? null,
        item.modeKey ?? null,
        item.modeKey ?? null,
        syncedAt,
        syncedAt,
        remoteKey,
        item.periodKey ?? null
      ) as { id: string; archived: number; source: ChecklistSource } | undefined
    }

    if (item.category === 'endgame' && source === 'personal_sync') {
      return this.database.prepare(`
        SELECT id, archived, source
        FROM checklist_items
        WHERE game_id = ?
          AND category = 'endgame'
          AND source <> 'manual'
          AND (remote_key = ? OR (? IS NOT NULL AND mode_key = ?))
        ORDER BY CASE WHEN ? IS NOT NULL AND period_key = ? THEN 0 ELSE 1 END,
          CASE WHEN starts_at IS NOT NULL AND ends_at IS NOT NULL
            AND julianday(starts_at) <= julianday(?)
            AND julianday(ends_at) >= julianday(?) THEN 0 ELSE 1 END,
          CASE WHEN source = 'public_schedule' THEN 0 ELSE 1 END,
          updated_at DESC
        LIMIT 1
      `).get(
        gameId,
        remoteKey,
        item.modeKey ?? null,
        item.modeKey ?? null,
        item.periodKey ?? null,
        item.periodKey ?? null,
        syncedAt,
        syncedAt
      ) as { id: string; archived: number; source: ChecklistSource } | undefined
    }

    return this.database.prepare(`
      SELECT id, archived, source
      FROM checklist_items
      WHERE game_id = ?
        AND (
          remote_key = ?
          OR (? IS NOT NULL AND mode_key = ? AND category = ?)
        )
        AND source <> 'manual'
      ORDER BY CASE WHEN remote_key = ? THEN 0 ELSE 1 END,
        CASE WHEN ? IS NOT NULL AND period_key = ? THEN 0 ELSE 1 END,
        CASE WHEN source = ? THEN 0 ELSE 1 END,
        updated_at DESC
      LIMIT 1
    `).get(
      gameId,
      remoteKey,
      item.modeKey ?? null,
      item.modeKey ?? null,
      item.category,
      remoteKey,
      item.periodKey ?? null,
      item.periodKey ?? null,
      source
    ) as { id: string; archived: number; source: ChecklistSource } | undefined
  }

  resetDueWeeklyItems(reference = new Date()): number {
    let changes = 0
    for (let resetWeekday = 1; resetWeekday <= 7; resetWeekday += 1) {
      const period = getWeeklyPeriod(reference, resetWeekday, 'Asia/Shanghai')
      const result = this.database
        .prepare(`
          UPDATE checklist_items
          SET completed = 0,
              completed_at = NULL,
              manual_completion_locked = 0,
              period_key = ?,
              starts_at = ?,
              ends_at = ?,
              updated_at = ?
          WHERE schedule_kind = 'weekly'
            AND reset_weekday = ?
            AND timezone = 'Asia/Shanghai'
            AND archived = 0
            AND (period_key IS NULL OR period_key <> ?)
        `)
        .run(
          period.key,
          period.startsAt,
          period.endsAt,
          new Date().toISOString(),
          resetWeekday,
          period.key
        )
      changes += Number(result.changes)
    }
    return changes
  }

  private normalizeWeeklySchedules(): void {
    this.database
      .prepare(`
        UPDATE checklist_items
        SET schedule_kind = 'weekly',
            reset_weekday = 1,
            timezone = 'Asia/Shanghai',
            reset_rule = '每周一重置',
            updated_at = ?
        WHERE category = 'weekly'
          AND archived = 0
          AND (
            schedule_kind IS NOT 'weekly'
            OR reset_weekday IS NOT 1
            OR timezone IS NOT 'Asia/Shanghai'
            OR reset_rule IS NOT '每周一重置'
          )
      `)
      .run(new Date().toISOString())
  }

  close(): void {
    this.database.close()
  }

  async backupTo(destinationPath: string): Promise<number> {
    return backup(this.database, destinationPath)
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_name TEXT NOT NULL,
        accent TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS checklist_items (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
        category TEXT NOT NULL CHECK (category IN (
          'main_quest', 'side_quest', 'limited_event', 'permanent_event',
          'weekly', 'endgame', 'exploration', 'custom'
        )),
        title TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
        progress_percent REAL CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)),
        starts_at TEXT,
        ends_at TEXT,
        reset_rule TEXT,
        period_key TEXT,
        source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'public_schedule', 'personal_sync')),
        remote_key TEXT,
        manual_completion_locked INTEGER NOT NULL DEFAULT 0 CHECK (manual_completion_locked IN (0, 1)),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE UNIQUE INDEX IF NOT EXISTS checklist_remote_identity
        ON checklist_items(game_id, source, remote_key)
        WHERE remote_key IS NOT NULL;

      CREATE TABLE IF NOT EXISTS sync_states (
        game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'manual' CHECK (mode IN ('manual', 'public_schedule', 'personal_sync')),
        status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'success', 'error', 'stale', 'verification_required')),
        last_attempt_at TEXT,
        last_success_at TEXT,
        message TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      INSERT OR IGNORE INTO schema_migrations(version) VALUES (1);
    `)

    const migration2 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 2')
      .get()

    if (!migration2) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE checklist_items ADD COLUMN completed_at TEXT;
        INSERT INTO schema_migrations(version) VALUES (2);
        COMMIT;
      `)
    }

    const migration3 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 3')
      .get()

    if (!migration3) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE sync_states ADD COLUMN run_mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (run_mode IN ('manual', 'automatic'));
        ALTER TABLE sync_states ADD COLUMN auto_scope TEXT NOT NULL DEFAULT 'public_schedule'
          CHECK (auto_scope IN ('public_schedule', 'public_and_personal'));
        ALTER TABLE sync_states ADD COLUMN last_scope TEXT
          CHECK (last_scope IS NULL OR last_scope IN ('public_schedule', 'public_and_personal'));
        INSERT INTO schema_migrations(version) VALUES (3);
        COMMIT;
      `)
    }

    const migration4 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 4')
      .get()

    if (!migration4) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE checklist_items ADD COLUMN schedule_kind TEXT
          CHECK (schedule_kind IS NULL OR schedule_kind IN ('weekly', 'fixed_window', 'remote_schedule'));
        ALTER TABLE checklist_items ADD COLUMN reset_weekday INTEGER
          CHECK (reset_weekday IS NULL OR (reset_weekday >= 1 AND reset_weekday <= 7));
        ALTER TABLE checklist_items ADD COLUMN timezone TEXT;
        ALTER TABLE checklist_items ADD COLUMN mode_key TEXT;
        UPDATE checklist_items
          SET schedule_kind = 'weekly', reset_weekday = 1, timezone = 'Asia/Shanghai'
          WHERE category = 'weekly';
        UPDATE checklist_items SET schedule_kind = 'fixed_window'
          WHERE category = 'limited_event';
        UPDATE checklist_items SET schedule_kind = 'remote_schedule'
          WHERE category = 'endgame';
        INSERT INTO schema_migrations(version) VALUES (4);
        COMMIT;
      `)
    }

    const migration5 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 5')
      .get()

    if (!migration5) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE checklist_items ADD COLUMN parent_title TEXT;
        INSERT INTO schema_migrations(version) VALUES (5);
        COMMIT;
      `)
    }

    const migration6 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 6')
      .get()

    if (!migration6) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE checklist_items ADD COLUMN source_url TEXT;
        INSERT INTO schema_migrations(version) VALUES (6);
        COMMIT;
      `)
    }

    const migration7 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 7')
      .get()

    if (!migration7) {
      this.database.exec(`
        BEGIN;
        CREATE TABLE ai_schedule_agents (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE ai_schedule_jobs (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
          scope TEXT NOT NULL CHECK (scope IN ('public_schedule', 'public_and_personal')),
          status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed', 'failed')),
          requested_at TEXT NOT NULL,
          claimed_at TEXT,
          completed_at TEXT,
          agent_id TEXT REFERENCES ai_schedule_agents(id) ON DELETE SET NULL,
          evidence_json TEXT,
          message TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX ai_schedule_jobs_pending ON ai_schedule_jobs(status, requested_at);
        CREATE UNIQUE INDEX ai_schedule_jobs_active_game
          ON ai_schedule_jobs(game_id) WHERE status IN ('pending', 'claimed');
        INSERT INTO schema_migrations(version) VALUES (7);
        COMMIT;
      `)
    }

    const migration8 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 8')
      .get()

    if (!migration8) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE ai_schedule_jobs ADD COLUMN target TEXT NOT NULL DEFAULT 'all'
          CHECK (target IN ('all', 'tasks', 'events', 'cycles', 'exploration'));
        ALTER TABLE ai_schedule_jobs ADD COLUMN user_timezone TEXT NOT NULL DEFAULT 'UTC';
        INSERT INTO schema_migrations(version) VALUES (8);
        COMMIT;
      `)
    }

    const migration9 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 9')
      .get()

    if (!migration9) {
      const hasRecurrenceRule = (this.database.prepare('PRAGMA table_info(checklist_items)').all() as Array<{
        name: string
      }>).some((column) => column.name === 'recurrence_rule')
      this.database.exec(hasRecurrenceRule
        ? `INSERT INTO schema_migrations(version) VALUES (9);`
        : `
          BEGIN;
          ALTER TABLE checklist_items ADD COLUMN recurrence_rule TEXT;
          INSERT INTO schema_migrations(version) VALUES (9);
          COMMIT;
        `)
    }

    const migration10 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 10')
      .get()

    if (!migration10) {
      this.database.exec(`
        BEGIN;
        UPDATE checklist_items SET recurrence_rule = NULL WHERE recurrence_rule IS NOT NULL;
        INSERT INTO schema_migrations(version) VALUES (10);
        COMMIT;
      `)
    }

    const migration11 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 11')
      .get()

    if (!migration11) {
      this.database.exec(`
        BEGIN;
        UPDATE sync_states
          SET run_mode = 'manual', auto_scope = 'public_schedule'
          WHERE run_mode <> 'manual' OR auto_scope <> 'public_schedule';
        CREATE TABLE IF NOT EXISTS sync_target_states (
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          target TEXT NOT NULL CHECK (target IN ('all', 'events', 'cycles', 'exploration')),
          last_success_at TEXT NOT NULL,
          PRIMARY KEY(game_id, target)
        );
        INSERT OR REPLACE INTO sync_target_states(game_id, target, last_success_at)
          SELECT game_id, 'all', MAX(completed_at)
          FROM ai_schedule_jobs
          WHERE status = 'completed' AND target = 'all' AND completed_at IS NOT NULL
          GROUP BY game_id;
        INSERT OR REPLACE INTO sync_target_states(game_id, target, last_success_at)
          SELECT game_id, 'events', MAX(completed_at)
          FROM ai_schedule_jobs
          WHERE status = 'completed' AND target IN ('all', 'events') AND completed_at IS NOT NULL
          GROUP BY game_id;
        INSERT OR REPLACE INTO sync_target_states(game_id, target, last_success_at)
          SELECT game_id, 'cycles', MAX(completed_at)
          FROM ai_schedule_jobs
          WHERE status = 'completed' AND target IN ('all', 'cycles') AND completed_at IS NOT NULL
          GROUP BY game_id;
        INSERT OR REPLACE INTO sync_target_states(game_id, target, last_success_at)
          SELECT game_id, 'exploration', MAX(completed_at)
          FROM ai_schedule_jobs
          WHERE status = 'completed' AND target IN ('all', 'exploration') AND completed_at IS NOT NULL
          GROUP BY game_id;
        INSERT INTO schema_migrations(version) VALUES (11);
        COMMIT;
      `)
    }

    const versionRow = this.database
      .prepare('SELECT MAX(version) AS version FROM schema_migrations')
      .get() as { version: number | null }
    if (Number(versionRow.version) !== CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `数据库版本异常：期望 ${CURRENT_SCHEMA_VERSION}，实际 ${String(versionRow.version)}`
      )
    }
  }

  private seedGames(): void {
    const insertGame = this.database.prepare(`
      INSERT INTO games(id, name, short_name, accent, sort_order, enabled)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        short_name = excluded.short_name,
        accent = excluded.accent,
        sort_order = excluded.sort_order,
        updated_at = CURRENT_TIMESTAMP
      WHERE games.name <> excluded.name
         OR games.short_name <> excluded.short_name
         OR games.accent <> excluded.accent
         OR games.sort_order <> excluded.sort_order
    `)

    const insertSyncState = this.database.prepare(`
      INSERT OR IGNORE INTO sync_states(game_id, mode, status)
      VALUES (?, 'manual', 'idle')
    `)

    for (const game of DEFAULT_GAMES) {
      insertGame.run(
        game.id,
        game.name,
        game.shortName,
        game.accent,
        game.sortOrder,
        game.enabled ? 1 : 0
      )
      insertSyncState.run(game.id)
    }
  }

  private seedQuestChecklists(): void {
    const upsertQuest = this.database.prepare(`
      INSERT INTO checklist_items(
        id, game_id, category, title, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'manual', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        archived = 0,
        category = excluded.category,
        source = 'manual',
        updated_at = excluded.updated_at
    `)
    const now = new Date().toISOString()

    for (const game of DEFAULT_GAMES) {
      upsertQuest.run(`${game.id}:main_quest`, game.id, 'main_quest', '主线任务', now, now)
      upsertQuest.run(`${game.id}:side_quest`, game.id, 'side_quest', '支线任务', now, now)
    }
  }

  private ensureWeeklyForInitializedGames(reference = new Date()): void {
    const initializedGames = this.database.prepare(`
      SELECT game_id AS gameId FROM sync_states WHERE last_success_at IS NOT NULL
    `).all() as Array<{ gameId: GameId }>
    if (initializedGames.length === 0) return
    const period = getWeeklyPeriod(reference, 1, 'Asia/Shanghai')
    const now = reference.toISOString()
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO checklist_items(
        id, game_id, category, title, completed, starts_at, ends_at,
        reset_rule, period_key, schedule_kind, reset_weekday, timezone,
        source, remote_key, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, 'weekly', '周常', 0, ?, ?, '每周一重置', ?, 'weekly', 1,
        'Asia/Shanghai', 'public_schedule', ?, ?, ?, ?)
    `)
    for (const { gameId } of initializedGames) {
      insert.run(
        `${gameId}:weekly`,
        gameId,
        period.startsAt,
        period.endsAt,
        period.key,
        `weekly:${gameId}`,
        now,
        now,
        now
      )
    }
  }

  private isPersistentChecklistId(id: string): boolean {
    return DEFAULT_GAMES.some((game) =>
      [`${game.id}:main_quest`, `${game.id}:side_quest`, `${game.id}:weekly`].includes(id)
    )
  }

  private getChecklistItem(id: string): ChecklistItem {
    const row = this.database
      .prepare(`
        SELECT
          id,
          game_id AS gameId,
          category,
          title,
          completed,
          progress_percent AS progressPercent,
          parent_title AS parentTitle,
          starts_at AS startsAt,
          ends_at AS endsAt,
          reset_rule AS resetRule,
          period_key AS periodKey,
          schedule_kind AS scheduleKind,
          reset_weekday AS resetWeekday,
          timezone AS timeZone,
          mode_key AS modeKey,
          recurrence_rule AS recurrenceRule,
          source,
          remote_key AS remoteKey,
          source_url AS sourceUrl,
          manual_completion_locked AS manualCompletionLocked,
          last_synced_at AS lastSyncedAt,
          completed_at AS completedAt,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM checklist_items
        WHERE id = ? AND archived = 0
      `)
      .get(id)

    if (!row) throw new Error('清单事项不存在或已删除')
    return this.mapChecklistItem(row)
  }

  private mapChecklistItem(row: unknown): ChecklistItem {
    const item = row as Omit<ChecklistItem, 'completed' | 'manualCompletionLocked'> & {
      completed: number
      manualCompletionLocked: number
    }

    return {
      ...item,
      completed: Boolean(item.completed),
      manualCompletionLocked: Boolean(item.manualCompletionLocked)
    }
  }

  private defaultScheduleKind(category: ChecklistCategory): ChecklistItem['scheduleKind'] {
    if (category === 'weekly') return 'weekly'
    if (category === 'limited_event') return 'fixed_window'
    if (category === 'endgame') return 'remote_schedule'
    return null
  }

  private assertTimeWindow(startsAt: string | null, endsAt: string | null): void {
    if (startsAt && Number.isNaN(Date.parse(startsAt))) throw new Error('开始时间不是有效时间')
    if (endsAt && Number.isNaN(Date.parse(endsAt))) throw new Error('结束时间不是有效时间')
    if (startsAt && endsAt && Date.parse(startsAt) > Date.parse(endsAt)) {
      throw new Error('结束时间不能早于开始时间')
    }
  }

  private runTransaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }
}
