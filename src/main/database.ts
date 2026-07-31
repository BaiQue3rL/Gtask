import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { getWeeklyPeriod } from './periods'
import type {
  ChecklistCategory,
  ChecklistItem,
  ChecklistSource,
  ActivityTagEnrichmentTarget,
  AiScheduleAgentStatus,
  AiScheduleJob,
  CodexWorkerPreferences,
  CreateChecklistItemInput,
  GameId,
  GameSummary,
  PersonalSyncTarget,
  SemanticReviewCandidate,
  SemanticReviewDecisionSummary,
  SemanticReviewSummary,
  SyncProgressPhase,
  SyncScope,
  SyncTarget,
  SyncTargetState,
  SyncSettings,
  SyncStatus,
  SyncRequestContext,
  UpdateChecklistItemInput
} from '../shared/contracts'
import { getPublicSyncContract } from './sync/interface-contract'
import { normalizeActivityTags } from './activity-tags'
import {
  filterRelevantSemanticReviewDrafts,
  isSemanticReviewDraftRelevant
} from './sync/personal-review-filter'
import {
  hasOfficialPersonalFact,
  type ActivityTagUpdate,
  type CodexArchiveDecision,
  type CodexScheduleItem,
  type NormalizedSyncItem,
  type SemanticReviewDraft,
  type SyncMergeResult
} from './sync/types'

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

export const CURRENT_SCHEMA_VERSION = 26

const AI_AGENT_MAX_AGE_MS = 5 * 60 * 1000
const AI_JOB_CLAIM_MAX_AGE_MS = 15 * 60 * 1000
const SEMANTIC_REVIEW_PROTOCOL_VERSION = 'codex-authority-v8'

export type PersonalCompletionState = 'completed' | 'incomplete' | 'unknown'
export type SourceBindingKind = 'mechanical' | 'codex' | 'backfill'
type PersonalRuleValue = string | number | boolean

export interface PersonalCompletionRule {
  fieldPath: string
  completedValues: PersonalRuleValue[]
  incompleteValues: PersonalRuleValue[]
}

export interface SourceBinding {
  gameId: GameId
  provider: string
  endpoint: string
  externalId: string
  itemId: string
  bindingKind: SourceBindingKind
  confidence: number
  stateRule: PersonalCompletionRule | null
  createdAt: string
  updatedAt: string
}

export interface PersonalItemState {
  accountScope: string
  gameId: GameId
  itemId: string
  provider: string
  endpoint: string
  externalId: string
  completionState: PersonalCompletionState
  progressPercent: number | null
  observedAt: string
  updatedAt: string
}

export interface SemanticProfile {
  gameId: GameId
  provider: string
  endpoint: string
  profileVersion: string
  target: PersonalSyncTarget
  status: 'active' | 'disabled' | 'needs_review'
  semantics: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface PersonalDraftResolution {
  reviewCandidates: SemanticReviewDraft[]
  added: number
  applied: number
  preserved: number
}

interface SyncMergeOptions {
  codexReviewed?: boolean
  identityPolicy?: 'heuristic' | 'remote-key-only'
  outputLocale?: string
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function assertSanitizedSemanticPayload(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSanitizedSemanticPayload(entry, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  const forbidden = new Set([
    'cookie', 'token', 'authorization', 'password', 'secret', 'uid',
    'roleid', 'accountid', 'phone', 'email'
  ])
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '')
    if (forbidden.has(normalizedKey)) throw new Error(`语义核验数据禁止包含敏感字段：${path}.${key}`)
    assertSanitizedSemanticPayload(entry, `${path}.${key}`)
  }
}

function assertAccountScope(value: string): void {
  if (!/^[a-z0-9-]+:[a-f0-9]{64}$/u.test(value)) {
    throw new Error('个人账号作用域格式不正确')
  }
}

function assertSourceIdentity(provider: string, endpoint: string, externalId: string): void {
  for (const [label, value, maximum] of [
    ['数据来源', provider, 80],
    ['接口标识', endpoint, 160],
    ['官方数据标识', externalId, 300]
  ] as const) {
    if (!value.trim() || value !== value.trim() || value.length > maximum) {
      throw new Error(`${label}格式不正确`)
    }
  }
}

function readSemanticSourceIdentity(
  kind: string,
  payload: Record<string, unknown>
): { provider: string; endpoint: string; externalId: string } | null {
  const provider = typeof payload.provider === 'string'
    ? payload.provider.trim()
    : typeof payload.sourceContext === 'string' && payload.sourceContext.startsWith('miyoushe-')
      ? 'miyoushe'
      : null
  const externalId = [
    payload.officialId,
    payload.officialEventId,
    payload.observedRemoteKey
  ].find((value) => typeof value === 'string' || typeof value === 'number')
  if (!provider || externalId === undefined) return null
  const baseExternalId = String(externalId).trim()
  const observedPeriodKey = typeof payload.observedPeriodKey === 'string'
    ? payload.observedPeriodKey.trim()
    : ''
  const normalizedExternalId = kind === 'personal-challenge-record' && observedPeriodKey
    ? `${baseExternalId}|period:${observedPeriodKey}`
    : baseExternalId
  const endpoint = typeof payload.sourceContext === 'string' && payload.sourceContext.trim()
    ? payload.sourceContext.trim()
    : kind.trim()
  if (!normalizedExternalId || !endpoint) return null
  return { provider, endpoint, externalId: normalizedExternalId }
}

function readPersonalDraftState(
  draft: SemanticReviewDraft,
  completionRule?: PersonalCompletionRule | null
): { completionState: PersonalCompletionState; progressPercent: number | null } | null {
  if (draft.target === 'exploration') {
    const progress = draft.payload.observedProgress ?? draft.payload.observedProgressPercent
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100) {
      return null
    }
    return {
      completionState: progress === 100 ? 'completed' : 'incomplete',
      progressPercent: progress
    }
  }
  if (draft.target === 'cycles' && typeof draft.payload.observedHasChallengeRecord === 'boolean') {
    return {
      completionState: draft.payload.observedHasChallengeRecord ? 'completed' : 'incomplete',
      progressPercent: null
    }
  }
  if (draft.target === 'events' && completionRule) {
    const value = readPayloadPath(draft.payload, completionRule.fieldPath)
    if (completionRule.completedValues.some((candidate) => Object.is(candidate, value))) {
      return { completionState: 'completed', progressPercent: null }
    }
    if (completionRule.incompleteValues.some((candidate) => Object.is(candidate, value))) {
      return { completionState: 'incomplete', progressPercent: null }
    }
  }
  return null
}

function readPayloadPath(payload: Record<string, unknown>, path: string): unknown {
  let current: unknown = payload
  for (const segment of path.split('.')) {
    if (!segment || !current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

function assertPersonalCompletionRule(rule: PersonalCompletionRule): void {
  if (
    !/^observedStatus(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(rule.fieldPath) ||
    rule.fieldPath.length > 160
  ) {
    throw new Error('活动完成语义规则必须指向 observedStatus 下的具体字段')
  }
  if (
    rule.completedValues.length === 0 ||
    rule.completedValues.length > 20 ||
    rule.incompleteValues.length > 20
  ) {
    throw new Error('活动完成语义规则的状态取值数量不正确')
  }
  const values = [...rule.completedValues, ...rule.incompleteValues]
  if (values.some((value) => !['string', 'number', 'boolean'].includes(typeof value))) {
    throw new Error('活动完成语义规则只能使用字符串、数字或布尔值')
  }
  if (rule.completedValues.some((value) =>
    rule.incompleteValues.some((candidate) => Object.is(candidate, value))
  )) {
    throw new Error('活动完成与未完成状态取值不能重叠')
  }
}

function normalizeSyncedEventTitle(title: string): string {
  return title.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '')
}

function eventTitlesEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizeSyncedEventTitle(left)
  const normalizedRight = normalizeSyncedEventTitle(right)
  if (normalizedLeft === normalizedRight) return true
  if (Math.min(normalizedLeft.length, normalizedRight.length) < 6) return false
  return normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)
}

function itemTimeWindowOverlapsPayload(
  item: ChecklistItem,
  payload: Record<string, unknown>
): boolean {
  const observedStartsAt = typeof payload.observedStartsAt === 'string'
    ? Date.parse(payload.observedStartsAt)
    : Number.NaN
  const observedEndsAt = typeof payload.observedEndsAt === 'string'
    ? Date.parse(payload.observedEndsAt)
    : Number.NaN
  const itemStartsAt = item.startsAt ? Date.parse(item.startsAt) : Number.NaN
  const itemEndsAt = item.endsAt ? Date.parse(item.endsAt) : Number.NaN
  if ([observedStartsAt, observedEndsAt, itemStartsAt, itemEndsAt].some(Number.isNaN)) {
    return false
  }
  return observedStartsAt < itemEndsAt && itemStartsAt < observedEndsAt
}

function normalizeSourceTitle(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/[\s\p{P}\p{S}]+/gu, '')
}

function readObservedTitle(payload: Record<string, unknown>): string | null {
  const value = payload.officialTitle ?? payload.title ?? payload.observedTitle
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readObservedMapNodeKind(
  payload: Record<string, unknown>
): Extract<ChecklistItem['mapNodeKind'], 'region' | 'subregion'> | null {
  return payload.observedNodeKind === 'region' || payload.observedNodeKind === 'subregion'
    ? payload.observedNodeKind
    : null
}

function activityTagsNeedReview(tags: string[]): boolean {
  return tags.length === 0 || tags.some((tag) =>
    tag === '待识别' ||
    tag === '未知' ||
    tag.toLocaleLowerCase('en-US') === 'unknown'
  )
}

export class AppDatabase {
  private readonly database: DatabaseSync

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    try {
      this.database.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
      this.migrate()
      this.seedGames()
      this.seedQuestChecklists()
      this.seedPersonalSemanticProfiles()
      this.backfillSemanticReviewBindings()
      this.reconcileSyncTargetStates()
      this.ensureWeeklyForInitializedGames()
      this.consolidateFixedWeeklyItems()
      this.normalizeLegacyActivityTags()
      this.dismissExpiredSemanticReviewCandidates()
      this.normalizeSyncedProgressSafety()
      this.normalizeWeeklySchedules()
      this.resetDueWeeklyItems()
      this.resetDueQuestItems()
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

  getChecklistRevision(): string {
    const rows = this.database.prepare(`
      SELECT id, updated_at AS updatedAt, archived
      FROM checklist_items
      ORDER BY id
    `).all() as Array<{ id: string; updatedAt: string; archived: number }>
    return createHash('sha256').update(stableJson(rows)).digest('hex')
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
          initial_guide_dismissed AS initialGuideDismissed,
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
    return {
      ...(row as Omit<SyncSettings, 'initialGuideDismissed'> & {
        initialGuideDismissed: number
      }),
      initialGuideDismissed: Boolean(
        (row as { initialGuideDismissed: number }).initialGuideDismissed
      )
    }
  }

  getCodexWorkerPreferences(): CodexWorkerPreferences {
    const row = this.database.prepare(`
      SELECT model, reasoning_effort AS reasoningEffort
      FROM codex_worker_settings
      WHERE singleton = 1
    `).get() as CodexWorkerPreferences | undefined
    if (!row) throw new Error('Codex 后台设置不存在')
    return row
  }

  updateCodexWorkerPreferences(
    preferences: CodexWorkerPreferences,
    reference = new Date()
  ): CodexWorkerPreferences {
    const result = this.database.prepare(`
      UPDATE codex_worker_settings
      SET model = ?, reasoning_effort = ?, updated_at = ?
      WHERE singleton = 1
    `).run(preferences.model, preferences.reasoningEffort, reference.toISOString())
    if (result.changes !== 1) throw new Error('Codex 后台设置不存在')
    return this.getCodexWorkerPreferences()
  }

  dismissInitialSyncGuide(gameId: GameId, reference = new Date()): SyncSettings {
    const result = this.database.prepare(`
      UPDATE sync_states
      SET initial_guide_dismissed = 1, updated_at = ?
      WHERE game_id = ?
    `).run(reference.toISOString(), gameId)
    if (result.changes !== 1) throw new Error('游戏同步设置不存在')
    return this.getSyncSettings(gameId)
  }

  getSyncTargetStates(gameId: GameId): SyncTargetState[] {
    const rows = this.database.prepare(`
      SELECT target, last_success_at AS lastSuccessAt,
        last_attempt_at AS lastAttemptAt, status,
        catalog_coverage AS catalogCoverage,
        catalog_source AS catalogSource
      FROM sync_target_states
      WHERE game_id = ?
    `).all(gameId) as Array<Omit<SyncTargetState, 'gameId'>>
    const states = new Map(rows.map((row) => [row.target, row]))
    return (['all', 'tasks', 'events', 'cycles', 'exploration'] as const).map((target) => ({
      gameId,
      target,
      lastSuccessAt: states.get(target)?.lastSuccessAt ?? null,
      lastAttemptAt: states.get(target)?.lastAttemptAt ?? null,
      status: states.get(target)?.status ?? 'idle',
      catalogCoverage: states.get(target)?.catalogCoverage ?? 'empty',
      catalogSource: states.get(target)?.catalogSource ?? null
    }))
  }

  getLastCompletedCatalogAuditAt(gameId: GameId, target: SyncTarget): string | null {
    const row = this.database.prepare(`
      SELECT MAX(completed_at) AS completedAt
      FROM ai_schedule_jobs
      WHERE game_id = ?
        AND status = 'completed'
        AND completed_at IS NOT NULL
        AND (target = ? OR target = 'all')
    `).get(gameId, target) as { completedAt: string | null } | undefined
    return row?.completedAt ?? null
  }

  recordCatalogCoverage(
    gameId: GameId,
    target: SyncTarget,
    source: 'public_schedule' | 'personal_data',
    coverage: 'partial' | 'complete'
  ): void {
    const statement = this.database.prepare(`
      INSERT INTO sync_target_states(
        game_id, target, last_success_at, last_attempt_at, status,
        catalog_coverage, catalog_source
      ) VALUES (?, ?, NULL, NULL, 'idle', ?, ?)
      ON CONFLICT(game_id, target) DO UPDATE SET
        catalog_coverage = CASE
          WHEN sync_target_states.catalog_coverage = 'complete'
            AND excluded.catalog_coverage = 'partial'
          THEN 'complete'
          ELSE excluded.catalog_coverage
        END,
        catalog_source = CASE
          WHEN sync_target_states.catalog_coverage = 'complete'
            AND excluded.catalog_coverage = 'partial'
          THEN sync_target_states.catalog_source
          ELSE excluded.catalog_source
        END
    `)
    statement.run(gameId, target, coverage, source)
  }

  isCatalogComplete(gameId: GameId, target: PersonalSyncTarget): boolean {
    const row = this.database.prepare(`
      SELECT catalog_coverage AS catalogCoverage
      FROM sync_target_states
      WHERE game_id = ? AND target = ?
    `).get(gameId, target) as { catalogCoverage: string } | undefined
    return row?.catalogCoverage === 'complete'
  }

  recordSyncTargetAttempt(
    gameId: GameId,
    target: SyncTarget,
    status: SyncStatus = 'idle',
    reference = new Date()
  ): void {
    const timestamp = reference.toISOString()
    this.database.prepare(`
      INSERT INTO sync_target_states(game_id, target, last_success_at, last_attempt_at, status)
      VALUES (?, ?, NULL, ?, ?)
      ON CONFLICT(game_id, target) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        status = excluded.status
    `).run(gameId, target, timestamp, status)
  }

  recordSyncTargetSuccess(
    gameId: GameId,
    target: SyncTarget,
    reference = new Date(),
    includeGlobal = false
  ): void {
    const targets = target === 'all'
      ? includeGlobal
        ? (['all', 'tasks', 'events', 'cycles', 'exploration'] as const)
        : (['tasks', 'events', 'cycles', 'exploration'] as const)
      : [target]
    const timestamp = reference.toISOString()
    const statement = this.database.prepare(`
      INSERT INTO sync_target_states(
        game_id, target, last_success_at, last_attempt_at, status
      ) VALUES (?, ?, ?, ?, 'success')
      ON CONFLICT(game_id, target) DO UPDATE SET
        last_success_at = excluded.last_success_at,
        last_attempt_at = excluded.last_attempt_at,
        status = 'success'
    `)
    for (const resolvedTarget of targets) {
      statement.run(gameId, resolvedTarget, timestamp, timestamp)
    }
  }

  private reconcileSyncTargetStates(): void {
    const latestJobs = this.database.prepare(`
      SELECT game_id AS gameId, target, status, requested_at AS requestedAt,
        completed_at AS completedAt
      FROM ai_schedule_jobs jobs
      WHERE requested_at = (
        SELECT MAX(candidate.requested_at)
        FROM ai_schedule_jobs candidate
        WHERE candidate.game_id = jobs.game_id AND candidate.target = jobs.target
      )
    `).all() as Array<{
      gameId: GameId
      target: SyncTarget
      status: AiScheduleJob['status']
      requestedAt: string
      completedAt: string | null
    }>
    const readCurrent = this.database.prepare(`
      SELECT last_success_at AS lastSuccessAt, last_attempt_at AS lastAttemptAt
      FROM sync_target_states WHERE game_id = ? AND target = ?
    `)
    const upsert = this.database.prepare(`
      INSERT INTO sync_target_states(
        game_id, target, last_success_at, last_attempt_at, status
      ) VALUES (?, ?, NULL, ?, ?)
      ON CONFLICT(game_id, target) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        status = excluded.status
    `)
    for (const job of latestJobs) {
      const current = readCurrent.get(job.gameId, job.target) as {
        lastSuccessAt: string | null
        lastAttemptAt: string | null
      } | undefined
      const attemptTimestamp = job.completedAt ?? job.requestedAt
      if (current?.lastAttemptAt && current.lastAttemptAt >= attemptTimestamp) continue
      const successful = Boolean(
        job.status === 'completed' &&
        current?.lastSuccessAt &&
        job.completedAt &&
        current.lastSuccessAt >= job.completedAt
      )
      const status: SyncStatus = job.status === 'failed'
        ? 'error'
        : job.status === 'completed'
          ? successful ? 'success' : 'stale'
          : 'idle'
      upsert.run(job.gameId, job.target, attemptTimestamp, status)
    }
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
    successfulDataReceived = status === 'success',
    reference = new Date()
  ): void {
    const now = reference.toISOString()
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

  queueSemanticReviewCandidates(
    gameId: GameId,
    source: 'public_schedule' | 'personal_sync',
    drafts: SemanticReviewDraft[],
    reference = new Date(),
    requestContext: SyncRequestContext = {
      outputLocale: 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    },
    accountScope: string | null = null
  ): { queued: number; pending: number } {
    if (accountScope && !/^[a-z0-9-]+:[a-f0-9]{64}$/u.test(accountScope)) {
      throw new Error('个人账号作用域格式不正确')
    }
    const relevantDrafts = filterRelevantSemanticReviewDrafts(drafts, reference)
    if (relevantDrafts.length > 200) throw new Error('单次语义核验候选不能超过 200 条')
    const now = reference.toISOString()
    const fingerprints: string[] = []
    let queued = 0
    this.runTransaction(() => {
      for (const draft of relevantDrafts) {
        if (!['events', 'cycles', 'exploration'].includes(draft.target)) {
          throw new Error('语义核验候选版块不受支持')
        }
        if (!draft.kind.trim() || draft.kind.length > 100) throw new Error('语义核验类型格式不正确')
        assertSanitizedSemanticPayload(draft.payload)
        const sourceIdentity = source === 'personal_sync'
          ? readSemanticSourceIdentity(draft.kind, draft.payload)
          : null
        if (
          sourceIdentity &&
          this.hasSyncDeletionTombstone(
            gameId,
            this.sourceBindingDeletionKey(
              sourceIdentity.provider,
              sourceIdentity.endpoint,
              sourceIdentity.externalId
            )
          )
        ) {
          continue
        }
        const payloadJson = stableJson(draft.payload)
        if (payloadJson.length > 20_000) throw new Error('语义核验候选内容过大')
        const fingerprint = createHash('sha256')
          .update(
            `${SEMANTIC_REVIEW_PROTOCOL_VERSION}|${gameId}|${source}|${draft.target}|${draft.kind}|${accountScope ?? 'shared'}|${requestContext.outputLocale}|${requestContext.userTimeZone}|${payloadJson}`
          )
          .digest('hex')
        fingerprints.push(fingerprint)
        const result = this.database.prepare(`
          INSERT INTO semantic_review_candidates(
            id, fingerprint, game_id, source, target, kind, status,
            payload_json, output_locale, user_timezone, account_scope, requested_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(fingerprint) DO UPDATE SET
            status = 'pending',
            payload_json = excluded.payload_json,
            output_locale = excluded.output_locale,
            user_timezone = excluded.user_timezone,
            account_scope = excluded.account_scope,
            requested_at = excluded.requested_at,
            claimed_at = NULL,
            completed_at = NULL,
            agent_id = NULL,
            decision_json = NULL,
            evidence_json = NULL,
            message = '上次未解决，已按用户本次同步重新排队',
            updated_at = excluded.updated_at
          WHERE semantic_review_candidates.status = 'rejected'
        `).run(
          randomUUID(),
          fingerprint,
          gameId,
          source,
          draft.target,
          draft.kind.trim(),
          payloadJson,
          requestContext.outputLocale,
          requestContext.userTimeZone,
          accountScope,
          now,
          now
        )
        queued += Number(result.changes)
      }
    })
    if (fingerprints.length === 0) return { queued: 0, pending: 0 }
    const placeholders = fingerprints.map(() => '?').join(', ')
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM semantic_review_candidates
      WHERE fingerprint IN (${placeholders})
        AND status IN ('pending', 'claimed')
    `).get(...fingerprints) as { count: number }
    return { queued, pending: Number(row.count) }
  }

  getSemanticReviewSummary(
    gameId: GameId,
    target?: PersonalSyncTarget
  ): SemanticReviewSummary {
    const targetFilter = target ? ' AND c.target = ?' : ''
    const parameters = target ? [gameId, target] : [gameId]
    const counts = this.database.prepare(`
      SELECT
        SUM(CASE WHEN c.status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
        SUM(CASE WHEN c.status = 'claimed' THEN 1 ELSE 0 END) AS claimedCount,
        SUM(CASE
          WHEN c.status = 'pending'
            AND c.source = 'personal_sync'
            AND COALESCE((
              SELECT s.catalog_coverage
              FROM sync_target_states s
              WHERE s.game_id = c.game_id AND s.target = c.target
            ), 'empty') <> 'complete'
          THEN 1 ELSE 0
        END) AS waitingForCatalogCount
      FROM semantic_review_candidates c
      WHERE c.game_id = ?${targetFilter}
    `).get(...parameters) as {
      pendingCount: number | null
      claimedCount: number | null
      waitingForCatalogCount: number | null
    }
    const latestDecision = this.database.prepare(`
      SELECT c.id, c.game_id AS gameId, c.target, c.status,
        c.completed_at AS completedAt, c.message
      FROM semantic_review_candidates c
      WHERE c.game_id = ?${targetFilter}
        AND c.status IN ('approved', 'rejected') AND c.completed_at IS NOT NULL
      ORDER BY c.completed_at DESC, c.updated_at DESC
      LIMIT 1
    `).get(...parameters) as SemanticReviewDecisionSummary | undefined
    return {
      gameId,
      pendingCount: Number(counts.pendingCount ?? 0),
      claimedCount: Number(counts.claimedCount ?? 0),
      waitingForCatalogCount: Number(counts.waitingForCatalogCount ?? 0),
      latestDecision: latestDecision ?? null
    }
  }

  getActiveSemanticReviewCount(): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM semantic_review_candidates c
      WHERE c.status = 'claimed'
        OR (
          c.status = 'pending'
          AND (
            c.source <> 'personal_sync'
            OR COALESCE((
              SELECT s.catalog_coverage
              FROM sync_target_states s
              WHERE s.game_id = c.game_id AND s.target = c.target
            ), 'empty') = 'complete'
          )
        )
    `).get() as { count: number }
    return Number(row.count)
  }

  getSourceBinding(
    gameId: GameId,
    provider: string,
    endpoint: string,
    externalId: string
  ): SourceBinding | null {
    const row = this.database.prepare(`
      SELECT game_id AS gameId, provider, endpoint, external_id AS externalId,
        item_id AS itemId, binding_kind AS bindingKind, confidence,
        state_rule_json AS stateRuleJson,
        created_at AS createdAt, updated_at AS updatedAt
      FROM source_bindings
      WHERE game_id = ? AND provider = ? AND endpoint = ? AND external_id = ?
    `).get(gameId, provider, endpoint, externalId) as (
      Omit<SourceBinding, 'stateRule'> & { stateRuleJson: string | null }
    ) | undefined
    if (!row) return null
    const { stateRuleJson, ...binding } = row
    return {
      ...binding,
      stateRule: stateRuleJson
        ? JSON.parse(stateRuleJson) as PersonalCompletionRule
        : null
    }
  }

  upsertSourceBinding(
    binding: Omit<SourceBinding, 'createdAt' | 'updatedAt' | 'stateRule'> & {
      stateRule?: PersonalCompletionRule | null
    },
    reference = new Date()
  ): SourceBinding {
    assertSourceIdentity(binding.provider, binding.endpoint, binding.externalId)
    if (!Number.isFinite(binding.confidence) || binding.confidence < 0 || binding.confidence > 1) {
      throw new Error('来源绑定置信度格式不正确')
    }
    if (binding.stateRule) assertPersonalCompletionRule(binding.stateRule)
    const item = this.database.prepare(`
      SELECT game_id AS gameId FROM checklist_items WHERE id = ?
    `).get(binding.itemId) as { gameId: GameId } | undefined
    if (!item || item.gameId !== binding.gameId) {
      throw new Error('来源绑定指向的清单项不存在或不属于当前游戏')
    }
    const existing = this.getSourceBinding(
      binding.gameId,
      binding.provider,
      binding.endpoint,
      binding.externalId
    )
    if (
      existing &&
      existing.itemId !== binding.itemId &&
      binding.bindingKind !== 'codex'
    ) {
      throw new Error('来源标识已经绑定到其他清单项，必须交由 Codex 处理冲突')
    }
    const now = reference.toISOString()
    this.database.prepare(`
      INSERT INTO source_bindings(
        game_id, provider, endpoint, external_id, item_id, binding_kind,
        confidence, state_rule_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, provider, endpoint, external_id) DO UPDATE SET
        item_id = excluded.item_id,
        binding_kind = excluded.binding_kind,
        confidence = excluded.confidence,
        state_rule_json = CASE
          WHEN ? = 1 THEN excluded.state_rule_json
          ELSE source_bindings.state_rule_json
        END,
        updated_at = excluded.updated_at
    `).run(
      binding.gameId,
      binding.provider,
      binding.endpoint,
      binding.externalId,
      binding.itemId,
      binding.bindingKind,
      binding.confidence,
      binding.stateRule ? stableJson(binding.stateRule) : null,
      now,
      now,
      binding.stateRule !== undefined ? 1 : 0
    )
    return this.getSourceBinding(
      binding.gameId,
      binding.provider,
      binding.endpoint,
      binding.externalId
    )!
  }

  getPersonalItemState(accountScope: string, itemId: string): PersonalItemState | null {
    assertAccountScope(accountScope)
    const row = this.database.prepare(`
      SELECT account_scope AS accountScope, game_id AS gameId, item_id AS itemId,
        provider, endpoint, external_id AS externalId,
        completion_state AS completionState, progress_percent AS progressPercent,
        observed_at AS observedAt, updated_at AS updatedAt
      FROM personal_item_states
      WHERE account_scope = ? AND item_id = ?
    `).get(accountScope, itemId) as PersonalItemState | undefined
    return row ?? null
  }

  upsertPersonalItemState(
    state: Omit<PersonalItemState, 'updatedAt'>,
    reference = new Date()
  ): PersonalItemState {
    assertAccountScope(state.accountScope)
    assertSourceIdentity(state.provider, state.endpoint, state.externalId)
    if (
      state.progressPercent !== null &&
      (!Number.isFinite(state.progressPercent) ||
        state.progressPercent < 0 ||
        state.progressPercent > 100)
    ) {
      throw new Error('个人进度百分比必须是 0–100')
    }
    const item = this.database.prepare(`
      SELECT game_id AS gameId FROM checklist_items WHERE id = ?
    `).get(state.itemId) as { gameId: GameId } | undefined
    if (!item || item.gameId !== state.gameId) {
      throw new Error('个人状态指向的清单项不存在或不属于当前游戏')
    }
    const now = reference.toISOString()
    this.database.prepare(`
      INSERT INTO personal_item_states(
        account_scope, game_id, item_id, provider, endpoint, external_id,
        completion_state, progress_percent, observed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_scope, item_id) DO UPDATE SET
        provider = excluded.provider,
        endpoint = excluded.endpoint,
        external_id = excluded.external_id,
        completion_state = excluded.completion_state,
        progress_percent = excluded.progress_percent,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at
    `).run(
      state.accountScope,
      state.gameId,
      state.itemId,
      state.provider,
      state.endpoint,
      state.externalId,
      state.completionState,
      state.progressPercent,
      state.observedAt,
      now
    )
    return this.getPersonalItemState(state.accountScope, state.itemId)!
  }

  getSemanticProfile(
    gameId: GameId,
    provider: string,
    endpoint: string,
    profileVersion: string
  ): SemanticProfile | null {
    const row = this.database.prepare(`
      SELECT game_id AS gameId, provider, endpoint, profile_version AS profileVersion,
        target, status, semantics_json AS semanticsJson,
        created_at AS createdAt, updated_at AS updatedAt
      FROM semantic_profiles
      WHERE game_id = ? AND provider = ? AND endpoint = ? AND profile_version = ?
    `).get(gameId, provider, endpoint, profileVersion) as (
      Omit<SemanticProfile, 'semantics'> & { semanticsJson: string }
    ) | undefined
    if (!row) return null
    const { semanticsJson, ...profile } = row
    return {
      ...profile,
      semantics: JSON.parse(semanticsJson) as Record<string, unknown>
    }
  }

  getActiveSemanticProfile(
    gameId: GameId,
    provider: string,
    endpoint: string
  ): SemanticProfile | null {
    const row = this.database.prepare(`
      SELECT profile_version AS profileVersion
      FROM semantic_profiles
      WHERE game_id = ? AND provider = ? AND endpoint = ? AND status = 'active'
      ORDER BY updated_at DESC, profile_version DESC
      LIMIT 1
    `).get(gameId, provider, endpoint) as { profileVersion: string } | undefined
    return row
      ? this.getSemanticProfile(gameId, provider, endpoint, row.profileVersion)
      : null
  }

  upsertSemanticProfile(
    profile: Omit<SemanticProfile, 'createdAt' | 'updatedAt'>,
    reference = new Date()
  ): SemanticProfile {
    assertSourceIdentity(profile.provider, profile.endpoint, profile.profileVersion)
    assertSanitizedSemanticPayload(profile.semantics, 'semantics')
    const now = reference.toISOString()
    this.database.prepare(`
      INSERT INTO semantic_profiles(
        game_id, provider, endpoint, profile_version, target, status,
        semantics_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, provider, endpoint, profile_version) DO UPDATE SET
        target = excluded.target,
        status = excluded.status,
        semantics_json = excluded.semantics_json,
        updated_at = excluded.updated_at
    `).run(
      profile.gameId,
      profile.provider,
      profile.endpoint,
      profile.profileVersion,
      profile.target,
      profile.status,
      stableJson(profile.semantics),
      now,
      now
    )
    return this.getSemanticProfile(
      profile.gameId,
      profile.provider,
      profile.endpoint,
      profile.profileVersion
    )!
  }

  resolveKnownPersonalDrafts(
    gameId: GameId,
    accountScope: string,
    drafts: SemanticReviewDraft[],
    reference = new Date()
  ): PersonalDraftResolution {
    assertAccountScope(accountScope)
    return this.runTransaction(() => {
      const remaining: SemanticReviewDraft[] = []
      let added = 0
      let applied = 0
      let preserved = 0
      for (const draft of drafts) {
        let createdThisDraft = false
        const identity = readSemanticSourceIdentity(draft.kind, draft.payload)
        if (
          identity &&
          this.hasSyncDeletionTombstone(
            gameId,
            this.sourceBindingDeletionKey(
              identity.provider,
              identity.endpoint,
              identity.externalId
            )
          )
        ) {
          preserved += 1
          continue
        }
        if (!this.isCatalogComplete(gameId, draft.target)) {
          remaining.push(draft)
          continue
        }
        if (!identity) {
          remaining.push(draft)
          continue
        }
        let binding = this.getSourceBinding(
          gameId,
          identity.provider,
          identity.endpoint,
          identity.externalId
        )
        let item = binding
          ? this.findActiveChecklistItem(binding.itemId, gameId)
          : null
        if (binding && !item && this.isArchivedChecklistItem(binding.itemId, gameId)) {
          preserved += 1
          continue
        }
        let hasConflictingMechanicalBinding = false
        if (
          item &&
          binding?.bindingKind !== 'codex' &&
          !this.isPersonalDraftBindingConsistent(draft, item)
        ) {
          item = null
          binding = null
          hasConflictingMechanicalBinding = true
        }
        if (!item && !hasConflictingMechanicalBinding && draft.target === 'cycles') {
          const modeKey = typeof draft.payload.observedModeKey === 'string'
            ? draft.payload.observedModeKey.trim()
            : ''
          const observedPeriodKey = typeof draft.payload.observedPeriodKey === 'string'
            ? draft.payload.observedPeriodKey.trim()
            : ''
          const modeMatches = modeKey
            ? this.listChecklistItems(gameId).filter(
                (candidate) =>
                  candidate.category === 'endgame' &&
                  candidate.source !== 'manual' &&
                  candidate.modeKey === modeKey
              )
            : []
          const periodMatches = observedPeriodKey
            ? modeMatches.filter((candidate) => candidate.periodKey === observedPeriodKey)
            : []
          const overlappingMatches = modeMatches.filter((candidate) =>
            itemTimeWindowOverlapsPayload(candidate, draft.payload)
          )
          const matches = periodMatches.length === 1
            ? periodMatches
            : overlappingMatches.length === 1
              ? overlappingMatches
              : modeMatches.length === 1
                ? modeMatches
                : []
          if (matches.length === 1) {
            item = matches[0]
            binding = this.upsertSourceBinding({
              gameId,
              ...identity,
              itemId: item.id,
              bindingKind: 'mechanical',
              confidence: 1
            }, reference)
          }
        }
        if (!item && !hasConflictingMechanicalBinding && draft.target === 'cycles') {
          const created = this.createTrustedOfficialCycleItem(
            gameId,
            identity,
            draft.payload,
            reference
          )
          if (created) {
            item = created.item
            binding = created.binding
            added += created.added
            createdThisDraft = created.added > 0
          }
        }
        if (!item && !hasConflictingMechanicalBinding && draft.target === 'events') {
          const observedTitle = readObservedTitle(draft.payload)
          const matches = observedTitle
            ? this.listChecklistItems(gameId).filter(
                (candidate) =>
                  candidate.category === 'limited_event' &&
                  candidate.source !== 'manual' &&
                  normalizeSourceTitle(candidate.title) === normalizeSourceTitle(observedTitle)
              )
            : []
          if (matches.length === 1) {
            item = matches[0]
            binding = this.upsertSourceBinding({
              gameId,
              ...identity,
              itemId: item.id,
              bindingKind: 'mechanical',
              confidence: 1
            }, reference)
          }
        }
        if (!item && !hasConflictingMechanicalBinding && draft.target === 'exploration') {
          const observedTitle = readObservedTitle(draft.payload)
          const observedNodeKind = readObservedMapNodeKind(draft.payload)
          const observedParentTitle = typeof draft.payload.observedParentTitle === 'string'
            ? draft.payload.observedParentTitle.trim()
            : ''
          const titleMatches = observedTitle
            ? this.listChecklistItems(gameId).filter(
                (candidate) =>
                  candidate.category === 'exploration' &&
                  candidate.source !== 'manual' &&
                  normalizeSourceTitle(candidate.title) === normalizeSourceTitle(observedTitle)
              )
            : []
          // The bundled catalog owns hierarchy. A provider's grouping is only
          // an observation, so an exact title that is unique in the canonical
          // catalog can bind even when the provider reports a different level.
          const matches = titleMatches.length <= 1
            ? titleMatches
            : titleMatches.filter(
                (candidate) =>
                  (!observedNodeKind || candidate.mapNodeKind === observedNodeKind) &&
                  (
                    observedNodeKind !== 'subregion' ||
                    !observedParentTitle ||
                    normalizeSourceTitle(candidate.parentTitle ?? '') ===
                      normalizeSourceTitle(observedParentTitle)
                  )
              )
          if (matches.length === 1) {
            item = matches[0]
            binding = this.upsertSourceBinding({
              gameId,
              ...identity,
              itemId: item.id,
              bindingKind: 'mechanical',
              confidence: 1
            }, reference)
          }
        }
        if (!item && !hasConflictingMechanicalBinding && draft.target === 'exploration') {
          const created = this.createTrustedOfficialMapItem(
            gameId,
            identity,
            draft.payload,
            reference
          )
          if (created) {
            item = created.item
            binding = created.binding
            added += created.added
            createdThisDraft = created.added > 0
          }
        }
        if (!binding || !item) {
          remaining.push(draft)
          continue
        }
        if (
          draft.target === 'cycles' &&
          !this.getActiveSemanticProfile(gameId, identity.provider, identity.endpoint)
        ) {
          remaining.push(draft)
          continue
        }
        const expectedCategories: Record<PersonalSyncTarget, ChecklistCategory[]> = {
          events: ['limited_event'],
          cycles: ['endgame', 'weekly'],
          exploration: ['exploration']
        }
        if (!expectedCategories[draft.target].includes(item.category)) {
          remaining.push(draft)
          continue
        }
        const observed = readPersonalDraftState(draft, binding.stateRule)
        if (!observed) {
          remaining.push(draft)
          continue
        }
        const result = this.applyPersonalStateToChecklist(
          item,
          accountScope,
          identity,
          observed,
          reference
        )
        applied += createdThisDraft ? 0 : result.applied
        preserved += result.preserved
      }
      return { reviewCandidates: remaining, added, applied, preserved }
    })
  }

  private createTrustedOfficialMapItem(
    gameId: GameId,
    identity: { provider: string; endpoint: string; externalId: string },
    payload: Record<string, unknown>,
    reference: Date
  ): { item: ChecklistItem; binding: SourceBinding; added: number } | null {
    if (
      !hasOfficialPersonalFact(payload, 'identity') ||
      !hasOfficialPersonalFact(payload, 'localized_title') ||
      !hasOfficialPersonalFact(payload, 'progress') ||
      !hasOfficialPersonalFact(payload, 'hierarchy')
    ) {
      return null
    }
    const title = readObservedTitle(payload)
    const mapNodeKind = readObservedMapNodeKind(payload)
    const observed = readPersonalDraftState({
      target: 'exploration',
      kind: 'personal-map-progress',
      payload
    })
    if (!title || !mapNodeKind || !observed || observed.progressPercent === null) {
      return null
    }

    let parent: ChecklistItem | null = null
    if (mapNodeKind === 'subregion') {
      const parentId = typeof payload.observedParentId === 'string' ||
        typeof payload.observedParentId === 'number'
        ? String(payload.observedParentId).trim()
        : ''
      if (!parentId) return null
      const parentBinding = this.getSourceBinding(
        gameId,
        identity.provider,
        identity.endpoint,
        parentId
      )
      parent = parentBinding
        ? this.findActiveChecklistItem(parentBinding.itemId, gameId)
        : null
      if (!parent) {
        const parentTitle = typeof payload.observedParentTitle === 'string'
          ? payload.observedParentTitle.trim()
          : ''
        const parentMatches = parentTitle
          ? this.listChecklistItems(gameId).filter(
              (candidate) =>
                candidate.category === 'exploration' &&
                candidate.source !== 'manual' &&
                candidate.mapNodeKind === 'region' &&
                normalizeSourceTitle(candidate.title) === normalizeSourceTitle(parentTitle)
            )
          : []
        if (parentMatches.length !== 1) return null
        parent = parentMatches[0]
        this.upsertSourceBinding({
          gameId,
          provider: identity.provider,
          endpoint: identity.endpoint,
          externalId: parentId,
          itemId: parent.id,
          bindingKind: 'mechanical',
          confidence: 1
        }, reference)
      }
      if (
        parent.category !== 'exploration' ||
        parent.mapNodeKind !== 'region' ||
        !parent.remoteKey
      ) return null
    } else if (payload.observedParentId !== null && payload.observedParentId !== undefined) {
      return null
    }

    const remoteKey = `personal-map:${createHash('sha256')
      .update(`${identity.provider}|${identity.endpoint}|${identity.externalId}`)
      .digest('hex')
      .slice(0, 32)}`
    const merge = this.mergeSyncedItems(
      gameId,
      'personal_sync',
      [{
        remoteKey,
        category: 'exploration',
        title,
        progressPercent: observed.progressPercent,
        mapNodeKind,
        parentTitle: parent?.title ?? null,
        parentRemoteKey: parent?.remoteKey ?? null
      }],
      reference.toISOString(),
      false,
      {
        codexReviewed: true,
        identityPolicy: 'remote-key-only'
      }
    )
    const item = this.findActiveChecklistItemByRemoteKey(gameId, remoteKey)
    if (!item) return null
    const binding = this.upsertSourceBinding({
      gameId,
      ...identity,
      itemId: item.id,
      bindingKind: 'mechanical',
      confidence: 1
    }, reference)
    return { item, binding, added: merge.added }
  }

  private createTrustedOfficialCycleItem(
    gameId: GameId,
    identity: { provider: string; endpoint: string; externalId: string },
    payload: Record<string, unknown>,
    reference: Date
  ): { item: ChecklistItem; binding: SourceBinding; added: number } | null {
    if (
      !hasOfficialPersonalFact(payload, 'identity') ||
      !hasOfficialPersonalFact(payload, 'localized_title') ||
      !hasOfficialPersonalFact(payload, 'time_window') ||
      !hasOfficialPersonalFact(payload, 'challenge_record') ||
      !this.getActiveSemanticProfile(gameId, identity.provider, identity.endpoint)
    ) {
      return null
    }
    const title = readObservedTitle(payload)
    const modeKey = typeof payload.observedModeKey === 'string'
      ? payload.observedModeKey.trim()
      : ''
    const periodKey = typeof payload.observedPeriodKey === 'string'
      ? payload.observedPeriodKey.trim()
      : ''
    const startsAt = typeof payload.observedStartsAt === 'string'
      ? payload.observedStartsAt.trim()
      : ''
    const endsAt = typeof payload.observedEndsAt === 'string'
      ? payload.observedEndsAt.trim()
      : ''
    const observed = readPersonalDraftState({
      target: 'cycles',
      kind: 'personal-challenge-record',
      payload
    })
    if (
      !title ||
      !modeKey ||
      !periodKey ||
      !startsAt ||
      !endsAt ||
      !observed ||
      Number.isNaN(Date.parse(startsAt)) ||
      Number.isNaN(Date.parse(endsAt)) ||
      Date.parse(startsAt) >= Date.parse(endsAt)
    ) {
      return null
    }
    const remoteKey = `personal-cycle:${createHash('sha256')
      .update(`${identity.provider}|${identity.endpoint}|${identity.externalId}|${periodKey}`)
      .digest('hex')
      .slice(0, 32)}`
    const merge = this.mergeSyncedItems(
      gameId,
      'personal_sync',
      [{
        remoteKey,
        category: 'endgame',
        title,
        completed: observed.completionState === 'completed',
        startsAt,
        endsAt,
        periodKey,
        scheduleKind: 'remote_schedule',
        modeKey
      }],
      reference.toISOString(),
      false,
      {
        codexReviewed: true,
        identityPolicy: 'remote-key-only'
      }
    )
    const item = this.findActiveChecklistItemByRemoteKey(gameId, remoteKey)
    if (!item) return null
    const binding = this.upsertSourceBinding({
      gameId,
      ...identity,
      itemId: item.id,
      bindingKind: 'mechanical',
      confidence: 1
    }, reference)
    return { item, binding, added: merge.added }
  }

  private isPersonalDraftBindingConsistent(
    draft: SemanticReviewDraft,
    item: ChecklistItem
  ): boolean {
    if (draft.target === 'exploration') {
      const observedTitle = readObservedTitle(draft.payload)
      if (
        observedTitle &&
        normalizeSourceTitle(observedTitle) !== normalizeSourceTitle(item.title)
      ) {
        return false
      }
    }
    if (draft.target === 'cycles') {
      const observedModeKey = typeof draft.payload.observedModeKey === 'string'
        ? draft.payload.observedModeKey.trim()
        : ''
      if (observedModeKey && item.modeKey && observedModeKey !== item.modeKey) return false
    }
    if (draft.target === 'events') {
      const observedTitle = readObservedTitle(draft.payload)
      if (observedTitle && !eventTitlesEquivalent(observedTitle, item.title)) return false
    }
    return true
  }

  cancelSemanticReviewCandidates(
    gameId: GameId,
    target: PersonalSyncTarget,
    reference = new Date()
  ): { cancelled: number; agentIds: string[] } {
    const rows = this.database.prepare(`
      SELECT DISTINCT agent_id AS agentId
      FROM semantic_review_candidates
      WHERE game_id = ? AND target = ?
        AND source = 'personal_sync'
        AND status = 'claimed' AND agent_id IS NOT NULL
    `).all(gameId, target) as Array<{ agentId: string }>
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE semantic_review_candidates
      SET status = 'rejected', completed_at = ?, decision_json = NULL,
          evidence_json = NULL, message = '用户已取消',
          agent_id = NULL, claimed_at = NULL, updated_at = ?
      WHERE game_id = ? AND target = ? AND source = 'personal_sync'
        AND status IN ('pending', 'claimed')
    `).run(now, now, gameId, target)
    const cancelled = Number(result.changes)
    if (cancelled > 0) {
      this.settleSemanticReviewTargetIfDone(gameId, target, reference)
    }
    return {
      cancelled,
      agentIds: rows.map((row) => row.agentId)
    }
  }

  cancelAllSemanticReviewCandidates(
    reference = new Date()
  ): { cancelled: number; agentIds: string[] } {
    const rows = this.database.prepare(`
      SELECT DISTINCT agent_id AS agentId
      FROM semantic_review_candidates
      WHERE status = 'claimed' AND agent_id IS NOT NULL
    `).all() as Array<{ agentId: string }>
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE semantic_review_candidates
      SET status = 'rejected', completed_at = ?, decision_json = NULL,
          evidence_json = NULL, message = '应用已退出，任务已取消',
          agent_id = NULL, claimed_at = NULL, updated_at = ?
      WHERE status IN ('pending', 'claimed')
    `).run(now, now)
    return {
      cancelled: Number(result.changes),
      agentIds: rows.map((row) => row.agentId)
    }
  }

  requeueClaimedSemanticReviewsByAgent(
    agentId: string,
    message = 'Codex 自动进程已结束，核验任务已重新排队',
    reference = new Date()
  ): number {
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE semantic_review_candidates
      SET status = 'pending', agent_id = NULL, claimed_at = NULL,
          message = ?, updated_at = ?
      WHERE status = 'claimed' AND agent_id = ?
    `).run(message, now, agentId)
    return Number(result.changes)
  }

  claimSemanticReviewCandidate(
    agentId: string,
    reference = new Date()
  ): SemanticReviewCandidate | null {
    return this.claimSemanticReviewBatch(agentId, 1, reference)[0] ?? null
  }

  claimSemanticReviewBatch(
    agentId: string,
    limit = 6,
    reference = new Date()
  ): SemanticReviewCandidate[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
      throw new Error('语义核验批量大小必须是 1–30')
    }
    return this.runTransaction(() => {
      const agent = this.database.prepare('SELECT name FROM ai_schedule_agents WHERE id = ?').get(agentId)
      if (!agent) throw new Error('AI 资料 Agent 尚未登记')
      const now = reference.toISOString()
      this.database.prepare(`
        UPDATE ai_schedule_agents SET last_seen_at = ?, updated_at = ? WHERE id = ?
      `).run(now, now, agentId)
      const staleBefore = new Date(reference.getTime() - AI_JOB_CLAIM_MAX_AGE_MS).toISOString()
      this.database.prepare(`
        UPDATE semantic_review_candidates
        SET status = 'pending', agent_id = NULL, claimed_at = NULL,
            message = 'Agent 超时，候选已重新排队', updated_at = ?
        WHERE status = 'claimed' AND claimed_at < ?
      `).run(now, staleBefore)
      const pending = this.database.prepare(`
        SELECT game_id AS gameId, target, account_scope AS accountScope,
          requested_at AS requestedAt
        FROM semantic_review_candidates c
        WHERE c.status = 'pending'
          AND (
            c.source <> 'personal_sync'
            OR COALESCE((
              SELECT s.catalog_coverage
              FROM sync_target_states s
              WHERE s.game_id = c.game_id AND s.target = c.target
            ), 'empty') = 'complete'
          )
        ORDER BY requested_at ASC
        LIMIT 1
      `).get() as {
        gameId: GameId
        target: PersonalSyncTarget
        accountScope: string | null
        requestedAt: string
      } | undefined
      if (!pending) return []
      const rows = this.database.prepare(`
        SELECT id
        FROM semantic_review_candidates
        WHERE status = 'pending'
          AND game_id = ?
          AND target = ?
          AND account_scope IS ?
          AND requested_at = ?
          AND (
            source <> 'personal_sync'
            OR COALESCE((
              SELECT catalog_coverage
              FROM sync_target_states
              WHERE game_id = semantic_review_candidates.game_id
                AND target = semantic_review_candidates.target
            ), 'empty') = 'complete'
          )
        ORDER BY
          CASE
            WHEN target = 'exploration'
              AND json_extract(payload_json, '$.observedParentId') IS NOT NULL
              THEN 1
            ELSE 0
          END,
          id ASC
        LIMIT ?
      `).all(
        pending.gameId,
        pending.target,
        pending.accountScope,
        pending.requestedAt,
        limit
      ) as Array<{ id: string }>
      const claim = this.database.prepare(`
        UPDATE semantic_review_candidates
        SET status = 'claimed', agent_id = ?, claimed_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `)
      const claimed: SemanticReviewCandidate[] = []
      for (const row of rows) {
        if (claim.run(agentId, now, now, row.id).changes === 1) {
          claimed.push(this.getSemanticReviewCandidate(row.id))
        }
      }
      return claimed
    })
  }

  approveSemanticReviewCandidate(
    id: string,
    agentId: string,
    item: NormalizedSyncItem,
    confidence: number,
    evidence: unknown,
    reference = new Date(),
    matchItemId?: string,
    contentLocale?: string,
    archiveItems: CodexArchiveDecision[] = [],
    completionRule?: PersonalCompletionRule | null
  ): {
    candidate: SemanticReviewCandidate
    merge: SyncMergeResult
    archived: number
  } {
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error('语义核验置信度格式不正确')
    }
    const candidate = this.getSemanticReviewCandidate(id)
    if (contentLocale && contentLocale !== candidate.requestContext.outputLocale) {
      throw new Error('提交内容语言与接口请求语言不一致')
    }
    if (candidate.status !== 'claimed' || candidate.agentId !== agentId) {
      throw new Error('语义核验候选未由当前 Agent 领取或已经结束')
    }
    if (
      candidate.source === 'personal_sync' &&
      !this.isCatalogComplete(candidate.gameId, candidate.target)
    ) {
      throw new Error('当前版块的公开规范清单尚未完成，个人进度暂不能写入')
    }
    const semanticWritableCategories: ChecklistCategory[] = [
      'limited_event',
      'weekly',
      'endgame',
      'exploration'
    ]
    if (!semanticWritableCategories.includes(item.category)) {
      throw new Error('个人数据核验只能写入活动、周期事项或地图探索')
    }
    if (candidate.source === 'personal_sync') {
      if (item.category === 'exploration') {
        if (
          item.progressPercent === undefined ||
          item.progressPercent === null ||
          !Number.isFinite(item.progressPercent) ||
          item.progressPercent < 0 ||
          item.progressPercent > 100
        ) {
          throw new Error('Codex 必须为个人地图数据提交 0–100 的探索度')
        }
        if (item.mapNodeKind !== 'region' && item.mapNodeKind !== 'subregion') {
          throw new Error('个人地图清单只接受一级主地区或二级地区')
        }
      } else if (
        candidate.target === 'cycles' &&
        typeof item.completed !== 'boolean'
      ) {
        throw new Error('Codex 必须为个人周期事项明确提交完成状态')
      } else if (
        candidate.target === 'events' &&
        typeof item.completed === 'boolean'
      ) {
        if (!completionRule) {
          throw new Error('Codex 提交活动完成状态时必须同时提交可复用的字段语义规则')
        }
        assertPersonalCompletionRule(completionRule)
        const mechanicallyObserved = readPersonalDraftState(
          {
            target: candidate.target,
            kind: candidate.kind,
            payload: candidate.payload
          },
          completionRule
        )
        if (
          !mechanicallyObserved ||
          (mechanicallyObserved.completionState === 'completed') !== item.completed
        ) {
          throw new Error('活动完成规则无法从本次个人原始字段机械复现提交状态')
        }
      }
    }
    const matchCandidates = this.listSemanticReviewMatchCandidates(
      candidate.gameId,
      candidate.target
    )
    const matchCandidatesById = new Map(matchCandidates.map((entry) => [entry.id, entry]))
    let resolvedItem = item
    if (matchItemId) {
      const matched = matchCandidatesById.get(matchItemId)
      if (!matched) throw new Error('指定的清单匹配项不属于当前语义核验版块')
      if (!matched.remoteKey) throw new Error('指定的清单匹配项缺少稳定远端标识')
      resolvedItem = {
        ...item,
        remoteKey: matched.remoteKey
      }
    }
    const archiveIds = new Set<string>()
    for (const decision of archiveItems) {
      if (!decision.reason.trim()) throw new Error('Codex 删除决定必须包含原因')
      if (archiveIds.has(decision.itemId)) throw new Error('Codex 删除决定包含重复事项')
      if (decision.itemId === matchItemId) throw new Error('不能删除本次选定的匹配事项')
      const duplicate = matchCandidatesById.get(decision.itemId)
      if (!duplicate) throw new Error('Codex 只能删除当前语义核验版块提供的同步事项')
      if (duplicate.category === 'weekly') throw new Error('固定周常不能由同步流程删除')
      archiveIds.add(decision.itemId)
    }
    return this.runTransaction(() => {
      const merge = this.mergeSyncedItems(
        candidate.gameId,
        candidate.source,
        [resolvedItem],
        reference.toISOString(),
        false,
        {
          codexReviewed: true,
          identityPolicy: 'remote-key-only',
          outputLocale: candidate.requestContext.outputLocale
        }
      )
      if (candidate.source === 'personal_sync') {
        const identity = readSemanticSourceIdentity(candidate.kind, candidate.payload)
        const mergedItem = matchItemId
          ? this.findActiveChecklistItem(matchItemId, candidate.gameId)
          : this.findActiveChecklistItemByRemoteKey(candidate.gameId, resolvedItem.remoteKey)
        if (identity && mergedItem) {
          this.upsertSourceBinding({
            gameId: candidate.gameId,
            ...identity,
            itemId: mergedItem.id,
            bindingKind: 'codex',
            confidence,
            stateRule: candidate.target === 'events'
              ? completionRule ?? null
              : null
          }, reference)
          if (candidate.accountScope) {
            const submittedState = mergedItem.category === 'exploration'
              ? {
                  completionState: mergedItem.progressPercent === 100
                    ? 'completed' as const
                    : 'incomplete' as const,
                  progressPercent: mergedItem.progressPercent
                }
              : typeof resolvedItem.completed === 'boolean'
                ? {
                    completionState: mergedItem.completed
                      ? 'completed' as const
                      : 'incomplete' as const,
                    progressPercent: null
                  }
                : {
                    completionState: 'unknown' as const,
                    progressPercent: null
                  }
            this.applyPersonalStateToChecklist(
              mergedItem,
              candidate.accountScope,
              identity,
              submittedState,
              reference
            )
          }
        }
      }
      const now = reference.toISOString()
      const archiveSyncedItem = this.database.prepare(`
        UPDATE checklist_items
        SET archived = 1, updated_at = ?
        WHERE id = ? AND game_id = ? AND archived = 0 AND source <> 'manual'
      `)
      let archived = 0
      for (const decision of archiveItems) {
        const result = archiveSyncedItem.run(now, decision.itemId, candidate.gameId)
        if (result.changes !== 1) throw new Error('待删除的重复同步事项已不存在或不允许删除')
        archived += 1
      }
      this.assertActiveMapReferences(candidate.gameId)
      this.database.prepare(`
        UPDATE semantic_review_candidates
        SET status = 'approved', completed_at = ?, decision_json = ?,
            evidence_json = ?, message = 'Codex 核验通过并已安全写入', updated_at = ?
        WHERE id = ? AND status = 'claimed' AND agent_id = ?
      `).run(
        now,
        JSON.stringify({
          item,
          matchItemId: matchItemId ?? null,
          archiveItems,
          confidence,
          completionRule: completionRule ?? null
        }),
        JSON.stringify(evidence),
        now,
        id,
        agentId
      )
      this.settleSemanticReviewTargetIfDone(candidate.gameId, candidate.target, reference)
      return { candidate: this.getSemanticReviewCandidate(id), merge, archived }
    })
  }

  listSemanticReviewMatchCandidates(
    gameId: GameId,
    target: PersonalSyncTarget
  ): ChecklistItem[] {
    const categories: Record<PersonalSyncTarget, ChecklistCategory[]> = {
      events: ['limited_event'],
      cycles: ['weekly', 'endgame'],
      exploration: ['exploration']
    }
    return this.listChecklistItems(gameId).filter(
      (item) => item.source !== 'manual' && categories[target].includes(item.category)
    )
  }

  getBoundSemanticReviewItem(candidate: SemanticReviewCandidate): ChecklistItem | null {
    const identity = readSemanticSourceIdentity(candidate.kind, candidate.payload)
    if (!identity) return null
    const binding = this.getSourceBinding(
      candidate.gameId,
      identity.provider,
      identity.endpoint,
      identity.externalId
    )
    if (!binding) return null
    const item = this.findActiveChecklistItem(binding.itemId, candidate.gameId)
    if (binding.bindingKind === 'codex') return item
    return item && this.isPersonalDraftBindingConsistent(
      { target: candidate.target, kind: candidate.kind, payload: candidate.payload },
      item
    )
      ? item
      : null
  }

  rejectSemanticReviewCandidate(
    id: string,
    agentId: string,
    message: string,
    evidence: unknown,
    reference = new Date()
  ): SemanticReviewCandidate {
    if (!message.trim()) throw new Error('拒绝原因不能为空')
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE semantic_review_candidates
      SET status = 'rejected', completed_at = ?, evidence_json = ?,
          message = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND agent_id = ?
    `).run(now, JSON.stringify(evidence), message.trim(), now, id, agentId)
    if (result.changes === 0) throw new Error('语义核验候选未由当前 Agent 领取或已经结束')
    const candidate = this.getSemanticReviewCandidate(id)
    this.settleSemanticReviewTargetIfDone(candidate.gameId, candidate.target, reference)
    return candidate
  }

  private settleSemanticReviewTargetIfDone(
    gameId: GameId,
    target: PersonalSyncTarget,
    reference: Date
  ): void {
    const unsettled = this.database.prepare(`
      SELECT 1
      FROM semantic_review_candidates
      WHERE game_id = ? AND target = ? AND status IN ('pending', 'claimed')
      LIMIT 1
    `).get(gameId, target)
    if (unsettled) return
    const latestBatch = this.database.prepare(`
      SELECT MAX(requested_at) AS requestedAt
      FROM semantic_review_candidates
      WHERE game_id = ? AND target = ?
    `).get(gameId, target) as { requestedAt: string | null }
    const rejected = latestBatch.requestedAt
      ? this.database.prepare(`
          SELECT 1
          FROM semantic_review_candidates
          WHERE game_id = ? AND target = ? AND requested_at = ? AND status = 'rejected'
          LIMIT 1
        `).get(gameId, target, latestBatch.requestedAt)
      : null
    if (rejected) {
      this.recordSyncTargetAttempt(gameId, target, 'stale', reference)
    } else {
      this.recordSyncTargetSuccess(gameId, target, reference)
    }
    if (latestBatch.requestedAt) {
      this.settlePersonalSyncOutcomeIfDone(gameId, latestBatch.requestedAt, reference)
    }
  }

  private settlePersonalSyncOutcomeIfDone(
    gameId: GameId,
    requestedAt: string,
    reference: Date
  ): void {
    const unresolved = this.database.prepare(`
      SELECT 1
      FROM semantic_review_candidates
      WHERE game_id = ? AND source = 'personal_sync'
        AND requested_at = ? AND status IN ('pending', 'claimed')
      LIMIT 1
    `).get(gameId, requestedAt)
    if (unresolved) return
    const newerUnresolved = this.database.prepare(`
      SELECT 1
      FROM semantic_review_candidates
      WHERE game_id = ? AND source = 'personal_sync'
        AND requested_at > ? AND status IN ('pending', 'claimed')
      LIMIT 1
    `).get(gameId, requestedAt)
    if (newerUnresolved) return
    const rejected = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM semantic_review_candidates
      WHERE game_id = ? AND source = 'personal_sync'
        AND requested_at = ? AND status = 'rejected'
    `).get(gameId, requestedAt) as { count: number }
    const rejectedCount = Number(rejected.count)
    this.recordSyncOutcome(
      gameId,
      rejectedCount > 0 ? 'stale' : 'success',
      rejectedCount > 0
        ? `个人进度同步结束；${rejectedCount} 条记录未能可靠确认，已保留原状态`
        : '个人进度同步完成',
      rejectedCount === 0,
      reference
    )
  }

  private getSemanticReviewCandidate(id: string): SemanticReviewCandidate {
    const row = this.database.prepare(`
      SELECT c.id, c.game_id AS gameId, c.source, c.target, c.kind, c.status,
        c.payload_json AS payloadJson, c.requested_at AS requestedAt,
        c.claimed_at AS claimedAt, c.completed_at AS completedAt,
        c.agent_id AS agentId, a.name AS agentName, c.message,
        c.output_locale AS outputLocale, c.user_timezone AS userTimeZone,
        c.account_scope AS accountScope
      FROM semantic_review_candidates c
      LEFT JOIN ai_schedule_agents a ON a.id = c.agent_id
      WHERE c.id = ?
    `).get(id) as (Omit<SemanticReviewCandidate, 'payload' | 'requestContext'> & {
      payloadJson: string
      outputLocale: string
      userTimeZone: string
    }) | undefined
    if (!row) throw new Error('语义核验候选不存在')
    const { payloadJson, outputLocale, userTimeZone, ...candidate } = row
    return {
      ...candidate,
      requestContext: { outputLocale, userTimeZone },
      payload: JSON.parse(payloadJson) as Record<string, unknown>
    }
  }

  createAiScheduleJob(
    gameId: GameId,
    scope: SyncScope,
    reference = new Date(),
    allowWithoutAgent = false,
    target: SyncTarget = 'all',
    requestContext: SyncRequestContext | string = {
      outputLocale: 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    }
  ): AiScheduleJob {
    const resolvedRequestContext = typeof requestContext === 'string'
      ? { outputLocale: 'zh-CN', userTimeZone: requestContext }
      : requestContext
    const agent = this.getAiScheduleAgentStatus(reference)
    if (!agent.connected && !allowWithoutAgent) {
      throw new Error('Codex 自动同步尚未就绪：尚未连接可用的本地 Agent')
    }
    this.requeueStaleAiScheduleJobs(reference)
    const active = this.database.prepare(`
      SELECT id, scope, target FROM ai_schedule_jobs
      WHERE game_id = ? AND status IN ('pending', 'claimed')
        AND (
          target = ?
          OR target = 'all'
          OR ? = 'all'
        )
      ORDER BY requested_at ASC LIMIT 1
    `).get(gameId, target, target) as {
      id: string
      scope: SyncScope
      target: SyncTarget
    } | undefined
    if (active) {
      if (active.target !== target) {
        throw new Error('全局同步与版块同步不能重复排队，请等待当前全局任务完成')
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
        id, game_id, scope, target, user_timezone, output_locale, status, requested_at,
        progress_phase, progress_updated_at, message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'queued', ?,
        '正在启动本机 Codex', ?)
    `).run(
      id,
      gameId,
      scope,
      target,
      resolvedRequestContext.userTimeZone,
      resolvedRequestContext.outputLocale,
      now,
      now,
      now
    )
    this.database.prepare(`
      UPDATE sync_states
      SET status = 'idle', last_scope = ?, last_attempt_at = ?,
          message = '公开资料任务已提交给 AI，等待检索', updated_at = ?
      WHERE game_id = ?
    `).run(scope, now, now, gameId)
    this.recordSyncTargetAttempt(gameId, target, 'idle', reference)
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
        SET status = 'claimed', agent_id = ?, claimed_at = ?,
            progress_phase = 'searching', progress_current = 0,
            progress_total = NULL, progress_updated_at = ?,
            message = 'Codex 已接单，正在准备检索', updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(agentId, now, now, now, pending.id)
      return this.getAiScheduleJob(pending.id)
    })
  }

  getActiveAiScheduleJob(gameId: GameId, target?: SyncTarget): AiScheduleJob | null {
    const targetFilter = target ? ' AND target = ?' : ''
    const parameters = target ? [gameId, target] : [gameId]
    const row = this.database.prepare(`
      SELECT id FROM ai_schedule_jobs
      WHERE game_id = ? AND status IN ('pending', 'claimed')
        ${targetFilter}
      ORDER BY requested_at ASC LIMIT 1
    `).get(...parameters) as { id: string } | undefined
    return row ? this.getAiScheduleJob(row.id) : null
  }

  cancelActiveAiScheduleJob(
    gameId: GameId,
    target: SyncTarget,
    reference = new Date()
  ): { job: AiScheduleJob; agentId: string | null } | null {
    return this.runTransaction(() => {
      const active = this.getActiveAiScheduleJob(gameId, target)
      if (!active) return null
      const now = reference.toISOString()
      const result = this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET status = 'failed', completed_at = ?, message = '用户已取消',
            progress_phase = 'failed', progress_current = NULL,
            progress_total = NULL, progress_updated_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'claimed')
      `).run(now, now, now, active.id)
      if (result.changes === 0) return null
      this.recordSyncOutcome(gameId, 'stale', '用户已取消', false, reference)
      this.recordSyncTargetAttempt(gameId, target, 'stale', reference)
      return {
        job: this.getAiScheduleJob(active.id),
        agentId: active.agentId
      }
    })
  }

  cancelAllActiveAiScheduleJobs(
    reference = new Date()
  ): { cancelled: number; agentIds: string[] } {
    const rows = this.database.prepare(`
      SELECT DISTINCT agent_id AS agentId
      FROM ai_schedule_jobs
      WHERE status = 'claimed' AND agent_id IS NOT NULL
    `).all() as Array<{ agentId: string }>
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'failed', completed_at = ?, message = '应用已退出，任务已取消',
          progress_phase = 'failed', progress_current = NULL,
          progress_total = NULL, progress_updated_at = ?, updated_at = ?
      WHERE status IN ('pending', 'claimed')
    `).run(now, now, now)
    return {
      cancelled: Number(result.changes),
      agentIds: rows.map((row) => row.agentId)
    }
  }

  listActiveAiScheduleJobs(gameId?: GameId): AiScheduleJob[] {
    const gameFilter = gameId ? ' AND game_id = ?' : ''
    const rows = this.database.prepare(`
      SELECT id FROM ai_schedule_jobs
      WHERE status IN ('pending', 'claimed')
        ${gameFilter}
      ORDER BY requested_at ASC
    `).all(...(gameId ? [gameId] : [])) as Array<{ id: string }>
    return rows.map((row) => this.getAiScheduleJob(row.id))
  }

  updatePendingAiScheduleJobsMessage(
    message: string,
    current: number | null = null,
    total: number | null = null,
    reference = new Date()
  ): number {
    if (!message.trim()) throw new Error('同步进度说明不能为空')
    if (current !== null && (!Number.isInteger(current) || current < 0)) {
      throw new Error('同步进度当前值格式不正确')
    }
    if (total !== null && (!Number.isInteger(total) || total < 1)) {
      throw new Error('同步进度总数格式不正确')
    }
    if (current !== null && total !== null && current > total) {
      throw new Error('同步进度当前值不能超过总数')
    }
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET progress_phase = 'queued', progress_current = ?, progress_total = ?,
          progress_updated_at = ?, message = ?, updated_at = ?
      WHERE status = 'pending'
    `).run(current, total, now, message.trim(), now)
    return Number(result.changes)
  }

  failPendingAiScheduleJobs(message: string, reference = new Date()): number {
    if (!message.trim()) throw new Error('同步失败说明不能为空')
    const now = reference.toISOString()
    const jobs = this.database.prepare(`
      SELECT id, game_id AS gameId, target FROM ai_schedule_jobs WHERE status = 'pending'
    `).all() as Array<{ id: string; gameId: GameId; target: SyncTarget }>
    if (jobs.length === 0) return 0
    const fail = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'failed', completed_at = ?, message = ?,
          progress_phase = 'failed', progress_current = NULL,
          progress_total = NULL, progress_updated_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `)
    this.runTransaction(() => {
      for (const job of jobs) {
        const result = fail.run(now, message.trim(), now, now, job.id)
        if (result.changes > 0) {
          this.recordSyncOutcome(job.gameId, 'error', message.trim(), false, reference)
          this.recordSyncTargetAttempt(job.gameId, job.target, 'error', reference)
        }
      }
    })
    return jobs.length
  }

  failClaimedAiScheduleJobsByAgent(
    agentId: string,
    message: string,
    reference = new Date()
  ): number {
    if (!message.trim()) throw new Error('同步失败说明不能为空')
    const jobs = this.database.prepare(`
      SELECT id FROM ai_schedule_jobs WHERE status = 'claimed' AND agent_id = ?
    `).all(agentId) as Array<{ id: string }>
    for (const job of jobs) this.failAiScheduleJob(job.id, agentId, message.trim(), reference)
    return jobs.length
  }

  requeueClaimedAiScheduleJobsByAgent(
    agentId: string,
    reference = new Date(),
    message = '应用已关闭，任务将在下次启动后继续'
  ): number {
    if (!message.trim()) throw new Error('重新排队说明不能为空')
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'pending', agent_id = NULL, claimed_at = NULL,
          progress_phase = 'queued', progress_current = NULL, progress_total = NULL,
          progress_updated_at = ?, message = ?,
          updated_at = ?
      WHERE status = 'claimed' AND agent_id = ?
    `).run(now, message.trim(), now, agentId)
    return Number(result.changes)
  }

  expireUnclaimedAiScheduleJobs(reference = new Date()): number {
    void reference
    // 排队不是失败。任务只会在用户取消、明确启动失败或成功提交后离开队列。
    return 0
  }

  maintainAiScheduleJobs(reference = new Date()): { requeued: number; expired: number } {
    this.dismissExpiredSemanticReviewCandidates(reference)
    const requeued = this.requeueStaleAiScheduleJobs(reference)
    const expired = this.expireUnclaimedAiScheduleJobs(reference)
    return { requeued, expired }
  }

  updateAiScheduleJobProgress(
    jobId: string,
    agentId: string,
    phase: SyncProgressPhase,
    message: string,
    current: number | null,
    total: number | null,
    reference = new Date()
  ): AiScheduleJob {
    if (!message.trim()) throw new Error('同步进度说明不能为空')
    if (['queued', 'completed', 'failed'].includes(phase)) {
      throw new Error('该同步阶段只能由任务领取、提交或失败操作设置')
    }
    if (current !== null && (!Number.isInteger(current) || current < 0)) {
      throw new Error('同步进度当前值格式不正确')
    }
    if (total !== null && (!Number.isInteger(total) || total < 1)) {
      throw new Error('同步进度总数格式不正确')
    }
    if (current !== null && total !== null && current > total) {
      throw new Error('同步进度当前值不能超过总数')
    }
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET progress_phase = ?, progress_current = ?, progress_total = ?,
          progress_updated_at = ?, message = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND agent_id = ?
    `).run(phase, current, total, now, message.trim(), now, jobId, agentId)
    if (result.changes === 0) throw new Error('AI 资料任务未由当前 Agent 领取或已经结束')
    this.database.prepare(`
      UPDATE ai_schedule_agents SET last_seen_at = ?, updated_at = ? WHERE id = ?
    `).run(now, now, agentId)
    return this.getAiScheduleJob(jobId)
  }

  applyAiScheduleJob(
    jobId: string,
    agentId: string,
    items: CodexScheduleItem[],
    evidence: unknown,
    reference = new Date(),
    activityTagUpdates: ActivityTagUpdate[] = [],
    verifiedEmptyTargets: Exclude<SyncTarget, 'all'>[] = [],
    archiveItems: CodexArchiveDecision[] = [],
    contentLocale?: string
  ): {
    job: AiScheduleJob
    merge: SyncMergeResult
    archived: number
    remainingTargets: Exclude<SyncTarget, 'all'>[]
  } {
    const job = this.getAiScheduleJob(jobId)
    if (contentLocale && contentLocale !== job.requestContext.outputLocale) {
      throw new Error('提交内容语言与接口请求语言不一致')
    }
    if (job.status !== 'claimed' || job.agentId !== agentId) {
      throw new Error('AI 资料任务未由当前 Agent 领取或已经结束')
    }
    const targetCategories: Partial<Record<SyncTarget, ChecklistCategory[]>> = {
      events: ['limited_event'],
      cycles: ['weekly', 'endgame'],
      exploration: ['exploration'],
      tasks: ['main_quest', 'side_quest']
    }
    const allowedCategories = targetCategories[job.target]
    if (allowedCategories) {
      const invalid = items.find((item) => !allowedCategories.includes(item.category))
      if (invalid) throw new Error(`当前任务只允许回写“${job.target}”版块数据`)
    }
    items = items.map(({ matchItemId, ...item }) => {
      if (!matchItemId) return item
      const matched = this.listChecklistItems(job.gameId).find(
        (checklistItem) => checklistItem.id === matchItemId
      )
      if (!matched || matched.source === 'manual') {
        throw new Error('Codex 指定的公开资料匹配项不存在或不允许由同步覆盖')
      }
      if (!matched.remoteKey) throw new Error('Codex 指定的公开资料匹配项缺少稳定远端标识')
      return {
        ...item,
        remoteKey: matched.remoteKey
      }
    })
    const matchCandidatesById = new Map(job.matchCandidates.map((item) => [item.itemId, item]))
    const archiveIds = new Set<string>()
    for (const decision of archiveItems) {
      if (!decision.reason.trim()) throw new Error('Codex 删除决定必须包含原因')
      if (archiveIds.has(decision.itemId)) throw new Error('Codex 删除决定包含重复事项')
      const candidate = matchCandidatesById.get(decision.itemId)
      if (!candidate) throw new Error('Codex 只能删除当前同步版块内提供的同步事项')
      if (
        candidate.source === 'manual' ||
        candidate.category === 'main_quest' ||
        candidate.category === 'side_quest' ||
        candidate.category === 'weekly'
      ) {
        throw new Error('手动事项及固定任务不能由同步流程删除')
      }
      archiveIds.add(decision.itemId)
    }
    const uniqueVerifiedEmptyTargets = [...new Set(verifiedEmptyTargets)]
    if (uniqueVerifiedEmptyTargets.some((target) => target !== 'events')) {
      throw new Error('只有确认当前没有限时活动时才允许提交空版块')
    }
    if (
      uniqueVerifiedEmptyTargets.length > 0 &&
      job.target !== 'all' &&
      !uniqueVerifiedEmptyTargets.includes(job.target as Exclude<SyncTarget, 'all'>)
    ) {
      throw new Error('空版块确认与当前同步目标不一致')
    }
    const versionItems = items.filter(
      (item) => item.category === 'main_quest' || item.category === 'side_quest'
    )
    if (job.target === 'tasks' || versionItems.length > 0) {
      this.validateVersionScheduleItems(versionItems, reference)
    }
    const invalidEventWindow = items.find((item) =>
      item.category === 'limited_event' &&
      (
        !item.startsAt ||
        !item.endsAt ||
        !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(item.startsAt) ||
        !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(item.endsAt)
      )
    )
    if (invalidEventWindow) {
      throw new Error(`限时活动“${invalidEventWindow.title}”缺少带时区的完整起止时间`)
    }
    const invalidEventTags = items.find((item) =>
      item.category === 'limited_event' &&
      (
        !Array.isArray(item.activityTags) ||
        item.activityTags.length === 0 ||
        item.activityTags.length > 5 ||
        item.activityTags.some((tag) => !tag.trim() || tag.length > 20 || tag === '待识别')
      )
    )
    if (invalidEventTags) {
      throw new Error(`活动“${invalidEventTags.title}”必须提供 1 到 5 个有效玩法标签`)
    }
    const invalidEndgame = items.find((item) =>
      item.category === 'endgame' &&
      (!item.modeKey || !item.periodKey || !item.startsAt || !item.endsAt)
    )
    if (invalidEndgame) {
      throw new Error(`周期挑战“${invalidEndgame.title}”缺少 modeKey、periodKey 或完整起止时间`)
    }
    const invalidExploration = items.find((item) =>
      item.category === 'exploration' && !item.mapNodeKind
    )
    if (invalidExploration) {
      throw new Error(`地图节点“${invalidExploration.title}”缺少 mapNodeKind`)
    }
    const unsupportedExploration = items.find((item) =>
      item.category === 'exploration' &&
      item.mapNodeKind !== 'region' &&
      item.mapNodeKind !== 'subregion'
    )
    if (unsupportedExploration) {
      throw new Error(`地图“${unsupportedExploration.title}”不是一级主地区或二级地区`)
    }
    const requiredTagTargets = job.activityTagTargets
    if (requiredTagTargets.length > 0 || activityTagUpdates.length > 0) {
      if (job.target !== 'events' && job.target !== 'all') {
        throw new Error('当前任务不允许回写活动玩法标签')
      }
      const requiredById = new Map(requiredTagTargets.map((target) => [target.itemId, target]))
      const submittedIds = new Set<string>()
      for (const update of activityTagUpdates) {
        const target = requiredById.get(update.itemId)
        if (!target) throw new Error(`活动标签回写目标“${update.title}”不在本次待补全清单中`)
        if (submittedIds.has(update.itemId)) throw new Error(`活动“${update.title}”重复提交标签`)
        submittedIds.add(update.itemId)
        if (update.title !== target.title) throw new Error(`活动标签回写目标“${update.title}”已经变化`)
        if (!Array.isArray(update.activityTags) || update.activityTags.length === 0 ||
          update.activityTags.length > 5) {
          throw new Error(`活动“${update.title}”必须提供 1 到 5 个玩法标签`)
        }
        const tags = [...new Set(update.activityTags.map((tag) => tag.trim()).filter(Boolean))]
        if (tags.length !== update.activityTags.length || tags.some((tag) => tag.length > 20)) {
          throw new Error(`活动“${update.title}”的玩法标签格式不正确`)
        }
        if (!Number.isFinite(update.confidence) || update.confidence < 0 || update.confidence > 1) {
          throw new Error(`活动“${update.title}”的标签置信度格式不正确`)
        }
        try {
          const url = new URL(update.sourceUrl)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
        } catch {
          throw new Error(`活动“${update.title}”缺少有效的标签核验来源`)
        }
      }
      const missingTargets = requiredTagTargets.filter((target) => !submittedIds.has(target.itemId))
      if (missingTargets.length > 0) {
        throw new Error(
          `活动标签补全遗漏 ${missingTargets.length} 项：${missingTargets
            .slice(0, 6)
            .map((target) => target.title)
            .join('、')}${missingTargets.length > 6 ? '等' : ''}`
        )
      }
    }
    const includesCycles = job.target === 'cycles' || items.some(
      (item) => item.category === 'weekly' || item.category === 'endgame'
    )
    const mergedItems = includesCycles && !items.some((item) => item.category === 'weekly')
      ? [...items, {
          remoteKey: `weekly:${job.gameId}`,
          category: 'weekly' as const,
          title: '周常'
      }]
      : items
    const coveredTargets: Exclude<SyncTarget, 'all'>[] = job.target === 'all'
      ? [
          ...(versionItems.length > 0 ? ['tasks' as const] : []),
          ...(items.some((item) =>
            item.category === 'limited_event'
          ) ||
            activityTagUpdates.length > 0 ||
            uniqueVerifiedEmptyTargets.includes('events')
            ? ['events' as const]
            : []),
          ...(includesCycles ? ['cycles' as const] : []),
          ...(items.some((item) => item.category === 'exploration') ? ['exploration' as const] : [])
        ]
      : [job.target]
    const allSectionTargets = ['tasks', 'events', 'cycles', 'exploration'] as const
    const missingTargets = job.target === 'all'
      ? allSectionTargets.filter((target) => !coveredTargets.includes(target))
      : []
    const requiresFullCoverage = job.target === 'all'
    const previouslyCoveredTargets = requiresFullCoverage
      ? this.getSyncTargetStates(job.gameId)
          .filter((state) =>
            state.target !== 'all' &&
            state.lastSuccessAt !== null &&
            Date.parse(state.lastSuccessAt) >= Date.parse(job.requestedAt)
          )
          .map((state) => state.target as Exclude<SyncTarget, 'all'>)
      : []
    const coveredAcrossJob = new Set([...previouslyCoveredTargets, ...coveredTargets])
    const effectiveMissingTargets = requiresFullCoverage
      ? allSectionTargets.filter((target) => !coveredAcrossJob.has(target))
      : missingTargets
    const now = reference.toISOString()
    const { merge, archived } = this.runTransaction(() => {
      const result = this.mergeSyncedItems(
        job.gameId,
        'public_schedule',
        mergedItems,
        now,
        false,
        {
          codexReviewed: true,
          identityPolicy: 'remote-key-only',
          outputLocale: job.requestContext.outputLocale
        }
      )
      const updateTags = this.database.prepare(`
        UPDATE checklist_items
        SET activity_tags_json = ?,
            source_url = COALESCE(source_url, ?),
            last_synced_at = ?,
            updated_at = ?
        WHERE id = ? AND game_id = ?
          AND category = 'limited_event'
          AND archived = 0
      `)
      for (const update of activityTagUpdates) {
        const result = updateTags.run(
          JSON.stringify(normalizeActivityTags(
            update.activityTags,
            job.requestContext.outputLocale
          )),
          update.sourceUrl,
          now,
          now,
          update.itemId,
          job.gameId
        )
        if (result.changes !== 1) throw new Error(`活动“${update.title}”已不存在，无法补全标签`)
      }
      const archiveSyncedItem = this.database.prepare(`
        UPDATE checklist_items
        SET archived = 1, updated_at = ?
        WHERE id = ? AND game_id = ? AND archived = 0 AND source <> 'manual'
      `)
      let archived = 0
      for (const decision of archiveItems) {
        const result = archiveSyncedItem.run(now, decision.itemId, job.gameId)
        if (result.changes !== 1) throw new Error('待删除的同步事项已不存在或不允许删除')
        archived += 1
      }
      this.assertActiveMapReferences(job.gameId)
      return { merge: result, archived }
    })
    const unresolvedActivityCount = (job.target === 'events' || job.target === 'all')
      ? this.listActivityTagEnrichmentTargets(job.gameId, now).length
      : 0
    const targetNames: Record<Exclude<SyncTarget, 'all'>, string> = {
      tasks: '任务',
      events: '活动',
      cycles: '周期事项',
      exploration: '地图探索'
    }
    const tagMessage = activityTagUpdates.length > 0 ? `，补全标签 ${activityTagUpdates.length}` : ''
    const unresolvedMessage = unresolvedActivityCount > 0
      ? `；仍有 ${unresolvedActivityCount} 项活动经本轮核验后暂为未知`
      : ''
    const archiveMessage = archived > 0 ? `，移入回收站 ${archived}` : ''
    const mergeMessage = `新增 ${merge.added}，更新 ${merge.updated}${tagMessage}${archiveMessage}，保护 ${merge.preserved}`
    const message = effectiveMissingTargets.length > 0
      ? `AI 资料部分同步完成：${mergeMessage}；仍需补齐${effectiveMissingTargets.map(
          (target) => targetNames[target]
        ).join('、')}${unresolvedMessage}`
      : `AI 资料同步完成：${mergeMessage}${unresolvedMessage}`
    if (requiresFullCoverage && effectiveMissingTargets.length > 0) {
      for (const coveredTarget of coveredTargets) {
        this.recordCatalogCoverage(job.gameId, coveredTarget, 'public_schedule', 'complete')
        if (coveredTarget === 'events' && unresolvedActivityCount > 0) {
          this.recordSyncTargetAttempt(job.gameId, coveredTarget, 'stale', reference)
        } else {
          this.recordSyncTargetSuccess(job.gameId, coveredTarget, reference)
        }
      }
      this.recordCatalogCoverage(job.gameId, 'all', 'public_schedule', 'partial')
      this.recordSyncTargetAttempt(job.gameId, 'all', 'stale', reference)
      const retryMessage = `已安全保存当前结果；继续检索${effectiveMissingTargets.map(
        (target) => targetNames[target]
      ).join('、')}`
      this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET evidence_json = ?, message = ?, progress_phase = 'retrying',
            progress_current = 0, progress_total = ?,
            progress_updated_at = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed' AND agent_id = ?
      `).run(
        JSON.stringify(evidence),
        retryMessage,
        effectiveMissingTargets.length,
        now,
        now,
        jobId,
        agentId
      )
      this.recordSyncOutcome(job.gameId, 'stale', retryMessage, false)
      return {
        job: this.getAiScheduleJob(jobId),
        merge,
        archived,
        remainingTargets: effectiveMissingTargets
      }
    }
    this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'completed', completed_at = ?, evidence_json = ?, message = ?,
          progress_phase = 'completed',
          progress_current = COALESCE(progress_total, progress_current),
          progress_updated_at = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND agent_id = ?
    `).run(now, JSON.stringify(evidence), message, now, now, jobId, agentId)
    const current = this.getSyncSettings(job.gameId)
    const personalIssue = job.scope === 'public_and_personal' &&
      ['error', 'stale', 'verification_required'].includes(current.status)
    const partialPublicResult = job.target === 'all' && effectiveMissingTargets.length > 0
    const partialActivityTags = unresolvedActivityCount > 0
    const finalStatus = personalIssue
      ? current.status === 'verification_required'
        ? 'verification_required'
        : 'stale'
      : partialPublicResult || partialActivityTags
        ? 'stale'
        : 'success'
    const finalMessage = personalIssue && current.message
      ? `${message}；${current.message}`
      : message
    this.recordSyncOutcome(
      job.gameId,
      finalStatus,
      finalMessage,
      !partialPublicResult && !partialActivityTags
    )
    if (job.target === 'all') {
      for (const coveredTarget of coveredTargets) {
        this.recordCatalogCoverage(job.gameId, coveredTarget, 'public_schedule', 'complete')
        if (coveredTarget === 'events' && partialActivityTags) {
          this.recordSyncTargetAttempt(job.gameId, coveredTarget, 'stale', reference)
        } else {
          this.recordSyncTargetSuccess(job.gameId, coveredTarget, reference)
        }
      }
      if (!partialPublicResult && !partialActivityTags) {
        this.recordCatalogCoverage(job.gameId, 'all', 'public_schedule', 'complete')
        this.recordSyncTargetSuccess(job.gameId, 'all', reference, true)
      } else {
        this.recordCatalogCoverage(job.gameId, 'all', 'public_schedule', 'partial')
        this.recordSyncTargetAttempt(job.gameId, 'all', 'stale', reference)
      }
    } else if (job.target === 'events' && partialActivityTags) {
      this.recordCatalogCoverage(job.gameId, job.target, 'public_schedule', 'complete')
      this.recordSyncTargetAttempt(job.gameId, job.target, 'stale', reference)
    } else {
      this.recordCatalogCoverage(job.gameId, job.target, 'public_schedule', 'complete')
      this.recordSyncTargetSuccess(job.gameId, job.target, reference)
    }
    return {
      job: this.getAiScheduleJob(jobId),
      merge,
      archived,
      remainingTargets: effectiveMissingTargets
    }
  }

  failAiScheduleJob(jobId: string, agentId: string, message: string, reference = new Date()): AiScheduleJob {
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'failed', completed_at = ?, message = ?,
          progress_phase = 'failed', progress_updated_at = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND agent_id = ?
    `).run(now, message, now, now, jobId, agentId)
    if (result.changes === 0) throw new Error('AI 资料任务未由当前 Agent 领取或已经结束')
    const job = this.getAiScheduleJob(jobId)
    this.recordSyncOutcome(job.gameId, 'error', message, false)
    this.recordSyncTargetAttempt(job.gameId, job.target, 'error', reference)
    return job
  }

  private getAiScheduleJob(id: string): AiScheduleJob {
    const row = this.database.prepare(`
      SELECT j.id, j.game_id AS gameId, j.scope, j.target,
        j.user_timezone AS userTimeZone, j.output_locale AS outputLocale, j.status,
        j.requested_at AS requestedAt, j.claimed_at AS claimedAt,
        j.completed_at AS completedAt, j.agent_id AS agentId,
        a.name AS agentName, j.message,
        j.progress_phase AS progressPhase,
        j.progress_current AS progressCurrent,
        j.progress_total AS progressTotal,
        j.progress_updated_at AS progressUpdatedAt
      FROM ai_schedule_jobs j
      LEFT JOIN ai_schedule_agents a ON a.id = j.agent_id
      WHERE j.id = ?
    `).get(id) as Omit<
      AiScheduleJob,
      'activityTagTargets' | 'matchCandidates' | 'contract' | 'requestContext'
    > | undefined
    if (!row) throw new Error('AI 资料任务不存在')
    const activityTagTargets = (
      row.status === 'pending' || row.status === 'claimed'
    ) && (row.target === 'events' || row.target === 'all')
      ? this.listActivityTagEnrichmentTargets(row.gameId, row.requestedAt)
      : []
    const targetCategories: Record<SyncTarget, ChecklistCategory[]> = {
      tasks: ['main_quest', 'side_quest'],
      events: ['limited_event'],
      cycles: ['weekly', 'endgame'],
      exploration: ['exploration'],
      all: [
        'main_quest',
        'side_quest',
        'limited_event',
        'weekly',
        'endgame',
        'exploration'
      ]
    }
    const matchCandidates = this.listChecklistItems(row.gameId)
      .filter((item) =>
        item.source !== 'manual' &&
        targetCategories[row.target].includes(item.category)
      )
      .map((item) => ({
        itemId: item.id,
        category: item.category,
        title: item.title,
        source: item.source,
        remoteKey: item.remoteKey,
        modeKey: item.modeKey,
        periodKey: item.periodKey,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        parentTitle: item.parentTitle,
        mapNodeKind: item.mapNodeKind,
        parentRemoteKey: item.parentRemoteKey,
        completed: item.completed,
        progressPercent: item.progressPercent
      }))
    return {
      ...row,
      requestContext: {
        outputLocale: row.outputLocale,
        userTimeZone: row.userTimeZone
      },
      activityTagTargets,
      matchCandidates,
      contract: getPublicSyncContract(row.target, {
        outputLocale: row.outputLocale,
        userTimeZone: row.userTimeZone
      })
    }
  }

  private listActivityTagEnrichmentTargets(
    gameId: GameId,
    reference: string
  ): ActivityTagEnrichmentTarget[] {
    const rows = this.database.prepare(`
      SELECT id AS itemId, title, activity_tags_json AS activityTagsJson,
        source, remote_key AS remoteKey, source_url AS sourceUrl,
        starts_at AS startsAt, ends_at AS endsAt
      FROM checklist_items
      WHERE game_id = ?
        AND category = 'limited_event'
        AND archived = 0
        AND (ends_at IS NULL OR julianday(ends_at) > julianday(?))
      ORDER BY COALESCE(starts_at, created_at), created_at
    `).all(gameId, reference) as Array<
      Omit<ActivityTagEnrichmentTarget, 'currentTags'> & { activityTagsJson: string }
    >
    return rows.flatMap(({ activityTagsJson, ...row }) => {
      let tags: string[] = []
      try {
        const parsed = JSON.parse(activityTagsJson)
        if (Array.isArray(parsed)) {
          tags = parsed.filter((tag): tag is string => typeof tag === 'string')
        }
      } catch {
        // Invalid legacy values are deliberately treated as requiring review.
      }
      return activityTagsNeedReview(tags) ? [{ ...row, currentTags: tags }] : []
    })
  }

  private requeueStaleAiScheduleJobs(reference: Date): number {
    const threshold = new Date(reference.getTime() - AI_JOB_CLAIM_MAX_AGE_MS).toISOString()
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'pending', agent_id = NULL, claimed_at = NULL,
          progress_phase = 'queued', progress_current = NULL, progress_total = NULL,
          progress_updated_at = ?, message = 'Codex 超时，任务已重新排队', updated_at = ?
      WHERE status = 'claimed'
        AND COALESCE(progress_updated_at, claimed_at) < ?
    `).run(now, now, threshold)
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
          activity_tags_json AS activityTagsJson,
          completed,
          progress_percent AS progressPercent,
          parent_title AS parentTitle,
          map_node_kind AS mapNodeKind,
          parent_remote_key AS parentRemoteKey,
          related_region_remote_key AS relatedRegionRemoteKey,
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
            WHEN completed = 1 THEN 5
            WHEN starts_at IS NOT NULL
              AND julianday(starts_at) > julianday('now')
            THEN 3
            WHEN ends_at IS NOT NULL
              AND julianday(ends_at) <= julianday('now')
            THEN 4
            WHEN ends_at IS NOT NULL
              AND julianday(ends_at) <= julianday('now', '+1 day')
            THEN 0
            ELSE 1
          END,
          CASE category
            WHEN 'main_quest' THEN 10
            WHEN 'side_quest' THEN 20
            WHEN 'limited_event' THEN 30
            WHEN 'weekly' THEN 50
            WHEN 'endgame' THEN 60
            WHEN 'exploration' THEN 70
            ELSE 80
          END,
          CASE
            WHEN starts_at IS NOT NULL AND julianday(starts_at) > julianday('now')
            THEN starts_at
          END ASC,
          CASE
            WHEN starts_at IS NULL OR julianday(starts_at) <= julianday('now')
            THEN ends_at
          END ASC,
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
          activity_tags_json AS activityTagsJson,
          completed,
          progress_percent AS progressPercent,
          parent_title AS parentTitle,
          map_node_kind AS mapNodeKind,
          parent_remote_key AS parentRemoteKey,
          related_region_remote_key AS relatedRegionRemoteKey,
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
          id, game_id, category, title, activity_tags_json, progress_percent, parent_title,
          map_node_kind, parent_remote_key, related_region_remote_key, starts_at, ends_at,
          reset_rule, period_key, schedule_kind, reset_weekday, timezone, mode_key,
          recurrence_rule, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
      `)
      .run(
        id,
        input.gameId,
        input.category,
        input.title,
        JSON.stringify(
          input.category === 'limited_event'
            ? normalizeActivityTags(input.activityTags ?? [])
            : []
        ),
        input.progressPercent ?? null,
        input.parentTitle ?? null,
        input.mapNodeKind ?? (input.category === 'exploration' ? 'region' : null),
        input.parentRemoteKey ?? null,
        null,
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
    const activityTags = normalizeActivityTags(category === 'limited_event'
      ? input.activityTags === undefined
        ? categoryChanged ? [] : current.activityTags
        : input.activityTags
      : [])
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
          activity_tags_json = ?,
          completed = ?,
          progress_percent = ?,
          parent_title = ?,
          map_node_kind = ?,
          parent_remote_key = ?,
          related_region_remote_key = ?,
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
        JSON.stringify(activityTags),
        completed ? 1 : 0,
        input.progressPercent === undefined ? current.progressPercent : input.progressPercent,
        input.parentTitle === undefined ? current.parentTitle : input.parentTitle,
        input.mapNodeKind === undefined
          ? (categoryChanged ? (category === 'exploration' ? 'region' : null) : current.mapNodeKind)
          : input.mapNodeKind,
        input.parentRemoteKey === undefined
          ? (categoryChanged ? null : current.parentRemoteKey)
          : input.parentRemoteKey,
        null,
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

  emptyRecycleBin(gameId: GameId): number {
    return this.runTransaction(() => {
      const archived = this.database.prepare(`
        SELECT id, category, remote_key AS remoteKey, source
        FROM checklist_items
        WHERE game_id = ? AND archived = 1
      `).all(gameId) as Array<{
        id: string
        category: ChecklistCategory
        remoteKey: string | null
        source: ChecklistSource
      }>
      if (archived.length === 0) return 0
      const insertTombstone = this.database.prepare(`
        INSERT INTO sync_deletion_tombstones(
          game_id, identity_key, category, deleted_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(game_id, identity_key) DO UPDATE SET
          category = excluded.category,
          deleted_at = excluded.deleted_at
      `)
      const bindings = this.database.prepare(`
        SELECT provider, endpoint, external_id AS externalId
        FROM source_bindings
        WHERE game_id = ? AND item_id = ?
      `)
      const now = new Date().toISOString()
      for (const item of archived) {
        if (item.source === 'manual') continue
        if (item.remoteKey) {
          insertTombstone.run(
            gameId,
            this.catalogDeletionKey(item.remoteKey),
            item.category,
            now
          )
        }
        const itemBindings = bindings.all(gameId, item.id) as Array<{
          provider: string
          endpoint: string
          externalId: string
        }>
        for (const binding of itemBindings) {
          insertTombstone.run(
            gameId,
            this.sourceBindingDeletionKey(
              binding.provider,
              binding.endpoint,
              binding.externalId
            ),
            item.category,
            now
          )
        }
      }
      this.database.prepare(`
        DELETE FROM checklist_items
        WHERE game_id = ? AND archived = 1
      `).run(gameId)
      return archived.length
    })
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
    syncedAt = new Date().toISOString(),
    manageTransaction = true,
    options: SyncMergeOptions = {}
  ): SyncMergeResult {
    const result: SyncMergeResult = { added: 0, updated: 0, preserved: 0 }
    for (const item of items) {
      if (item.category === 'limited_event') {
        item.activityTags = normalizeActivityTags(
          item.activityTags ?? [],
          options.outputLocale ?? 'zh-CN'
        )
      }
    }
    const seenRemoteKeys = new Set<string>()
    this.assertMapStructure(gameId, items)
    const versionItems = items.filter(
      (item) => item.category === 'main_quest' || item.category === 'side_quest'
    )
    if (versionItems.length > 0) {
      if (source !== 'public_schedule') {
        throw new Error('主线和支线的版本时间只能由公开资料校时')
      }
      this.validateVersionScheduleItems(versionItems, new Date(syncedAt))
    }

    if (manageTransaction) this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const item of items) {
        if (item.category === 'main_quest' || item.category === 'side_quest') {
          if (source !== 'public_schedule') {
            throw new Error('主线和支线的版本时间只能由公开资料校时')
          }
          this.mergeVersionScheduleItem(gameId, item, syncedAt)
          result.updated += 1
          continue
        }
        if (item.category === 'weekly') {
          item.remoteKey = `weekly:${gameId}`
          item.title = '周常'
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
        const startsInFuture =
          item.category === 'limited_event' &&
          Boolean(item.startsAt) &&
          Date.parse(item.startsAt!) > Date.parse(syncedAt)
        if (seenRemoteKeys.has(remoteKey)) throw new Error(`同步数据包含重复标识：${remoteKey}`)
        seenRemoteKeys.add(remoteKey)

        if (this.hasSyncDeletionTombstone(gameId, this.catalogDeletionKey(remoteKey))) {
          result.preserved += 1
          continue
        }

        const identity = this.findSyncIdentity(
          gameId,
          source,
          item,
          remoteKey,
          syncedAt,
          options.identityPolicy ?? 'heuristic'
        )

        const isUntimedPersonalEvent =
          source === 'personal_sync' &&
          item.category === 'limited_event' &&
          (!item.startsAt || !item.endsAt)
        if (
          isUntimedPersonalEvent &&
          !options.codexReviewed &&
          identity?.source !== 'public_schedule'
        ) {
          result.preserved += 1
          continue
        }

        if (identity?.archived) {
          result.preserved += 1
          continue
        }

        if (!identity) {
          const id = item.category === 'weekly' ? `${gameId}:weekly` : randomUUID()
          const inferredCompletion = item.category === 'exploration' && item.progressPercent !== undefined
            ? item.progressPercent === 100
            : item.completed
          const safeCompletion = startsInFuture ? false : inferredCompletion
          const remoteCompleted = source === 'personal_sync' && safeCompletion === true
          this.database
            .prepare(`
              INSERT INTO checklist_items(
                id, game_id, category, title, activity_tags_json, completed, progress_percent, parent_title,
                map_node_kind, parent_remote_key, related_region_remote_key,
                starts_at, ends_at, reset_rule, period_key, schedule_kind,
                reset_weekday, timezone, mode_key, recurrence_rule, source, remote_key,
                source_url, completed_at, last_synced_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              id,
              gameId,
              item.category,
              item.title,
              JSON.stringify(
                item.category === 'limited_event'
            ? normalizeActivityTags(
                item.activityTags ?? [],
                options.outputLocale ?? 'zh-CN'
              )
                  : []
              ),
              remoteCompleted ? 1 : 0,
              item.category === 'exploration'
                ? source === 'personal_sync'
                  ? item.progressPercent ?? null
                  : 0
                : null,
              item.parentTitle ?? null,
              item.mapNodeKind ?? (item.category === 'exploration' ? 'region' : null),
              item.parentRemoteKey ?? null,
              null,
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
          source === 'personal_sync' &&
          current.source === 'public_schedule' &&
          !options.codexReviewed
        const resolvedCategory = preservePublicSchedule ? current.category : item.category
        const resolvedSource =
          source === 'public_schedule' || current.source === 'public_schedule'
            ? 'public_schedule'
            : 'personal_sync'
        const resolvedActivityTags = resolvedCategory === 'limited_event'
          ? preservePublicSchedule || item.activityTags === undefined
            ? current.activityTags
            : normalizeActivityTags(
                item.activityTags,
                options.outputLocale ?? 'zh-CN'
              )
          : []
        const currentCompleted = current.completed
        const currentCompletedAt = current.completedAt
        const manualCompletionLocked = current.manualCompletionLocked
        const inferredCompletion = item.category === 'exploration' && item.progressPercent !== undefined
          ? item.progressPercent === 100
          : item.completed
        const safeCompletion = startsInFuture ? false : inferredCompletion
        const acceptsRemoteCompletion = source === 'personal_sync' && safeCompletion !== undefined
        const completionProtected =
          acceptsRemoteCompletion && safeCompletion === false && manualCompletionLocked
        const completed = completionProtected
          ? currentCompleted
          : acceptsRemoteCompletion
            ? safeCompletion!
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
              activity_tags_json = ?,
              completed = ?,
              progress_percent = ?,
              parent_title = ?,
              map_node_kind = ?,
              parent_remote_key = ?,
              related_region_remote_key = ?,
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
            resolvedCategory,
            preservePublicSchedule ? current.title : item.title,
            JSON.stringify(resolvedActivityTags),
            completed ? 1 : 0,
            resolvedCategory === 'exploration'
              ? source === 'public_schedule' || item.progressPercent === undefined
                ? current.progressPercent
                : item.progressPercent
              : null,
            item.parentTitle === undefined ? current.parentTitle : item.parentTitle,
            item.mapNodeKind === undefined ? current.mapNodeKind : item.mapNodeKind,
            item.parentRemoteKey === undefined ? current.parentRemoteKey : item.parentRemoteKey,
            null,
            startsAt,
            endsAt,
            preservePublicSchedule || item.resetRule === undefined ? current.resetRule : item.resetRule,
            preservePublicSchedule || item.periodKey === undefined
              ? current.periodKey
              : item.periodKey,
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
        if (
          item.category === 'limited_event' &&
          source === 'personal_sync' &&
          current.source === 'public_schedule'
        ) {
          this.archiveEquivalentPersonalEventDuplicates(
            gameId,
            current.id,
            item,
            syncedAt
          )
        }
        if (item.category === 'exploration' && source === 'public_schedule') {
          this.absorbEquivalentPersonalMapDuplicates(
            gameId,
            current.id,
            item,
            syncedAt
          )
        }
        if (completionProtected) result.preserved += 1
      }
      if (manageTransaction) this.database.exec('COMMIT')
      return result
    } catch (error) {
      if (manageTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  private findSyncIdentity(
    gameId: GameId,
    source: Exclude<ChecklistSource, 'manual'>,
    item: NormalizedSyncItem,
    remoteKey: string,
    syncedAt: string,
    identityPolicy: 'heuristic' | 'remote-key-only'
  ): { id: string; archived: number; source: ChecklistSource } | undefined {
    if (identityPolicy === 'remote-key-only') {
      return this.database.prepare(`
        SELECT id, archived, source
        FROM checklist_items
        WHERE game_id = ?
          AND remote_key = ?
          AND source <> 'manual'
        ORDER BY CASE WHEN source = 'public_schedule' THEN 0 ELSE 1 END,
          updated_at DESC
        LIMIT 1
      `).get(gameId, remoteKey) as {
        id: string
        archived: number
        source: ChecklistSource
      } | undefined
    }

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
      const rows = this.database.prepare(`
        SELECT id, archived, source, remote_key AS remoteKey,
          mode_key AS modeKey, title
        FROM checklist_items
        WHERE game_id = ?
          AND category = 'limited_event'
          AND source <> 'manual'
          AND (
            remote_key = ?
            OR (? IS NOT NULL AND mode_key = ?)
            OR title = ?
            OR (
              starts_at IS NOT NULL AND ends_at IS NOT NULL
              AND ? IS NOT NULL AND ? IS NOT NULL
              AND julianday(starts_at) <= julianday(?)
              AND julianday(ends_at) >= julianday(?)
            )
          )
      `).all(
        gameId,
        remoteKey,
        item.modeKey ?? null,
        item.modeKey ?? null,
        item.title,
        item.startsAt ?? null,
        item.endsAt ?? null,
        item.endsAt ?? null,
        item.startsAt ?? null
      ) as Array<{
        id: string
        archived: number
        source: ChecklistSource
        remoteKey: string | null
        modeKey: string | null
        title: string
      }>
      return rows
        .filter((row) =>
          row.remoteKey === remoteKey ||
          (item.modeKey !== undefined && item.modeKey !== null && row.modeKey === item.modeKey) ||
          eventTitlesEquivalent(row.title, item.title)
        )
        .sort((left, right) => {
          const score = (row: typeof left): number => {
            if (
              source === 'personal_sync' &&
              row.source === 'public_schedule' &&
              eventTitlesEquivalent(row.title, item.title)
            ) return 0
            if (row.remoteKey === remoteKey) return 1
            if (item.modeKey && row.modeKey === item.modeKey) return 2
            if (row.title === item.title) return 3
            return 4
          }
          return score(left) - score(right)
        })[0]
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
            OR (? IS NOT NULL AND mode_key = ?
              AND starts_at IS NOT NULL AND ends_at IS NOT NULL
              AND ? IS NOT NULL AND ? IS NOT NULL
              AND julianday(starts_at) < julianday(?)
              AND julianday(ends_at) > julianday(?))
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
        item.startsAt ?? null,
        item.endsAt ?? null,
        item.endsAt ?? null,
        item.startsAt ?? null,
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
          AND (
            remote_key = ?
            OR (? IS NOT NULL AND mode_key = ?)
            OR title = ?
          )
        ORDER BY CASE WHEN ? IS NOT NULL AND period_key = ? THEN 0 ELSE 1 END,
          CASE WHEN starts_at IS NOT NULL AND ends_at IS NOT NULL
            AND julianday(starts_at) <= julianday(?)
            AND julianday(ends_at) >= julianday(?) THEN 0 ELSE 1 END,
          CASE WHEN source = 'public_schedule' THEN 0 ELSE 1 END,
          CASE WHEN title = ? THEN 0 ELSE 1 END,
          updated_at DESC
        LIMIT 1
      `).get(
        gameId,
        remoteKey,
        item.modeKey ?? null,
        item.modeKey ?? null,
        item.title,
        item.periodKey ?? null,
        item.periodKey ?? null,
        syncedAt,
        syncedAt,
        item.title
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

  private catalogDeletionKey(remoteKey: string): string {
    return `catalog:${remoteKey}`
  }

  private sourceBindingDeletionKey(
    provider: string,
    endpoint: string,
    externalId: string
  ): string {
    return `binding:${provider}:${endpoint}:${externalId}`
  }

  private hasSyncDeletionTombstone(gameId: GameId, identityKey: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM sync_deletion_tombstones
      WHERE game_id = ? AND identity_key = ?
    `).get(gameId, identityKey))
  }

  private isArchivedChecklistItem(itemId: string, gameId: GameId): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1
      FROM checklist_items
      WHERE id = ? AND game_id = ? AND archived = 1
    `).get(itemId, gameId))
  }

  private archiveEquivalentPersonalEventDuplicates(
    gameId: GameId,
    preservedId: string,
    item: NormalizedSyncItem,
    syncedAt: string
  ): void {
    const candidates = this.database.prepare(`
      SELECT id, title
      FROM checklist_items
      WHERE game_id = ?
        AND id <> ?
        AND category = 'limited_event'
        AND source = 'personal_sync'
        AND archived = 0
        AND (
          remote_key = ?
          OR (? IS NOT NULL AND mode_key = ?)
          OR (
            starts_at IS NOT NULL AND ends_at IS NOT NULL
            AND ? IS NOT NULL AND ? IS NOT NULL
            AND julianday(starts_at) <= julianday(?)
            AND julianday(ends_at) >= julianday(?)
          )
        )
    `).all(
      gameId,
      preservedId,
      item.remoteKey,
      item.modeKey ?? null,
      item.modeKey ?? null,
      item.startsAt ?? null,
      item.endsAt ?? null,
      item.endsAt ?? null,
      item.startsAt ?? null
    ) as Array<{ id: string; title: string }>
    const ids = candidates
      .filter((candidate) => eventTitlesEquivalent(candidate.title, item.title))
      .map((candidate) => candidate.id)
    if (ids.length === 0) return
    const statement = this.database.prepare(`
      UPDATE checklist_items
      SET archived = 1, updated_at = ?
      WHERE id = ? AND source = 'personal_sync' AND archived = 0
    `)
    for (const id of ids) statement.run(syncedAt, id)
  }

  private absorbEquivalentPersonalMapDuplicates(
    gameId: GameId,
    preservedId: string,
    item: NormalizedSyncItem,
    syncedAt: string
  ): void {
    const candidates = this.database.prepare(`
      SELECT id, progress_percent AS progressPercent, completed,
        completed_at AS completedAt, last_synced_at AS lastSyncedAt,
        updated_at AS updatedAt
      FROM checklist_items
      WHERE game_id = ?
        AND id <> ?
        AND category = 'exploration'
        AND source = 'personal_sync'
        AND archived = 0
        AND title = ?
        AND COALESCE(map_node_kind, 'region') = ?
        AND (
          (? IS NULL AND parent_remote_key IS NULL)
          OR (
            ? IS NOT NULL
            AND (parent_remote_key = ? OR parent_title = ?)
          )
        )
    `).all(
      gameId,
      preservedId,
      item.title,
      item.mapNodeKind ?? 'region',
      item.parentRemoteKey ?? null,
      item.parentRemoteKey ?? null,
      item.parentRemoteKey ?? null,
      item.parentTitle ?? null
    ) as Array<{
      id: string
      progressPercent: number | null
      completed: number
      completedAt: string | null
      lastSyncedAt: string | null
      updatedAt: string
    }>
    if (candidates.length === 0) return

    const moveBinding = this.database.prepare(`
      UPDATE source_bindings
      SET item_id = ?, updated_at = ?
      WHERE game_id = ? AND item_id = ?
    `)
    const moveObservation = this.database.prepare(`
      UPDATE sync_observations
      SET item_id = ?
      WHERE game_id = ? AND item_id = ?
    `)
    const archive = this.database.prepare(`
      UPDATE checklist_items
      SET archived = 1, updated_at = ?
      WHERE id = ? AND source = 'personal_sync' AND archived = 0
    `)
    for (const candidate of candidates) {
      const states = this.database.prepare(`
        SELECT account_scope AS accountScope, provider, endpoint,
          external_id AS externalId, completion_state AS completionState,
          progress_percent AS progressPercent, observed_at AS observedAt,
          updated_at AS updatedAt
        FROM personal_item_states
        WHERE game_id = ? AND item_id = ?
      `).all(gameId, candidate.id) as Array<{
        accountScope: string
        provider: string
        endpoint: string
        externalId: string
        completionState: PersonalCompletionState
        progressPercent: number | null
        observedAt: string
        updatedAt: string
      }>
      for (const state of states) {
        const existing = this.getPersonalItemState(state.accountScope, preservedId)
        if (!existing || Date.parse(state.observedAt) >= Date.parse(existing.observedAt)) {
          this.upsertPersonalItemState({
            accountScope: state.accountScope,
            gameId,
            itemId: preservedId,
            provider: state.provider,
            endpoint: state.endpoint,
            externalId: state.externalId,
            completionState: state.completionState,
            progressPercent: state.progressPercent,
            observedAt: state.observedAt
          }, new Date(state.updatedAt))
        }
      }
      this.database.prepare(`
        DELETE FROM personal_item_states WHERE game_id = ? AND item_id = ?
      `).run(gameId, candidate.id)
      moveBinding.run(preservedId, syncedAt, gameId, candidate.id)
      moveObservation.run(preservedId, gameId, candidate.id)
      archive.run(syncedAt, candidate.id)
    }

    const latestState = this.database.prepare(`
      SELECT progress_percent AS progressPercent, completion_state AS completionState,
        observed_at AS observedAt
      FROM personal_item_states
      WHERE game_id = ? AND item_id = ? AND progress_percent IS NOT NULL
      ORDER BY observed_at DESC
      LIMIT 1
    `).get(gameId, preservedId) as {
      progressPercent: number
      completionState: PersonalCompletionState
      observedAt: string
    } | undefined
    const fallback = candidates
      .filter((candidate) => candidate.progressPercent !== null)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
    const progressPercent = latestState?.progressPercent ?? fallback?.progressPercent
    if (progressPercent === undefined || progressPercent === null) return
    const completed = latestState
      ? latestState.completionState === 'completed' || progressPercent === 100
      : Boolean(fallback?.completed) || progressPercent === 100
    this.database.prepare(`
      UPDATE checklist_items
      SET progress_percent = ?, completed = ?,
        completed_at = CASE WHEN ? = 1 THEN COALESCE(completed_at, ?) ELSE NULL END,
        last_synced_at = COALESCE(?, last_synced_at), updated_at = ?
      WHERE id = ? AND archived = 0
    `).run(
      progressPercent,
      completed ? 1 : 0,
      completed ? 1 : 0,
      latestState?.observedAt ?? fallback?.completedAt ?? syncedAt,
      latestState?.observedAt ?? fallback?.lastSyncedAt ?? null,
      syncedAt,
      preservedId
    )
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

  resetDueQuestItems(reference = new Date()): number {
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE checklist_items
      SET completed = 0,
          completed_at = NULL,
          manual_completion_locked = 0,
          starts_at = NULL,
          ends_at = NULL,
          reset_rule = '待同步新版本时间',
          updated_at = ?
      WHERE category IN ('main_quest', 'side_quest')
        AND archived = 0
        AND ends_at IS NOT NULL
        AND julianday(ends_at) <= julianday(?)
    `).run(now, now)
    return Number(result.changes)
  }

  private validateVersionScheduleItems(items: NormalizedSyncItem[], reference: Date): void {
    if (items.length !== 2) throw new Error('版更校时必须同时提交主线任务和支线任务')
    const main = items.find((item) => item.category === 'main_quest')
    const side = items.find((item) => item.category === 'side_quest')
    if (!main || !side) throw new Error('版更校时缺少主线任务或支线任务')
    if (main.title !== '主线任务' || side.title !== '支线任务') {
      throw new Error('版更校时不能修改固定任务名称')
    }
    for (const item of items) {
      if (!item.periodKey?.trim()) throw new Error('版更校时缺少当前版本标识')
      if (!item.startsAt || !item.endsAt) throw new Error('版更校时缺少完整版本起止时间')
      if (!item.timeZone?.trim()) throw new Error('版更校时缺少官方服务器时区')
      if (item.scheduleKind !== 'fixed_window') throw new Error('版更校时必须使用固定时间窗口')
      if (Date.parse(item.startsAt) > reference.getTime()) {
        throw new Error('版更校时只能提交当前已经开始的游戏版本')
      }
      if (Date.parse(item.endsAt) <= reference.getTime()) {
        throw new Error('版更校时不能提交已经结束的游戏版本')
      }
    }
    if (
      main.periodKey !== side.periodKey ||
      main.startsAt !== side.startsAt ||
      main.endsAt !== side.endsAt ||
      main.timeZone !== side.timeZone
    ) {
      throw new Error('主线任务和支线任务必须共享同一版本时间')
    }
  }

  private mergeVersionScheduleItem(
    gameId: GameId,
    item: NormalizedSyncItem,
    syncedAt: string
  ): void {
    const id = `${gameId}:${item.category}`
    const current = this.getChecklistItem(id)
    const periodChanged = Boolean(
      current.periodKey &&
      item.periodKey &&
      current.periodKey !== item.periodKey
    )
    this.database.prepare(`
      UPDATE checklist_items
      SET completed = CASE WHEN ? THEN 0 ELSE completed END,
          completed_at = CASE WHEN ? THEN NULL ELSE completed_at END,
          manual_completion_locked = CASE WHEN ? THEN 0 ELSE manual_completion_locked END,
          starts_at = ?,
          ends_at = ?,
          reset_rule = NULL,
          period_key = ?,
          schedule_kind = 'fixed_window',
          timezone = ?,
          mode_key = 'game-version',
          source = 'public_schedule',
          remote_key = ?,
          source_url = ?,
          last_synced_at = ?,
          updated_at = ?
      WHERE id = ? AND archived = 0
    `).run(
      periodChanged ? 1 : 0,
      periodChanged ? 1 : 0,
      periodChanged ? 1 : 0,
      item.startsAt ?? null,
      item.endsAt ?? null,
      item.periodKey ?? null,
      item.timeZone ?? null,
      `version:${gameId}:${item.category}`,
      item.sourceUrl ?? null,
      syncedAt,
      syncedAt,
      id
    )
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

  private findActiveChecklistItem(itemId: string, gameId: GameId): ChecklistItem | null {
    const row = this.database.prepare(`
      SELECT id FROM checklist_items
      WHERE id = ? AND game_id = ? AND archived = 0
    `).get(itemId, gameId) as { id: string } | undefined
    return row ? this.getChecklistItem(row.id) : null
  }

  private findActiveChecklistItemByRemoteKey(
    gameId: GameId,
    remoteKey: string
  ): ChecklistItem | null {
    const row = this.database.prepare(`
      SELECT id FROM checklist_items
      WHERE game_id = ? AND remote_key = ? AND archived = 0
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(gameId, remoteKey) as { id: string } | undefined
    return row ? this.getChecklistItem(row.id) : null
  }

  private applyPersonalStateToChecklist(
    item: ChecklistItem,
    accountScope: string,
    identity: { provider: string; endpoint: string; externalId: string },
    observed: { completionState: PersonalCompletionState; progressPercent: number | null },
    reference: Date
  ): { applied: number; preserved: number } {
    const now = reference.toISOString()
    const unknown = observed.completionState === 'unknown'
    const requestedCompleted = observed.completionState === 'completed'
    const completionProtected =
      observed.completionState === 'incomplete' &&
      item.manualCompletionLocked &&
      item.completed
    const completed = unknown
      ? item.completed
      : completionProtected
        ? true
        : requestedCompleted
    const completedAt = unknown
      ? item.completedAt
      : completed
        ? item.completedAt ?? now
        : null
    const result = this.database.prepare(`
      UPDATE checklist_items
      SET completed = ?,
          progress_percent = CASE
            WHEN category = 'exploration' AND ? IS NOT NULL THEN ?
            ELSE progress_percent
          END,
          completed_at = ?,
          last_synced_at = ?,
          updated_at = ?
      WHERE id = ? AND game_id = ? AND archived = 0
    `).run(
      completed ? 1 : 0,
      observed.progressPercent,
      observed.progressPercent,
      completedAt,
      now,
      now,
      item.id,
      item.gameId
    )
    if (result.changes !== 1) throw new Error('个人状态对应的清单项已不存在')
    this.upsertPersonalItemState({
      accountScope,
      gameId: item.gameId,
      itemId: item.id,
      ...identity,
      completionState: observed.completionState,
      progressPercent: observed.progressPercent,
      observedAt: now
    }, reference)
    this.database.prepare(`
      INSERT INTO sync_observations(
        id, game_id, account_scope, provider, endpoint, external_id, target,
        completion_state, progress_percent, payload_hash, outcome, item_id,
        candidate_id, observed_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      randomUUID(),
      item.gameId,
      accountScope,
      identity.provider,
      identity.endpoint,
      identity.externalId,
      item.category === 'exploration'
        ? 'exploration'
        : item.category === 'weekly' || item.category === 'endgame'
          ? 'cycles'
          : 'events',
      observed.completionState,
      observed.progressPercent,
      createHash('sha256')
        .update(stableJson({ identity, observed }))
        .digest('hex'),
      unknown || completionProtected ? 'ignored' : 'applied',
      item.id,
      now,
      now
    )
    return unknown || completionProtected
      ? { applied: 0, preserved: 1 }
      : { applied: 1, preserved: 0 }
  }

  private backfillSemanticReviewBindings(reference = new Date()): void {
    const rows = this.database.prepare(`
      SELECT game_id AS gameId, kind, payload_json AS payloadJson,
        decision_json AS decisionJson, account_scope AS accountScope,
        completed_at AS completedAt
      FROM semantic_review_candidates
      WHERE source = 'personal_sync' AND status = 'approved'
        AND decision_json IS NOT NULL
      ORDER BY completed_at ASC
    `).all() as Array<{
      gameId: GameId
      kind: string
      payloadJson: string
      decisionJson: string
      accountScope: string | null
      completedAt: string | null
    }>
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payloadJson) as Record<string, unknown>
        const decision = JSON.parse(row.decisionJson) as {
          item?: NormalizedSyncItem
          matchItemId?: string | null
          confidence?: number
          completionRule?: PersonalCompletionRule | null
        }
        const identity = readSemanticSourceIdentity(row.kind, payload)
        if (!identity || !decision.item) continue
        const item = decision.matchItemId
          ? this.findActiveChecklistItem(decision.matchItemId, row.gameId)
          : this.findActiveChecklistItemByRemoteKey(row.gameId, decision.item.remoteKey)
        if (!item) continue
        this.upsertSourceBinding({
          gameId: row.gameId,
          ...identity,
          itemId: item.id,
          bindingKind: 'backfill',
          confidence: typeof decision.confidence === 'number' ? decision.confidence : 1,
          stateRule: decision.completionRule ?? null
        }, row.completedAt ? new Date(row.completedAt) : reference)
      } catch {
        // 旧协议的决策可能不含完整身份字段；这类记录保留审计但不阻止数据库打开。
      }
    }
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
          'main_quest', 'side_quest', 'limited_event',
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

    const migration12 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 12')
      .get()

    if (!migration12) {
      this.database.exec(`
        BEGIN;
        CREATE TABLE semantic_review_candidates (
          id TEXT PRIMARY KEY,
          fingerprint TEXT NOT NULL UNIQUE,
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
          source TEXT NOT NULL CHECK (source IN ('public_schedule', 'personal_sync')),
          target TEXT NOT NULL CHECK (target IN ('events', 'cycles', 'exploration')),
          kind TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'approved', 'rejected')),
          payload_json TEXT NOT NULL,
          decision_json TEXT,
          evidence_json TEXT,
          requested_at TEXT NOT NULL,
          claimed_at TEXT,
          completed_at TEXT,
          agent_id TEXT REFERENCES ai_schedule_agents(id) ON DELETE SET NULL,
          message TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX semantic_review_candidates_pending
          ON semantic_review_candidates(status, requested_at);
        INSERT INTO schema_migrations(version) VALUES (12);
        COMMIT;
      `)
    }

    const migration13 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 13')
      .get()

    if (!migration13) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE ai_schedule_jobs ADD COLUMN progress_phase TEXT NOT NULL DEFAULT 'queued'
          CHECK (progress_phase IN (
            'queued', 'fetching', 'searching', 'verifying', 'structuring',
            'writing', 'retrying', 'verification', 'merging', 'completed', 'failed'
          ));
        ALTER TABLE ai_schedule_jobs ADD COLUMN progress_current INTEGER;
        ALTER TABLE ai_schedule_jobs ADD COLUMN progress_total INTEGER;
        ALTER TABLE ai_schedule_jobs ADD COLUMN progress_updated_at TEXT;
        UPDATE ai_schedule_jobs
          SET progress_phase = CASE
            WHEN status = 'completed' THEN 'completed'
            WHEN status = 'failed' THEN 'failed'
            WHEN status = 'claimed' THEN 'searching'
            ELSE 'queued'
          END,
          progress_updated_at = updated_at;
        INSERT INTO schema_migrations(version) VALUES (13);
        COMMIT;
      `)
    }

    const migration14 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 14')
      .get()

    if (!migration14) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE sync_target_states RENAME TO sync_target_states_v13;
        CREATE TABLE sync_target_states (
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          target TEXT NOT NULL CHECK (target IN ('all', 'tasks', 'events', 'cycles', 'exploration')),
          last_success_at TEXT NOT NULL,
          PRIMARY KEY(game_id, target)
        );
        INSERT INTO sync_target_states(game_id, target, last_success_at)
          SELECT game_id, target, last_success_at FROM sync_target_states_v13;
        DROP TABLE sync_target_states_v13;
        INSERT INTO schema_migrations(version) VALUES (14);
        COMMIT;
      `)
    }

    const migration15 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 15')
      .get()

    if (!migration15) {
      const hasActivityTags = (this.database.prepare('PRAGMA table_info(checklist_items)').all() as Array<{
        name: string
      }>).some((column) => column.name === 'activity_tags_json')
      this.database.exec(hasActivityTags
        ? `INSERT INTO schema_migrations(version) VALUES (15);`
        : `
          BEGIN;
          ALTER TABLE checklist_items
            ADD COLUMN activity_tags_json TEXT NOT NULL DEFAULT '[]';
          INSERT INTO schema_migrations(version) VALUES (15);
          COMMIT;
        `)
    }

    const migration16 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 16')
      .get()

    if (!migration16) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE sync_target_states RENAME TO sync_target_states_v15;
        CREATE TABLE sync_target_states (
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          target TEXT NOT NULL CHECK (target IN ('all', 'tasks', 'events', 'cycles', 'exploration')),
          last_success_at TEXT,
          last_attempt_at TEXT,
          status TEXT NOT NULL DEFAULT 'idle'
            CHECK (status IN ('idle', 'success', 'error', 'stale', 'verification_required')),
          PRIMARY KEY(game_id, target)
        );
        INSERT INTO sync_target_states(
          game_id, target, last_success_at, last_attempt_at, status
        )
          SELECT game_id, target, last_success_at, last_success_at, 'success'
          FROM sync_target_states_v15;
        DROP TABLE sync_target_states_v15;
        UPDATE checklist_items
          SET activity_tags_json = REPLACE(activity_tags_json, '"待识别"', '"未知"')
          WHERE activity_tags_json LIKE '%"待识别"%';
        INSERT INTO schema_migrations(version) VALUES (16);
        COMMIT;
      `)
    }

    const migration17 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 17')
      .get()

    if (!migration17) {
      const columns = new Set((this.database.prepare('PRAGMA table_info(checklist_items)').all() as Array<{
        name: string
      }>).map((column) => column.name))
      const additions = [
        !columns.has('map_node_kind')
          ? `ALTER TABLE checklist_items ADD COLUMN map_node_kind TEXT
              CHECK (map_node_kind IS NULL OR map_node_kind IN ('region', 'subregion', 'independent', 'group'));`
          : '',
        !columns.has('parent_remote_key')
          ? 'ALTER TABLE checklist_items ADD COLUMN parent_remote_key TEXT;'
          : '',
        !columns.has('related_region_remote_key')
          ? 'ALTER TABLE checklist_items ADD COLUMN related_region_remote_key TEXT;'
          : ''
      ].filter(Boolean).join('\n')
      this.database.exec(`
        BEGIN;
        ${additions}
        UPDATE checklist_items
          SET map_node_kind = CASE WHEN parent_title IS NULL THEN 'region' ELSE 'subregion' END
          WHERE category = 'exploration' AND map_node_kind IS NULL;
        INSERT INTO schema_migrations(version) VALUES (17);
        COMMIT;
      `)
    }

    const migration18 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 18')
      .get()

    if (!migration18) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE ai_schedule_jobs
          ADD COLUMN output_locale TEXT NOT NULL DEFAULT 'zh-CN';
        ALTER TABLE semantic_review_candidates
          ADD COLUMN output_locale TEXT NOT NULL DEFAULT 'zh-CN';
        ALTER TABLE semantic_review_candidates
          ADD COLUMN user_timezone TEXT NOT NULL DEFAULT 'UTC';
        INSERT INTO schema_migrations(version) VALUES (18);
        COMMIT;
      `)
    }

    const migration19 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 19')
      .get()

    if (!migration19) {
      this.database.exec(`
        BEGIN;
        DROP INDEX IF EXISTS ai_schedule_jobs_active_game;
        CREATE UNIQUE INDEX ai_schedule_jobs_active_game_target
          ON ai_schedule_jobs(game_id, target)
          WHERE status IN ('pending', 'claimed');
        INSERT INTO schema_migrations(version) VALUES (19);
        COMMIT;
      `)
    }

    const migration20 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 20')
      .get()

    if (!migration20) {
      this.database.exec(`
        BEGIN;
        ALTER TABLE semantic_review_candidates
          ADD COLUMN account_scope TEXT;

        CREATE TABLE IF NOT EXISTS source_bindings (
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          external_id TEXT NOT NULL,
          item_id TEXT NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
          binding_kind TEXT NOT NULL
            CHECK (binding_kind IN ('mechanical', 'codex', 'backfill')),
          confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(game_id, provider, endpoint, external_id)
        );
        CREATE INDEX IF NOT EXISTS source_bindings_item
          ON source_bindings(game_id, item_id);

        CREATE TABLE IF NOT EXISTS personal_item_states (
          account_scope TEXT NOT NULL,
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          item_id TEXT NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          external_id TEXT NOT NULL,
          completion_state TEXT NOT NULL
            CHECK (completion_state IN ('completed', 'incomplete', 'unknown')),
          progress_percent REAL
            CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)),
          observed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(account_scope, item_id)
        );
        CREATE INDEX IF NOT EXISTS personal_item_states_game_account
          ON personal_item_states(game_id, account_scope, observed_at);

        CREATE TABLE IF NOT EXISTS semantic_profiles (
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          provider TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          profile_version TEXT NOT NULL,
          target TEXT NOT NULL CHECK (target IN ('events', 'cycles', 'exploration')),
          status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'needs_review')),
          semantics_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(game_id, provider, endpoint, profile_version)
        );

        CREATE TABLE IF NOT EXISTS sync_observations (
          id TEXT PRIMARY KEY,
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          account_scope TEXT,
          provider TEXT NOT NULL,
          endpoint TEXT NOT NULL,
          external_id TEXT NOT NULL,
          target TEXT NOT NULL CHECK (target IN ('events', 'cycles', 'exploration')),
          completion_state TEXT NOT NULL
            CHECK (completion_state IN ('completed', 'incomplete', 'unknown')),
          progress_percent REAL
            CHECK (progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)),
          payload_hash TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('applied', 'queued', 'ignored', 'conflict')),
          item_id TEXT REFERENCES checklist_items(id) ON DELETE SET NULL,
          candidate_id TEXT REFERENCES semantic_review_candidates(id) ON DELETE SET NULL,
          observed_at TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sync_observations_lookup
          ON sync_observations(game_id, provider, endpoint, external_id, observed_at);

        INSERT INTO schema_migrations(version) VALUES (20);
        COMMIT;
      `)
    }

    const migration21 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 21')
      .get()

    if (!migration21) {
      const syncTargetColumns = new Set(
        (this.database.prepare('PRAGMA table_info(sync_target_states)').all() as Array<{ name: string }>)
          .map((column) => column.name)
      )
      const catalogCoverageMigration = syncTargetColumns.has('catalog_coverage')
        ? ''
        : `
          ALTER TABLE sync_target_states
            ADD COLUMN catalog_coverage TEXT NOT NULL DEFAULT 'empty'
              CHECK (catalog_coverage IN ('empty', 'partial', 'complete'));
        `
      const catalogSourceMigration = syncTargetColumns.has('catalog_source')
        ? ''
        : `
          ALTER TABLE sync_target_states
            ADD COLUMN catalog_source TEXT
              CHECK (catalog_source IS NULL OR catalog_source IN ('public_schedule', 'personal_data'));
        `
      this.database.exec(`
        BEGIN;
        ${catalogCoverageMigration}
        ${catalogSourceMigration}

        UPDATE sync_target_states
        SET catalog_coverage = 'partial',
            catalog_source = 'personal_data'
        WHERE target IN ('events', 'cycles', 'exploration')
          AND EXISTS (
            SELECT 1
            FROM checklist_items item
            WHERE item.game_id = sync_target_states.game_id
              AND item.archived = 0
              AND (
                (sync_target_states.target = 'events'
                  AND item.category = 'limited_event')
                OR (sync_target_states.target = 'cycles'
                  AND item.category IN ('weekly', 'endgame'))
                OR (sync_target_states.target = 'exploration'
                  AND item.category = 'exploration')
              )
          );

        UPDATE sync_target_states
        SET catalog_coverage = 'complete',
            catalog_source = 'public_schedule'
        WHERE EXISTS (
          SELECT 1
          FROM ai_schedule_jobs job
          WHERE job.game_id = sync_target_states.game_id
            AND job.status = 'completed'
            AND (job.target = sync_target_states.target OR job.target = 'all')
        );

        UPDATE sync_target_states
        SET catalog_coverage = 'complete',
            catalog_source = 'public_schedule'
        WHERE target = 'all'
          AND last_success_at IS NOT NULL;

        INSERT INTO schema_migrations(version) VALUES (21);
        COMMIT;
      `)
    }

    const migration22 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 22')
      .get()

    if (!migration22) {
      const syncStateColumns = new Set(
        (this.database.prepare('PRAGMA table_info(sync_states)').all() as Array<{ name: string }>)
          .map((column) => column.name)
      )
      this.database.exec(syncStateColumns.has('initial_guide_dismissed')
        ? `INSERT INTO schema_migrations(version) VALUES (22);`
        : `
          BEGIN;
          ALTER TABLE sync_states
            ADD COLUMN initial_guide_dismissed INTEGER NOT NULL DEFAULT 0
              CHECK (initial_guide_dismissed IN (0, 1));
          INSERT INTO schema_migrations(version) VALUES (22);
          COMMIT;
        `)
    }

    const migration23 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 23')
      .get()

    if (!migration23) {
      const bindingColumns = new Set(
        (this.database.prepare('PRAGMA table_info(source_bindings)').all() as Array<{ name: string }>)
          .map((column) => column.name)
      )
      this.database.exec(bindingColumns.has('state_rule_json')
        ? `INSERT INTO schema_migrations(version) VALUES (23);`
        : `
          BEGIN;
          ALTER TABLE source_bindings ADD COLUMN state_rule_json TEXT;
          INSERT INTO schema_migrations(version) VALUES (23);
          COMMIT;
        `)
    }

    const migration24 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 24')
      .get()

    if (!migration24) {
      this.database.exec(`
        BEGIN;
        UPDATE checklist_items
        SET parent_remote_key = COALESCE(parent_remote_key, related_region_remote_key)
        WHERE category = 'exploration'
          AND parent_remote_key IS NULL
          AND related_region_remote_key IS NOT NULL;
        UPDATE checklist_items
        SET parent_remote_key = (
          SELECT parent.parent_remote_key
          FROM checklist_items parent
          WHERE parent.game_id = checklist_items.game_id
            AND parent.remote_key = checklist_items.parent_remote_key
            AND parent.archived = 0
        )
        WHERE category = 'exploration'
          AND parent_remote_key IN (
            SELECT remote_key
            FROM checklist_items
            WHERE category = 'exploration'
              AND parent_remote_key IS NOT NULL
              AND archived = 0
          );
        UPDATE checklist_items
        SET parent_remote_key = NULL
        WHERE category = 'exploration'
          AND parent_remote_key IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM checklist_items parent
            WHERE parent.game_id = checklist_items.game_id
              AND parent.remote_key = checklist_items.parent_remote_key
              AND parent.archived = 0
          );
        UPDATE checklist_items
        SET map_node_kind = CASE
              WHEN parent_remote_key IS NULL THEN 'region'
              ELSE 'subregion'
            END,
            related_region_remote_key = NULL
        WHERE category = 'exploration';
        INSERT INTO schema_migrations(version) VALUES (24);
        COMMIT;
      `)
    }

    const migration25 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 25')
      .get()

    if (!migration25) {
      this.database.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS codex_worker_settings (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          model TEXT NOT NULL DEFAULT 'inherit'
            CHECK (model IN ('inherit', 'gpt-5.6-sol', 'gpt-5.6-terra')),
          reasoning_effort TEXT NOT NULL DEFAULT 'inherit'
            CHECK (reasoning_effort IN (
              'inherit', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
            )),
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT OR IGNORE INTO codex_worker_settings(singleton) VALUES (1);
        INSERT INTO schema_migrations(version) VALUES (25);
        COMMIT;
      `)
    }

    const migration26 = this.database
      .prepare('SELECT version FROM schema_migrations WHERE version = 26')
      .get()

    if (!migration26) {
      this.database.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS sync_deletion_tombstones (
          game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
          identity_key TEXT NOT NULL,
          category TEXT NOT NULL CHECK (category IN (
            'main_quest', 'side_quest', 'limited_event',
            'weekly', 'endgame', 'exploration', 'custom'
          )),
          deleted_at TEXT NOT NULL,
          PRIMARY KEY(game_id, identity_key)
        );
        INSERT INTO schema_migrations(version) VALUES (26);
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

  private seedPersonalSemanticProfiles(): void {
    const now = new Date().toISOString()
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO semantic_profiles(
        game_id, provider, endpoint, profile_version, target, status,
        semantics_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'personal-v1', ?, ?, ?, ?, ?)
    `)
    const profiles: Array<{
      gameId: GameId
      provider: string
      endpoint: string
      target: PersonalSyncTarget
      status: SemanticProfile['status']
      semantics: Record<string, unknown>
    }> = [
      ...(['genshin', 'star-rail', 'zenless'] as const).map((gameId) => ({
        gameId,
        provider: 'miyoushe',
        endpoint: 'personal-challenge-record',
        target: 'cycles' as const,
        status: 'active' as const,
        semantics: {
          identityField: 'observedRemoteKey',
          modeField: 'observedModeKey',
          completionField: 'observedHasChallengeRecord',
          completionMeaning: '存在任意挑战记录即视为已完成'
        }
      })),
      {
        gameId: 'wuthering-waves',
        provider: 'kuro-community',
        endpoint: 'personal-challenge-record',
        target: 'cycles',
        status: 'active',
        semantics: {
          identityField: 'observedRemoteKey',
          modeField: 'observedModeKey',
          completionField: 'observedHasChallengeRecord',
          completionMeaning: '存在任意挑战记录即视为已完成'
        }
      },
      ...([
        ['genshin', 'miyoushe'],
        ['zenless', 'miyoushe'],
        ['wuthering-waves', 'kuro-community']
      ] as const).map(([gameId, provider]) => ({
        gameId,
        provider,
        endpoint: 'personal-map-progress',
        target: 'exploration' as const,
        status: 'active' as const,
        semantics: {
          identityField: 'officialId',
          progressField: 'observedProgress',
          progressRange: '0-100',
          catalogAuthority: 'bundled-canonical-map-catalog'
        }
      })),
      {
        gameId: 'genshin',
        provider: 'miyoushe',
        endpoint: 'miyoushe-genshin-event-calendar',
        target: 'events',
        status: 'needs_review',
        semantics: { completionMeaning: '接口完成字段尚不能证明玩家完成整个活动' }
      },
      {
        gameId: 'star-rail',
        provider: 'miyoushe',
        endpoint: 'miyoushe-star-rail-event-calendar',
        target: 'events',
        status: 'needs_review',
        semantics: { completionMeaning: '接口完成字段需按具体活动语义判断' }
      },
      {
        gameId: 'zenless',
        provider: 'miyoushe',
        endpoint: 'miyoushe-zenless-event-calendar',
        target: 'events',
        status: 'needs_review',
        semantics: { completionMeaning: '接口状态与奖励字段需按具体活动语义判断' }
      }
    ]
    for (const profile of profiles) {
      insert.run(
        profile.gameId,
        profile.provider,
        profile.endpoint,
        profile.target,
        profile.status,
        stableJson(profile.semantics),
        now,
        now
      )
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

  private consolidateFixedWeeklyItems(): void {
    const now = new Date().toISOString()
    const completedExtras = this.database.prepare(`
      SELECT game_id AS gameId, MAX(completed) AS completed
      FROM checklist_items
      WHERE category = 'weekly'
        AND archived = 0
        AND id <> game_id || ':weekly'
      GROUP BY game_id
    `).all() as Array<{ gameId: GameId; completed: number }>

    const completeCanonical = this.database.prepare(`
      UPDATE checklist_items
      SET completed = 1,
          completed_at = COALESCE(completed_at, ?),
          updated_at = ?
      WHERE id = ?
        AND archived = 0
        AND completed = 0
    `)
    for (const extra of completedExtras) {
      if (Boolean(extra.completed)) {
        completeCanonical.run(now, now, `${extra.gameId}:weekly`)
      }
    }

    this.database.prepare(`
      UPDATE checklist_items
      SET archived = 1, updated_at = ?
      WHERE category = 'weekly'
        AND archived = 0
        AND id <> game_id || ':weekly'
    `).run(now)
  }

  private consolidateEquivalentSyncedEndgameItems(): void {
    type EndgameIdentityRow = {
      id: string
      gameId: GameId
      title: string
      completed: number
      manualCompletionLocked: number
      completedAt: string | null
      startsAt: string | null
      endsAt: string | null
      periodKey: string | null
      modeKey: string | null
      source: ChecklistSource
      remoteKey: string | null
      lastSyncedAt: string | null
      updatedAt: string
    }

    const rows = this.database.prepare(`
      SELECT id,
        game_id AS gameId,
        title,
        completed,
        manual_completion_locked AS manualCompletionLocked,
        completed_at AS completedAt,
        starts_at AS startsAt,
        ends_at AS endsAt,
        period_key AS periodKey,
        mode_key AS modeKey,
        source,
        remote_key AS remoteKey,
        last_synced_at AS lastSyncedAt,
        updated_at AS updatedAt
      FROM checklist_items
      WHERE category = 'endgame'
        AND source <> 'manual'
        AND archived = 0
    `).all() as EndgameIdentityRow[]
    if (rows.length < 2) return

    const parents = rows.map((_, index) => index)
    const find = (index: number): number => {
      while (parents[index] !== index) {
        parents[index] = parents[parents[index]]
        index = parents[index]
      }
      return index
    }
    const union = (left: number, right: number): void => {
      const leftRoot = find(left)
      const rightRoot = find(right)
      if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot
    }
    const windowsOverlap = (left: EndgameIdentityRow, right: EndgameIdentityRow): boolean => {
      if (!left.startsAt || !left.endsAt || !right.startsAt || !right.endsAt) return false
      return Date.parse(left.startsAt) < Date.parse(right.endsAt) &&
        Date.parse(left.endsAt) > Date.parse(right.startsAt)
    }
    const activeAtStartup = (row: EndgameIdentityRow): boolean => {
      if (!row.startsAt || !row.endsAt) return false
      const now = Date.now()
      return Date.parse(row.startsAt) <= now && Date.parse(row.endsAt) >= now
    }
    const equivalent = (left: EndgameIdentityRow, right: EndgameIdentityRow): boolean => {
      if (left.gameId !== right.gameId) return false
      const sameMode = Boolean(left.modeKey && right.modeKey && left.modeKey === right.modeKey)
      const sameTitle = normalizeSyncedEventTitle(left.title) === normalizeSyncedEventTitle(right.title)
      if (!sameMode && !sameTitle) return false
      if (
        sameTitle &&
        left.source !== right.source &&
        (activeAtStartup(left) || activeAtStartup(right))
      ) return true
      if (windowsOverlap(left, right)) return true
      if (left.periodKey && right.periodKey) return left.periodKey === right.periodKey
      return Boolean(left.remoteKey && left.remoteKey === right.remoteKey)
    }

    for (let left = 0; left < rows.length; left += 1) {
      for (let right = left + 1; right < rows.length; right += 1) {
        if (equivalent(rows[left], rows[right])) union(left, right)
      }
    }

    const groups = new Map<number, EndgameIdentityRow[]>()
    rows.forEach((row, index) => {
      const root = find(index)
      const group = groups.get(root) ?? []
      group.push(row)
      groups.set(root, group)
    })
    const now = new Date().toISOString()
    const updateCanonical = this.database.prepare(`
      UPDATE checklist_items
      SET completed = ?,
          manual_completion_locked = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ? AND archived = 0
    `)
    const archiveDuplicate = this.database.prepare(`
      UPDATE checklist_items
      SET archived = 1, updated_at = ?
      WHERE id = ? AND archived = 0 AND source <> 'manual'
    `)

    for (const group of groups.values()) {
      if (group.length < 2) continue
      group.sort((left, right) => {
        const sourceDifference =
          Number(right.source === 'public_schedule') - Number(left.source === 'public_schedule')
        if (sourceDifference !== 0) return sourceDifference
        const lockDifference = right.manualCompletionLocked - left.manualCompletionLocked
        if (lockDifference !== 0) return lockDifference
        const completionDifference = right.completed - left.completed
        if (completionDifference !== 0) return completionDifference
        return Date.parse(right.lastSyncedAt ?? right.updatedAt) -
          Date.parse(left.lastSyncedAt ?? left.updatedAt)
      })
      const [canonical, ...duplicates] = group
      const completed = group.some((row) => Boolean(row.completed))
      const manualCompletionLocked = group.some((row) => Boolean(row.manualCompletionLocked))
      const completedAt = completed
        ? group
            .map((row) => row.completedAt)
            .filter((value): value is string => Boolean(value))
            .sort()[0] ?? now
        : null
      updateCanonical.run(
        completed ? 1 : 0,
        manualCompletionLocked ? 1 : 0,
        completedAt,
        now,
        canonical.id
      )
      for (const duplicate of duplicates) archiveDuplicate.run(now, duplicate.id)
    }
  }

  private normalizeLegacyActivityTags(): void {
    const rows = this.database.prepare(`
      SELECT id, activity_tags_json AS activityTagsJson
      FROM checklist_items
      WHERE category = 'limited_event' AND archived = 0
    `).all() as Array<{ id: string; activityTagsJson: string }>
    const update = this.database.prepare(`
      UPDATE checklist_items
      SET activity_tags_json = ?, updated_at = ?
      WHERE id = ? AND archived = 0
    `)
    const now = new Date().toISOString()
    for (const row of rows) {
      let parsed: unknown = []
      try {
        parsed = JSON.parse(row.activityTagsJson)
      } catch {
        // Invalid legacy values use the honest fallback below.
      }
      const tags = Array.isArray(parsed)
        ? [...new Set(parsed
            .filter((tag): tag is string => typeof tag === 'string')
            .map((tag) => tag.trim())
            .filter(Boolean)
            .map((tag) => tag === '待识别' ? '未知' : tag))]
        : []
      const normalizedTags = normalizeActivityTags(tags)
      const serialized = JSON.stringify(normalizedTags.length > 0 ? normalizedTags : ['未知'])
      if (serialized !== row.activityTagsJson) update.run(serialized, now, row.id)
    }
  }

  private dismissExpiredSemanticReviewCandidates(reference = new Date()): number {
    const rows = this.database.prepare(`
      SELECT id, target, kind, payload_json AS payloadJson
      FROM semantic_review_candidates
      WHERE status IN ('pending', 'claimed')
        AND target IN ('events', 'cycles')
    `).all() as Array<{
      id: string
      target: PersonalSyncTarget
      kind: string
      payloadJson: string
    }>
    const expiredIds = rows.flatMap((row) => {
      try {
        const draft: SemanticReviewDraft = {
          target: row.target,
          kind: row.kind,
          payload: JSON.parse(row.payloadJson) as Record<string, unknown>
        }
        return isSemanticReviewDraftRelevant(draft, reference) ? [] : [row.id]
      } catch {
        return []
      }
    })
    if (expiredIds.length === 0) return 0
    const now = reference.toISOString()
    const update = this.database.prepare(`
      UPDATE semantic_review_candidates
      SET status = 'rejected', completed_at = ?, agent_id = NULL, claimed_at = NULL,
          message = '历史事项已结束，无需同步到当前清单', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'claimed')
    `)
    let dismissed = 0
    this.runTransaction(() => {
      for (const id of expiredIds) dismissed += Number(update.run(now, now, id).changes)
    })
    return dismissed
  }

  private normalizeSyncedProgressSafety(reference = new Date()): void {
    const now = reference.toISOString()
    this.database.prepare(`
      UPDATE checklist_items
      SET completed = 0, completed_at = NULL, updated_at = ?
      WHERE category = 'limited_event'
        AND manual_completion_locked = 0
        AND completed = 1
        AND starts_at IS NOT NULL
        AND julianday(starts_at) > julianday(?)
    `).run(now, now)
    this.database.prepare(`
      UPDATE checklist_items
      SET progress_percent = NULL, updated_at = ?
      WHERE category <> 'exploration'
        AND progress_percent IS NOT NULL
    `).run(now)
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
          activity_tags_json AS activityTagsJson,
          completed,
          progress_percent AS progressPercent,
          parent_title AS parentTitle,
          map_node_kind AS mapNodeKind,
          parent_remote_key AS parentRemoteKey,
          related_region_remote_key AS relatedRegionRemoteKey,
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
    const item = row as Omit<ChecklistItem, 'activityTags' | 'completed' | 'manualCompletionLocked'> & {
      activityTagsJson: string
      completed: number
      manualCompletionLocked: number
    }
    let activityTags: string[] = []
    try {
      const parsed = JSON.parse(item.activityTagsJson)
      if (Array.isArray(parsed)) {
        activityTags = parsed.filter((tag): tag is string => typeof tag === 'string')
      }
    } catch {
      activityTags = []
    }
    const { activityTagsJson: _activityTagsJson, ...rest } = item

    return {
      ...rest,
      activityTags,
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

  private assertMapStructure(gameId: GameId, items: NormalizedSyncItem[]): void {
    for (const item of items) {
      const hasMapFields = Boolean(
        item.mapNodeKind || item.parentRemoteKey
      )
      if (item.category !== 'exploration' && hasMapFields) {
        throw new Error('地图层级字段只能用于地图探索事项')
      }
      if (
        item.category === 'exploration' &&
        item.mapNodeKind === 'region' &&
        item.parentRemoteKey
      ) {
        throw new Error(`一级主地区“${item.title}”不能包含上级地区`)
      }
      if (
        item.category === 'exploration' &&
        item.mapNodeKind === 'subregion' &&
        !item.parentRemoteKey
      ) {
        throw new Error(`二级地区“${item.title}”必须指定一级主地区`)
      }
    }

    const incomingMaps = items.filter((item) => item.category === 'exploration')
    if (incomingMaps.length === 0) return

    const existingMaps = this.listChecklistItems(gameId).filter(
      (item) => item.category === 'exploration' && item.remoteKey
    )
    const knownKeys = new Set(existingMaps.map((item) => item.remoteKey!))
    for (const item of incomingMaps) knownKeys.add(item.remoteKey)

    const nodeKinds = new Map<string, ChecklistItem['mapNodeKind']>()
    const parents = new Map<string, string | null>()
    for (const item of existingMaps) {
      nodeKinds.set(item.remoteKey!, item.mapNodeKind)
      parents.set(item.remoteKey!, item.parentRemoteKey)
    }
    for (const item of incomingMaps) {
      if (item.parentRemoteKey === item.remoteKey) throw new Error('地图节点不能以自身为上级')
      if (item.parentRemoteKey && !knownKeys.has(item.parentRemoteKey)) {
        throw new Error(`地图上级标识不存在：${item.parentRemoteKey}`)
      }
      nodeKinds.set(item.remoteKey, item.mapNodeKind ?? 'region')
      parents.set(item.remoteKey, item.parentRemoteKey ?? null)
    }

    for (const [key, parentKey] of parents) {
      const kind = nodeKinds.get(key)
      if (kind === 'region' && parentKey) {
        throw new Error(`一级主地区“${key}”不能包含上级地区`)
      }
      if (kind === 'subregion') {
        if (!parentKey) throw new Error(`二级地区“${key}”必须指定一级主地区`)
        if (nodeKinds.get(parentKey) !== 'region') {
          throw new Error(`二级地区“${key}”的上级必须是一级主地区`)
        }
      }
    }
  }

  private assertActiveMapReferences(gameId: GameId): void {
    const maps = this.listChecklistItems(gameId).filter(
      (item) => item.category === 'exploration' && item.remoteKey
    )
    const activeKeys = new Set(maps.map((item) => item.remoteKey!))
    for (const item of maps) {
      if (item.parentRemoteKey && !activeKeys.has(item.parentRemoteKey)) {
        throw new Error(`地图“${item.title}”的父级已归档或不存在，请在同一提交中重新挂接`)
      }
      if (item.mapNodeKind === 'region' && item.parentRemoteKey) {
        throw new Error(`一级主地区“${item.title}”不能包含上级地区`)
      }
      if (item.mapNodeKind === 'subregion') {
        if (!item.parentRemoteKey) throw new Error(`二级地区“${item.title}”必须指定一级主地区`)
        const parent = maps.find((candidate) => candidate.remoteKey === item.parentRemoteKey)
        if (parent?.mapNodeKind !== 'region') {
          throw new Error(`二级地区“${item.title}”的上级必须是一级主地区`)
        }
      }
    }
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
