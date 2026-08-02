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
  AiScheduleJobKind,
  CodexWorkerPreferences,
  CreateChecklistItemInput,
  GameId,
  GameSummary,
  PersonalSyncTarget,
  PersonalMetadataEnrichmentTarget,
  PersonalReviewTarget,
  SyncProgressPhase,
  SyncScope,
  SyncTarget,
  SyncTargetState,
  SyncSettings,
  SyncStatus,
  SyncRequestContext,
  UpdateChecklistItemInput
} from '../shared/contracts'
import {
  getPersonalMetadataContract,
  getPersonalReviewContract,
  getPublicSyncContract
} from './sync/interface-contract'
import {
  ACTIVITY_TAG_DIMENSIONS,
  ACTIVITY_TAG_TAXONOMY_VERSION,
  MAX_AI_ACTIVITY_TAGS,
  MIN_AI_ACTIVITY_TAGS,
  activityTagsMeetQualityContract,
  configureRuntimeActivityTags,
  listActivityTagDefinitions,
  localizeActivityTags,
  normalizeActivityTags,
  type ActivityTagDefinition,
  type ActivityTagDimension
} from './activity-tags'
import { findCycleMode, nextCyclePeriod } from './sync/cycle-catalog'
import {
  hasOfficialPersonalFact,
  type ActivityTagUpdate,
  type CodexArchiveDecision,
  type CodexScheduleItem,
  type NormalizedSyncItem,
  type PersonalMetadataUpdate,
  type PersonalReviewResolution,
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

// Gtask 1.0 ships one clean schema baseline. Closed-test databases are disposable,
// so the release does not carry a historical migration ladder or legacy tables.
export const CURRENT_SCHEMA_VERSION = 1

const AI_AGENT_MAX_AGE_MS = 5 * 60 * 1000
const AI_JOB_CLAIM_MAX_AGE_MS = 15 * 60 * 1000

export type PersonalCompletionState = 'completed' | 'incomplete' | 'unknown'
export type SourceBindingKind = 'mechanical' | 'codex'
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
  return !activityTagsMeetQualityContract(tags)
}

function assertActivityTagEvidence(
  title: string,
  tags: string[],
  evidence: PersonalMetadataUpdate['activityTagEvidence'],
  outputLocale: string
): void {
  // Per-tag notes are optional audit context. Requiring one URL per label made
  // agents optimize for the submission shape instead of choosing the smallest
  // accurate semantic set. Source-level evidence remains mandatory.
  if (!evidence || evidence.length === 0) return
  const normalizedTags = normalizeActivityTags(tags, outputLocale)
  if (evidence.length !== normalizedTags.length) {
    throw new Error(`活动“${title}”必须为每个玩法标签分别提交一条直接资料依据`)
  }
  const covered = new Set<string>()
  for (const entry of evidence) {
    const [tagId] = normalizeActivityTags([entry.tagId], outputLocale)
    if (!tagId || tagId === 'unknown' || !normalizedTags.includes(tagId) || covered.has(tagId)) {
      throw new Error(`活动“${title}”的逐标签依据包含未知、重复或未提交的标签`)
    }
    try {
      const url = new URL(entry.sourceUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    } catch {
      throw new Error(`活动“${title}”的标签“${tagId}”缺少有效资料地址`)
    }
    if (!entry.note.trim() || entry.note.trim().length > 300) {
      throw new Error(`活动“${title}”的标签“${tagId}”缺少简洁的玩法依据`)
    }
    covered.add(tagId)
  }
}

export class AppDatabase {
  private readonly database: DatabaseSync

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    try {
      this.database.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
      this.migrate()
      this.loadRuntimeActivityTags()
      this.seedGames()
      this.seedQuestChecklists()
      this.reconcileSyncTargetStates()
      this.ensureWeeklyForInitializedGames()
      this.consolidateFixedWeeklyItems()
      this.normalizeLegacyActivityTags()
      this.normalizeSyncedProgressSafety()
      this.normalizeWeeklySchedules()
      this.resetDueWeeklyItems()
      this.resetDueQuestItems()
      this.rolloverDueCycleItems()
      this.markStaleSyncStates()
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  listActivityTagCatalog(): ActivityTagDefinition[] {
    return listActivityTagDefinitions()
  }

  registerActivityTagForJob(input: {
    jobId: string
    agentId: string
    id: string
    dimension: ActivityTagDimension
    labels: Record<string, string>
    description: string
    aliases: string[]
    sourceUrl: string
    evidence: unknown
  }, reference = new Date()): ActivityTagDefinition {
    const job = this.getAiScheduleJob(input.jobId)
    if (job.status !== 'claimed' || job.agentId !== input.agentId) {
      throw new Error('只有当前领取同步任务的 Agent 才能注册活动标签')
    }
    const id = input.id.normalize('NFKC').trim().toLocaleLowerCase('en-US')
    if (!/^custom\.[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
      throw new Error('新增标签 ID 必须使用 custom. 前缀和稳定的英文短横线名称')
    }
    if (!ACTIVITY_TAG_DIMENSIONS.includes(input.dimension)) {
      throw new Error('活动标签维度不受支持')
    }
    const labels = Object.fromEntries(Object.entries(input.labels)
      .map(([locale, label]) => [locale.trim(), label.normalize('NFKC').trim()])
      .filter(([locale, label]) => locale && label))
    if (!labels[job.outputLocale] && !labels['zh-CN'] && !labels['en-US']) {
      throw new Error('新增标签必须提供当前输出语言、中文或英文名称')
    }
    const description = input.description.normalize('NFKC').trim()
    if (description.length < 4 || description.length > 300) {
      throw new Error('新增标签必须提供清晰、可复用的类型定义')
    }
    const aliases = [...new Set(input.aliases.map((alias) => alias.normalize('NFKC').trim())
      .filter(Boolean))].slice(0, 20)
    const builtin = listActivityTagDefinitions().find((definition) =>
      definition.id === id || Object.values(definition.labels).some((label) =>
        Object.values(labels).includes(label)
      )
    )
    if (builtin) return builtin
    const now = reference.toISOString()
    this.database.prepare(`
      INSERT INTO activity_tag_registry(
        id, dimension, labels_json, description, aliases_json,
        source_url, evidence_json, created_by_agent, taxonomy_version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dimension = excluded.dimension,
        labels_json = excluded.labels_json,
        description = excluded.description,
        aliases_json = excluded.aliases_json,
        source_url = excluded.source_url,
        evidence_json = excluded.evidence_json,
        taxonomy_version = excluded.taxonomy_version,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.dimension,
      JSON.stringify(labels),
      description,
      JSON.stringify(aliases),
      input.sourceUrl,
      JSON.stringify(input.evidence),
      input.agentId,
      ACTIVITY_TAG_TAXONOMY_VERSION,
      now,
      now
    )
    this.loadRuntimeActivityTags()
    return this.listActivityTagCatalog().find((definition) => definition.id === id)!
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
      SELECT strategy, model, reasoning_effort AS reasoningEffort
      FROM codex_worker_settings
      WHERE singleton = 1
    `).get() as ({
      strategy: string
      model: CodexWorkerPreferences['model']
      reasoningEffort: CodexWorkerPreferences['reasoningEffort']
    }) | undefined
    if (!row) throw new Error('Codex 后台设置不存在')
    if (row.strategy !== 'fixed') {
      return {
        strategy: 'fixed',
        model: 'gpt-5.6-sol',
        reasoningEffort: 'medium'
      }
    }
    return { strategy: 'fixed', model: row.model, reasoningEffort: row.reasoningEffort }
  }

  updateCodexWorkerPreferences(
    preferences: CodexWorkerPreferences,
    reference = new Date()
  ): CodexWorkerPreferences {
    const result = this.database.prepare(`
      UPDATE codex_worker_settings
      SET strategy = ?, model = ?, reasoning_effort = ?, updated_at = ?
      WHERE singleton = 1
    `).run(
      'fixed',
      preferences.model,
      preferences.reasoningEffort,
      reference.toISOString()
    )
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
      WHERE game_id = ? AND job_kind = 'public_catalog' AND status IN ('pending', 'claimed')
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
        id, game_id, scope, target, user_timezone, output_locale, job_kind, status, requested_at,
        progress_phase, progress_updated_at, message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'public_catalog', 'pending', ?, 'queued', ?,
        '同步任务正在排队', ?)
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

  createPersonalMetadataJob(
    gameId: GameId,
    target: Extract<PersonalSyncTarget, 'events' | 'cycles'>,
    requestContext: SyncRequestContext,
    reference = new Date(),
    allowWithoutAgent = false
  ): AiScheduleJob | null {
    this.completeEmptyPersonalMetadataJobs(reference, gameId, target)
    const targets = this.listPersonalMetadataEnrichmentTargets(
      gameId,
      target,
      requestContext.outputLocale,
      reference
    )
    if (targets.length === 0) return null
    const agent = this.getAiScheduleAgentStatus(reference)
    if (!agent.connected && !allowWithoutAgent) return null
    this.requeueStaleAiScheduleJobs(reference)
    const active = this.database.prepare(`
      SELECT id FROM ai_schedule_jobs
      WHERE game_id = ? AND target = ? AND job_kind = 'personal_metadata'
        AND status IN ('pending', 'claimed')
      ORDER BY requested_at ASC LIMIT 1
    `).get(gameId, target) as { id: string } | undefined
    if (active) return this.getAiScheduleJob(active.id)
    const id = randomUUID()
    const now = reference.toISOString()
    this.database.prepare(`
      INSERT INTO ai_schedule_jobs(
        id, game_id, scope, target, user_timezone, output_locale, job_kind, status,
        requested_at, progress_phase, progress_current, progress_total,
        progress_updated_at, message, updated_at
      ) VALUES (?, ?, 'public_schedule', ?, ?, ?, 'personal_metadata', 'pending', ?,
        'queued', 0, ?, ?, '个人清单已建立，等待 Codex 补全标签与时间', ?)
    `).run(
      id,
      gameId,
      target,
      requestContext.userTimeZone,
      requestContext.outputLocale,
      now,
      targets.length,
      now,
      now
    )
    return this.getAiScheduleJob(id)
  }

  preparePersonalReviewJob(
    gameId: GameId,
    target: PersonalSyncTarget,
    accountScope: string,
    items: NormalizedSyncItem[],
    drafts: SemanticReviewDraft[],
    adapterVersion: string,
    requestContext: SyncRequestContext,
    reference = new Date()
  ): { job: AiScheduleJob | null; items: NormalizedSyncItem[] } {
    assertAccountScope(accountScope)
    if (!adapterVersion.trim() || adapterVersion.length > 100) {
      throw new Error('个人数据适配器版本格式不正确')
    }
    const relevant = drafts.filter((draft) => draft.target === target)
    if (relevant.length === 0) return { job: null, items }

    const identities = new Set<string>()
    const reviewedIdentities = new Set<string>()
    const unresolvedIdentities = new Set<string>()
    const reviewTargets: PersonalReviewTarget[] = []
    const cachedItems: NormalizedSyncItem[] = []
    for (const draft of relevant) {
      assertSanitizedSemanticPayload(draft.payload)
      const identity = readSemanticSourceIdentity(draft.kind, draft.payload)
      if (!identity) throw new Error('个人语义异常缺少可审计的官方来源标识')
      const identityKey = `${identity.provider}\u0000${identity.endpoint}\u0000${identity.externalId}`
      if (identities.has(identityKey)) throw new Error('个人语义异常包含重复官方标识')
      identities.add(identityKey)
      reviewedIdentities.add(identityKey)
      const candidateId = randomUUID()
      const cached = this.database.prepare(`
        SELECT resolution_json AS resolutionJson
        FROM personal_review_rules
        WHERE game_id = ? AND provider = ? AND endpoint = ? AND external_id = ?
          AND target = ? AND rule_version = 'personal-review-v3'
      `).get(
        gameId,
        identity.provider,
        identity.endpoint,
        identity.externalId,
        target
      ) as { resolutionJson: string } | undefined
      if (cached) {
        try {
          const resolution = JSON.parse(cached.resolutionJson) as PersonalReviewResolution
          cachedItems.push(...this.materializePersonalReviewResolution(
            target,
            { candidateId, kind: draft.kind, issues: [], payload: draft.payload },
            {
              ...resolution,
              candidateId,
              // The stored boolean was only the observation at review time.
              // Reuse the rule against the current official payload instead.
              completed: undefined
            },
            requestContext.outputLocale
          ))
          continue
        } catch {
          // A stale rule must never block a new official snapshot. Re-review it.
        }
      }
      const rawIssues = Array.isArray(draft.payload.reviewIssues)
        ? draft.payload.reviewIssues.filter((issue): issue is PersonalReviewTarget['issues'][number] =>
            typeof issue === 'string' && [
              'item_identity',
              'classification',
              'completion_semantics',
              'time_window',
              'hierarchy'
            ].includes(issue)
          )
        : []
      reviewTargets.push({
        candidateId,
        kind: draft.kind,
        issues: rawIssues.length > 0 ? [...new Set(rawIssues)] : ['item_identity'],
        payload: draft.payload
      })
      unresolvedIdentities.add(identityKey)
    }

    const baseItems = items.filter((item) => {
      if (!item.sourceIdentity) return true
      const key = `${item.sourceIdentity.provider}\u0000${item.sourceIdentity.endpoint}\u0000${item.sourceIdentity.externalId}`
      return !reviewedIdentities.has(key)
    })
    const resolvedItems = [...baseItems, ...cachedItems]
    if (reviewTargets.length === 0) return { job: null, items: resolvedItems }

    // Authenticated activities are safe to show as a provisional official
    // snapshot once their stable identity and basic shape pass deterministic
    // validation. Lifecycle/classification and completion semantics are refined
    // asynchronously by the review job. Structural map anomalies still block
    // activation because an invalid parent graph cannot be written safely.
    const provisionalItems = target === 'events'
      ? items.filter((item) => {
          if (!item.sourceIdentity) return false
          const key = `${item.sourceIdentity.provider}\u0000${item.sourceIdentity.endpoint}\u0000${item.sourceIdentity.externalId}`
          return unresolvedIdentities.has(key)
        })
      : []

    const active = this.getActiveAiScheduleJob(gameId, target, 'personal_review')
    if (active) throw new Error('该版块仍有同步任务正在处理，请先等待或取消')
    const id = randomUUID()
    const now = reference.toISOString()
    this.runTransaction(() => {
      this.database.prepare(`
        INSERT INTO ai_schedule_jobs(
          id, game_id, scope, target, user_timezone, output_locale, job_kind, status,
          requested_at, progress_phase, progress_current, progress_total,
          progress_updated_at, message, updated_at
        ) VALUES (?, ?, 'public_schedule', ?, ?, ?, 'personal_review', 'pending', ?,
          'queued', 0, ?, ?, ?, ?)
      `).run(
        id,
        gameId,
        target,
        requestContext.userTimeZone,
        requestContext.outputLocale,
        now,
        reviewTargets.length,
        now,
        target === 'events'
          ? '个人活动清单已建立，正在确认活动信息'
          : '个人数据已暂存，正在确认清单结构',
        now
      )
      this.database.prepare(`
        INSERT INTO personal_review_batches(
          job_id, game_id, target, account_scope, adapter_version,
          base_items_json, review_targets_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        gameId,
        target,
        accountScope,
        adapterVersion.trim(),
        stableJson(resolvedItems),
        stableJson(reviewTargets),
        now,
        now
      )
    })
    return {
      job: this.getAiScheduleJob(id),
      items: target === 'events' ? [...resolvedItems, ...provisionalItems] : []
    }
  }

  private completeEmptyPersonalMetadataJobs(
    reference = new Date(),
    gameId?: GameId,
    target?: Extract<PersonalSyncTarget, 'events' | 'cycles'>
  ): number {
    const rows = this.database.prepare(`
      SELECT id FROM ai_schedule_jobs
      WHERE job_kind = 'personal_metadata' AND status IN ('pending', 'claimed')
        ${gameId ? 'AND game_id = ?' : ''}
        ${target ? 'AND target = ?' : ''}
    `).all(...[...(gameId ? [gameId] : []), ...(target ? [target] : [])]) as Array<{ id: string }>
    const now = reference.toISOString()
    let completed = 0
    for (const row of rows) {
      if (this.getAiScheduleJob(row.id).metadataTargets.length > 0) continue
      completed += Number(this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET status = 'completed', completed_at = ?, message = '个人清单元数据已经完整',
            progress_phase = 'completed', progress_current = progress_total,
            progress_updated_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'claimed')
      `).run(now, now, now, row.id).changes)
    }
    return completed
  }

  claimAiScheduleJob(
    agentId: string,
    reference = new Date(),
    jobId?: string,
    route?: { model: string; reasoningEffort: string }
  ): AiScheduleJob | null {
    return this.runTransaction(() => {
      const agent = this.database.prepare('SELECT name FROM ai_schedule_agents WHERE id = ?').get(agentId)
      if (!agent) throw new Error('AI 资料 Agent 尚未登记')
      const now = reference.toISOString()
      this.database.prepare(`UPDATE ai_schedule_agents SET last_seen_at = ?, updated_at = ? WHERE id = ?`)
        .run(now, now, agentId)
      this.requeueStaleAiScheduleJobs(reference)
      const pending = jobId
        ? this.database.prepare(`
            SELECT id FROM ai_schedule_jobs WHERE id = ? AND status = 'pending'
          `).get(jobId) as { id: string } | undefined
        : this.database.prepare(`
            SELECT id FROM ai_schedule_jobs WHERE status = 'pending' ORDER BY requested_at ASC LIMIT 1
          `).get() as { id: string } | undefined
      if (!pending) return null
      const result = this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET status = 'claimed', agent_id = ?, claimed_at = ?,
            attempt_count = attempt_count + 1,
            assigned_model = ?, assigned_reasoning_effort = ?,
            progress_phase = 'searching', progress_current = 0,
            progress_total = NULL, progress_updated_at = ?,
            message = 'Codex 已接单，正在准备处理', updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(
        agentId,
        now,
        route?.model ?? null,
        route?.reasoningEffort ?? null,
        now,
        now,
        pending.id
      )
      if (result.changes === 0) return null
      const claimed = this.getAiScheduleJob(pending.id)
      this.database.prepare(`
        INSERT INTO ai_schedule_job_attempts(
          id, job_id, attempt_number, routing_tier, model, reasoning_effort,
          agent_id, started_at, outcome
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')
      `).run(
        randomUUID(),
        claimed.id,
        claimed.attemptCount,
        claimed.routingTier,
        route?.model ?? 'inherit',
        route?.reasoningEffort ?? 'inherit',
        agentId,
        now
      )
      return claimed
    })
  }

  getActiveAiScheduleJob(
    gameId: GameId,
    target?: SyncTarget,
    jobKind?: AiScheduleJobKind
  ): AiScheduleJob | null {
    const targetFilter = target ? ' AND target = ?' : ''
    const kindFilter = jobKind ? ' AND job_kind = ?' : ''
    const parameters = [gameId, ...(target ? [target] : []), ...(jobKind ? [jobKind] : [])]
    const row = this.database.prepare(`
      SELECT id FROM ai_schedule_jobs
      WHERE game_id = ? AND status IN ('pending', 'claimed')
        ${targetFilter}
        ${kindFilter}
      ORDER BY requested_at ASC LIMIT 1
    `).get(...parameters) as { id: string } | undefined
    return row ? this.getAiScheduleJob(row.id) : null
  }

  getAiScheduleJobById(id: string): AiScheduleJob {
    return this.getAiScheduleJob(id)
  }

  cancelActiveAiScheduleJob(
    gameId: GameId,
    target: SyncTarget,
    reference = new Date(),
    jobKind?: AiScheduleJobKind
  ): { job: AiScheduleJob; agentId: string | null } | null {
    return this.runTransaction(() => {
      const active = this.getActiveAiScheduleJob(gameId, target, jobKind)
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
      if (active.jobKind === 'public_catalog') {
        this.recordSyncOutcome(gameId, 'stale', '用户已取消', false, reference)
        this.recordSyncTargetAttempt(gameId, target, 'stale', reference)
      }
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

  updateAiScheduleJobLaunchMessage(
    jobId: string,
    message: string,
    current: number | null = null,
    total: number | null = null,
    phase: SyncProgressPhase = 'queued',
    reference = new Date()
  ): number {
    if (!message.trim()) throw new Error('同步进度说明不能为空')
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET progress_phase = ?,
          progress_current = ?, progress_total = ?, progress_updated_at = ?,
          message = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'claimed')
    `).run(phase, current, total, now, message.trim(), now, jobId)
    return Number(result.changes)
  }

  failPendingAiScheduleJobs(message: string, reference = new Date()): number {
    if (!message.trim()) throw new Error('同步失败说明不能为空')
    const now = reference.toISOString()
    const jobs = this.database.prepare(`
      SELECT id, game_id AS gameId, target, job_kind AS jobKind
      FROM ai_schedule_jobs WHERE status = 'pending'
    `).all() as Array<{
      id: string
      gameId: GameId
      target: SyncTarget
      jobKind: AiScheduleJobKind
    }>
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
        if (result.changes > 0 && job.jobKind === 'public_catalog') {
          this.recordSyncOutcome(job.gameId, 'error', message.trim(), false, reference)
          this.recordSyncTargetAttempt(job.gameId, job.target, 'error', reference)
        }
      }
    })
    return jobs.length
  }

  failPendingAiScheduleJob(jobId: string, message: string, reference = new Date()): AiScheduleJob {
    if (!message.trim()) throw new Error('同步失败说明不能为空')
    const pending = this.getAiScheduleJob(jobId)
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'failed', completed_at = ?, message = ?,
          progress_phase = 'failed', progress_current = NULL,
          progress_total = NULL, progress_updated_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, message.trim(), now, now, jobId)
    if (result.changes === 0) throw new Error('待处理的 AI 资料任务不存在或已经被领取')
    const failed = this.getAiScheduleJob(jobId)
    if (pending.jobKind === 'public_catalog') {
      this.recordSyncOutcome(pending.gameId, 'error', message.trim(), false, reference)
      this.recordSyncTargetAttempt(pending.gameId, pending.target, 'error', reference)
    }
    return failed
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
    this.completeEmptyPersonalMetadataJobs(reference)
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
    if (job.jobKind !== 'public_catalog') {
      throw new Error('个人清单元数据任务必须使用专用提交接口')
    }
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
      item.activityTags !== undefined &&
      (
        !Array.isArray(item.activityTags) ||
        (item.activityTags.length > 0 && !activityTagsMeetQualityContract(item.activityTags))
      )
    )
    if (invalidEventTags) {
      throw new Error(
        `活动“${invalidEventTags.title}”提交的玩法标签无效；没有可靠依据时应留空`
      )
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
        if (!Array.isArray(update.activityTags) ||
          !activityTagsMeetQualityContract(update.activityTags, job.requestContext.outputLocale)) {
          throw new Error(
            `活动“${update.title}”必须提供 ${MIN_AI_ACTIVITY_TAGS} 到 ${MAX_AI_ACTIVITY_TAGS} 个有证据、含核心玩法的标签`
          )
        }
        const tags = normalizeActivityTags(update.activityTags, job.requestContext.outputLocale)
        if (!activityTagsMeetQualityContract(tags, job.requestContext.outputLocale)) {
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
      for (const coveredTarget of coveredTargets) {
        if (coveredTarget !== 'tasks') {
          this.activateChecklistSourceInTransaction(
            job.gameId,
            coveredTarget,
            'public_schedule'
          )
        }
      }
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
      const removeSyncedItem = this.database.prepare(`
        DELETE FROM checklist_items
        WHERE id = ? AND game_id = ? AND archived = 0 AND source <> 'manual'
      `)
      let archived = 0
      for (const decision of archiveItems) {
        const result = removeSyncedItem.run(decision.itemId, job.gameId)
        if (result.changes !== 1) throw new Error('待删除的同步事项已不存在或不允许删除')
        archived += 1
      }
      this.assertActiveMapReferences(job.gameId)
      return { merge: result, archived }
    })
    const unresolvedActivityCount = (job.target === 'events' || job.target === 'all')
      ? this.listActivityTagEnrichmentTargets(
          job.gameId,
          now,
          job.requestContext.outputLocale
        ).length
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

  applyPersonalMetadataJob(
    jobId: string,
    agentId: string,
    updates: PersonalMetadataUpdate[],
    evidence: unknown,
    contentLocale: string,
    reference = new Date()
  ): {
    job: AiScheduleJob
    updated: number
    expiredRemoved: number
    unresolved: number
  } {
    const job = this.getAiScheduleJob(jobId)
    if (job.jobKind !== 'personal_metadata') throw new Error('当前任务不是个人清单元数据补全任务')
    if (job.status !== 'claimed' || job.agentId !== agentId) {
      throw new Error('AI 资料任务未由当前 Agent 领取或已经结束')
    }
    if (contentLocale !== job.requestContext.outputLocale) {
      throw new Error('提交内容语言与接口请求语言不一致')
    }
    const requiredById = new Map(job.metadataTargets.map((target) => [target.itemId, target]))
    if (requiredById.size === 0) throw new Error('本次个人清单没有待补全元数据')
    const submittedIds = new Set<string>()
    for (const update of updates) {
      const target = requiredById.get(update.itemId)
      if (!target) throw new Error(`元数据目标“${update.title}”不在本次待补全清单中`)
      if (submittedIds.has(update.itemId)) throw new Error(`事项“${update.title}”重复提交元数据`)
      submittedIds.add(update.itemId)
      if (update.title !== target.title) throw new Error(`元数据目标“${update.title}”已经变化`)
      if (!Number.isFinite(update.confidence) || update.confidence < 0 || update.confidence > 1) {
        throw new Error(`事项“${update.title}”的置信度格式不正确`)
      }
      try {
        const url = new URL(update.sourceUrl)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
      } catch {
        throw new Error(`事项“${update.title}”缺少有效核验来源`)
      }
      const unresolved = new Set(update.unresolvedFields ?? [])
      if ([...unresolved].some((field) => !target.missingFields.includes(field))) {
        throw new Error(`事项“${update.title}”提交了未请求的 unresolvedFields`)
      }
      if (update.activityTags !== undefined && !target.missingFields.includes('activityTags')) {
        throw new Error(`事项“${update.title}”不允许改写已有活动标签`)
      }
      if (update.startsAt !== undefined && !target.missingFields.includes('startsAt')) {
        throw new Error(`事项“${update.title}”不允许改写已有开始时间`)
      }
      if (update.endsAt !== undefined && !target.missingFields.includes('endsAt')) {
        throw new Error(`事项“${update.title}”不允许改写已有结束时间`)
      }
      for (const field of target.missingFields) {
        if (field === 'activityTags') {
          if (unresolved.has(field)) continue
          const tags = normalizeActivityTags(update.activityTags ?? [], contentLocale)
          if (!activityTagsMeetQualityContract(tags, contentLocale)) {
            throw new Error(
              `活动“${update.title}”必须提供 ${MIN_AI_ACTIVITY_TAGS} 到 ${MAX_AI_ACTIVITY_TAGS} 个有证据、含核心玩法的有效标签`
            )
          }
          assertActivityTagEvidence(
            update.title,
            tags,
            update.activityTagEvidence,
            contentLocale
          )
        } else if ((update[field] === undefined || update[field] === null) && !unresolved.has(field)) {
          throw new Error(`事项“${update.title}”遗漏字段 ${field}`)
        }
      }
      if (unresolved.size > 0 && !update.unresolvedReason?.trim()) {
        throw new Error(`事项“${update.title}”的未确认字段必须说明原因`)
      }
      if (
        target.category === 'endgame' &&
        (unresolved.has('startsAt') || unresolved.has('endsAt'))
      ) {
        throw new Error(`周期挑战“${update.title}”必须补齐当前期完整时间，不能提交未知时间`)
      }
      for (const field of ['startsAt', 'endsAt'] as const) {
        const value = update[field]
        if (value === undefined || value === null) continue
        if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) || Number.isNaN(Date.parse(value))) {
          throw new Error(`事项“${update.title}”的 ${field} 必须是带时区的绝对时间`)
        }
      }
      if (target.category === 'endgame') {
        const startsAt = update.startsAt ?? target.startsAt
        const endsAt = update.endsAt ?? target.endsAt
        if (!startsAt || !endsAt) {
          throw new Error(`周期挑战“${update.title}”必须补齐当前期完整起止时间`)
        }
        if (
          Date.parse(startsAt) > reference.getTime() ||
          Date.parse(endsAt) <= reference.getTime()
        ) {
          throw new Error(`周期挑战“${update.title}”必须提交当前正在进行的一期，不能提交过期或未来周期`)
        }
      }
    }
    const missingUpdates = job.metadataTargets.filter((target) => !submittedIds.has(target.itemId))
    if (missingUpdates.length > 0) {
      throw new Error(`个人元数据补全遗漏 ${missingUpdates.length} 项`)
    }

    const now = reference.toISOString()
    let updated = 0
    let expiredRemoved = 0
    let unresolved = 0
    this.runTransaction(() => {
      for (const update of updates) {
        const target = requiredById.get(update.itemId)!
        const current = this.database.prepare(`
          SELECT title, category, activity_tags_json AS activityTagsJson,
            starts_at AS startsAt, ends_at AS endsAt, source_url AS sourceUrl
          FROM checklist_items
          WHERE id = ? AND game_id = ? AND source = 'personal_sync' AND archived = 0
        `).get(update.itemId, job.gameId) as {
          title: string
          category: Extract<ChecklistCategory, 'limited_event' | 'endgame'>
          activityTagsJson: string
          startsAt: string | null
          endsAt: string | null
          sourceUrl: string | null
        } | undefined
        if (!current || current.title !== target.title || current.category !== target.category) continue
        let currentTags: string[] = []
        try {
          const parsed = JSON.parse(current.activityTagsJson)
          if (Array.isArray(parsed)) {
            currentTags = parsed.filter((tag): tag is string => typeof tag === 'string')
          }
        } catch {
          currentTags = []
        }
        const unresolvedFields = new Set(update.unresolvedFields ?? [])
        const activityTags = target.missingFields.includes('activityTags') &&
          !unresolvedFields.has('activityTags')
          ? normalizeActivityTags(update.activityTags ?? [], contentLocale)
          : normalizeActivityTags(currentTags, contentLocale)
        const startsAt = target.missingFields.includes('startsAt') && update.startsAt !== undefined
          ? update.startsAt
          : current.startsAt
        const endsAt = target.missingFields.includes('endsAt') && update.endsAt !== undefined
          ? update.endsAt
          : current.endsAt
        this.assertTimeWindow(startsAt, endsAt)
        const cacheItem: NormalizedSyncItem = {
          remoteKey: `metadata:${target.sourceIdentity.externalId}`,
          category: current.category,
          title: current.title,
          activityTags,
          startsAt,
          endsAt,
          sourceUrl: update.sourceUrl,
          sourceIdentity: target.sourceIdentity
        }
        this.cachePersonalMetadata(
          job.gameId,
          cacheItem,
          contentLocale,
          now,
          update.confidence
        )
        if (endsAt && Date.parse(endsAt) <= reference.getTime()) {
          this.database.prepare(`
            INSERT INTO personal_expiry_tombstones(
              game_id, provider, endpoint, external_id, category, expired_ends_at, observed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(game_id, provider, endpoint, external_id) DO UPDATE SET
              category = excluded.category,
              expired_ends_at = excluded.expired_ends_at,
              observed_at = excluded.observed_at
          `).run(
            job.gameId,
            target.sourceIdentity.provider,
            target.sourceIdentity.endpoint,
            target.sourceIdentity.externalId,
            current.category,
            endsAt,
            now
          )
          expiredRemoved += Number(this.database.prepare(`
            DELETE FROM checklist_items
            WHERE id = ? AND game_id = ? AND source = 'personal_sync'
          `).run(update.itemId, job.gameId).changes)
        } else {
          const result = this.database.prepare(`
            UPDATE checklist_items
            SET activity_tags_json = ?, starts_at = ?, ends_at = ?,
                source_url = COALESCE(source_url, ?), last_synced_at = ?, updated_at = ?
            WHERE id = ? AND game_id = ? AND source = 'personal_sync' AND archived = 0
          `).run(
            JSON.stringify(current.category === 'limited_event' ? activityTags : []),
            startsAt,
            endsAt,
            update.sourceUrl,
            now,
            now,
            update.itemId,
            job.gameId
          )
          updated += Number(result.changes)
          if (current.category === 'endgame' && startsAt && endsAt) {
            // A verified current window is the only point at which an expiry
            // tombstone for a stable provider identity may be released.
            this.database.prepare(`
              DELETE FROM personal_expiry_tombstones
              WHERE game_id = ? AND provider = ? AND endpoint = ? AND external_id = ?
            `).run(
              job.gameId,
              target.sourceIdentity.provider,
              target.sourceIdentity.endpoint,
              target.sourceIdentity.externalId
            )
          }
        }
        unresolved += update.unresolvedFields?.length ?? 0
      }
      const message = `个人清单元数据补全完成：更新 ${updated}，淘汰到期 ${expiredRemoved}${
        unresolved > 0 ? `，仍有 ${unresolved} 个时间字段无法可靠确认` : ''
      }`
      this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET status = 'completed', completed_at = ?, evidence_json = ?, message = ?,
            progress_phase = 'completed', progress_current = progress_total,
            progress_updated_at = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed' AND agent_id = ?
      `).run(now, JSON.stringify(evidence), message, now, now, jobId, agentId)
      // The MCP worker opens the same database in a separate process. Its
      // startup reconciliation marks an active metadata job as idle/syncing.
      // Once the bounded metadata write commits, settle the section back to a
      // successful terminal state so the renderer does not remain on “同步中”.
      this.recordSyncTargetSuccess(job.gameId, job.target, reference)
    })
    return {
      job: this.getAiScheduleJob(jobId),
      updated,
      expiredRemoved,
      unresolved
    }
  }

  applyPersonalReviewJob(
    jobId: string,
    agentId: string,
    resolutions: PersonalReviewResolution[],
    evidence: unknown,
    contentLocale: string,
    reference = new Date()
  ): { job: AiScheduleJob; merge: SyncMergeResult } {
    const job = this.getAiScheduleJob(jobId)
    if (job.jobKind !== 'personal_review') {
      throw new Error('当前任务不是个人数据异常核验任务')
    }
    if (job.status !== 'claimed' || job.agentId !== agentId) {
      throw new Error('个人数据异常任务未由当前 Agent 领取或已经结束')
    }
    if (contentLocale !== job.requestContext.outputLocale) {
      throw new Error('提交内容语言与接口请求语言不一致')
    }
    const batch = this.database.prepare(`
      SELECT account_scope AS accountScope, adapter_version AS adapterVersion,
        base_items_json AS baseItemsJson, review_targets_json AS reviewTargetsJson
      FROM personal_review_batches WHERE job_id = ?
    `).get(jobId) as {
      accountScope: string
      adapterVersion: string
      baseItemsJson: string
      reviewTargetsJson: string
    } | undefined
    if (!batch) throw new Error('个人数据异常暂存批次不存在')
    const targets = JSON.parse(batch.reviewTargetsJson) as PersonalReviewTarget[]
    const baseItems = JSON.parse(batch.baseItemsJson) as NormalizedSyncItem[]
    const targetIds = new Set(targets.map((target) => target.candidateId))
    if (targetIds.size !== targets.length || resolutions.length !== targets.length) {
      throw new Error('必须逐项提交本批次全部个人数据异常')
    }
    const resolutionById = new Map<string, PersonalReviewResolution>()
    for (const resolution of resolutions) {
      if (!targetIds.has(resolution.candidateId) || resolutionById.has(resolution.candidateId)) {
        throw new Error('个人数据异常提交包含未知或重复 candidateId')
      }
      resolutionById.set(resolution.candidateId, resolution)
    }
    const resolvedItems: NormalizedSyncItem[] = []
    for (const target of targets) {
      resolvedItems.push(...this.materializePersonalReviewResolution(
        job.target as PersonalSyncTarget,
        target,
        resolutionById.get(target.candidateId)!,
        contentLocale
      ))
    }
    const finalItems = [...baseItems, ...resolvedItems]
    if (job.target === 'exploration') {
      const titleByRemoteKey = new Map(finalItems.map((item) => [item.remoteKey, item.title]))
      for (const item of finalItems) {
        if (item.category !== 'exploration' || item.mapNodeKind !== 'subregion') continue
        item.parentTitle = item.parentRemoteKey
          ? titleByRemoteKey.get(item.parentRemoteKey) ?? item.parentTitle ?? null
          : null
      }
    }
    const now = reference.toISOString()
    const merge = this.runTransaction(() => {
      for (const target of targets) {
        const resolution = resolutionById.get(target.candidateId)!
        const identity = readSemanticSourceIdentity(target.kind, target.payload)
        if (!identity) throw new Error('个人语义异常缺少可缓存的官方身份')
        this.database.prepare(`
          INSERT INTO personal_review_rules(
            game_id, provider, endpoint, external_id, target, rule_version,
            resolution_json, evidence_json, confidence, verified_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'personal-review-v3', ?, ?, ?, ?, ?)
          ON CONFLICT(game_id, provider, endpoint, external_id, target) DO UPDATE SET
            rule_version = excluded.rule_version,
            resolution_json = excluded.resolution_json,
            evidence_json = excluded.evidence_json,
            confidence = excluded.confidence,
            verified_at = excluded.verified_at,
            updated_at = excluded.updated_at
        `).run(
          job.gameId,
          identity.provider,
          identity.endpoint,
          identity.externalId,
          job.target,
          stableJson(resolution),
          stableJson(evidence),
          resolution.confidence,
          now,
          now
        )
      }
      const replaced = this.replacePersonalSnapshot(
        job.gameId,
        job.target as PersonalSyncTarget,
        batch.accountScope,
        finalItems,
        batch.adapterVersion,
        reference,
        job.requestContext,
        false
      )
      this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET status = 'completed', completed_at = ?, evidence_json = ?,
            message = ?, progress_phase = 'completed',
            progress_current = progress_total, progress_updated_at = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed' AND agent_id = ?
      `).run(
        now,
        stableJson(evidence),
        `个人数据异常核验完成：处理 ${targets.length} 项`,
        now,
        now,
        jobId,
        agentId
      )
      return replaced
    })
    return { job: this.getAiScheduleJob(jobId), merge }
  }

  private materializePersonalReviewResolution(
    target: PersonalSyncTarget,
    review: PersonalReviewTarget,
    resolution: PersonalReviewResolution,
    outputLocale: string
  ): NormalizedSyncItem[] {
    if (!resolution.reason.trim() || resolution.reason.length > 500) {
      throw new Error('个人数据异常决定必须包含简洁理由')
    }
    if (!Number.isFinite(resolution.confidence) || resolution.confidence < 0 || resolution.confidence > 1) {
      throw new Error('个人数据异常决定的置信度格式不正确')
    }
    if (target === 'events') {
      if (!resolution.eventScope) {
        throw new Error('个人活动异常必须明确 limited、permanent 或 unknown 生命周期')
      }
      if (resolution.eventScope === 'limited' && resolution.decision !== 'include') {
        throw new Error('已确认的限时活动必须使用 include')
      }
      if (resolution.eventScope !== 'limited' && resolution.decision !== 'exclude') {
        throw new Error('常驻或仍无法确认的内容不能进入限时活动清单')
      }
    }
    if (resolution.decision === 'exclude') return []
    const identity = readSemanticSourceIdentity(review.kind, review.payload)
    if (!identity) throw new Error('个人数据异常缺少官方来源标识')
    const proposed = review.payload.proposedItem &&
      typeof review.payload.proposedItem === 'object' &&
      !Array.isArray(review.payload.proposedItem)
      ? review.payload.proposedItem as Partial<NormalizedSyncItem>
      : {}
    const officialTitle = typeof review.payload.title === 'string'
      ? review.payload.title.trim()
      : typeof review.payload.officialTitle === 'string'
        ? review.payload.officialTitle.trim()
        : ''
    const title = officialTitle || resolution.title?.trim() || proposed.title?.trim() || ''
    if (!title) throw new Error('Codex 必须为保留的个人事项提交名称')

    if (target === 'events') {
      const activityTags = normalizeActivityTags(resolution.activityTags ?? [], outputLocale)
      if (activityTags.length > 0 && !activityTagsMeetQualityContract(activityTags, outputLocale)) {
        throw new Error(
          `个人活动“${title}”若在异常审核中提交标签，必须提供 ${MIN_AI_ACTIVITY_TAGS} 到 ${MAX_AI_ACTIVITY_TAGS} 个有证据、含核心玩法的标签；也可省略并交给后续元数据任务`
        )
      }
      let completed: boolean | undefined
      if (resolution.completionRule) {
        assertPersonalCompletionRule(resolution.completionRule)
        const state = readPersonalDraftState(
          { target: 'events', kind: review.kind, payload: review.payload },
          resolution.completionRule
        )
        if (state) completed = state.completionState === 'completed'
      }
      if (resolution.completed !== undefined && completed !== resolution.completed) {
        throw new Error(`活动“${title}”的完成规则无法机械复现提交状态`)
      }
      return [{
        remoteKey: proposed.remoteKey ??
          `personal-event:${identity.provider}:${identity.endpoint}:${identity.externalId}`,
        category: 'limited_event',
        title,
        activityTags,
        completed,
        startsAt: proposed.startsAt ?? resolution.startsAt ?? null,
        endsAt: proposed.endsAt ?? resolution.endsAt ?? null,
        scheduleKind: 'fixed_window',
        modeKey: proposed.modeKey ?? resolution.modeKey ?? `official-event-${identity.externalId}`,
        sourceUrl: resolution.sourceUrl ?? proposed.sourceUrl ?? null,
        sourceIdentity: identity
      }]
    }

    if (target === 'exploration') {
      const progress = review.payload.observedProgress
      if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 100) {
        throw new Error(`个人地图“${title}”缺少可信探索度`)
      }
      const mapNodeKind = resolution.mapNodeKind ?? proposed.mapNodeKind
      if (mapNodeKind !== 'region' && mapNodeKind !== 'subregion') {
        throw new Error(`个人地图“${title}”缺少一级/二级层级决定`)
      }
      const parentExternalId = resolution.parentExternalId ?? (
        typeof review.payload.observedParentId === 'string' ||
        typeof review.payload.observedParentId === 'number'
          ? String(review.payload.observedParentId).trim()
          : null
      )
      if (mapNodeKind === 'region' && parentExternalId) {
        throw new Error(`一级地图“${title}”不能包含父级`)
      }
      if (mapNodeKind === 'subregion' && !parentExternalId) {
        throw new Error(`二级地图“${title}”必须提交一级父地区官方 ID`)
      }
      return [{
        remoteKey: `personal-map:${identity.provider}:${identity.externalId}`,
        category: 'exploration',
        title,
        completed: progress === 100,
        progressPercent: progress,
        parentTitle: typeof review.payload.observedParentTitle === 'string'
          ? review.payload.observedParentTitle.trim() || null
          : null,
        mapNodeKind,
        parentRemoteKey: mapNodeKind === 'subregion'
          ? `personal-map:${identity.provider}:${parentExternalId}`
          : null,
        modeKey: resolution.modeKey ?? `official-map-${identity.externalId}`,
        sourceUrl: resolution.sourceUrl ?? null,
        sourceIdentity: identity
      }]
    }

    const observed = readPersonalDraftState(
      { target: 'cycles', kind: review.kind, payload: review.payload }
    )
    const completed = observed
      ? observed.completionState === 'completed'
      : resolution.completed
    if (typeof completed !== 'boolean') {
      throw new Error(`个人周期事项“${title}”缺少可信挑战记录语义`)
    }
    const modeKey = resolution.modeKey?.trim() || proposed.modeKey?.trim() || ''
    if (!modeKey) throw new Error(`个人周期事项“${title}”缺少稳定模式标识`)
    return [{
      remoteKey: proposed.remoteKey ??
        `personal-cycle:${identity.provider}:${identity.endpoint}:${identity.externalId}`,
      category: 'endgame',
      title,
      completed,
      startsAt: proposed.startsAt ?? resolution.startsAt ?? null,
      endsAt: proposed.endsAt ?? resolution.endsAt ?? null,
      periodKey: proposed.periodKey ?? resolution.periodKey ?? null,
      scheduleKind: 'remote_schedule',
      modeKey,
      sourceUrl: resolution.sourceUrl ?? proposed.sourceUrl ?? null,
      sourceIdentity: identity
    }]
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
    if (job.jobKind === 'public_catalog') {
      this.recordSyncOutcome(job.gameId, 'error', message, false)
      this.recordSyncTargetAttempt(job.gameId, job.target, 'error', reference)
    }
    return job
  }

  requeueAiScheduleJobAttempt(
    jobId: string,
    agentId: string,
    failureKind: 'timeout' | 'infrastructure_error' | 'semantic_unresolved',
    message: string,
    reference = new Date()
  ): AiScheduleJob {
    const job = this.getAiScheduleJob(jobId)
    if (job.status !== 'claimed' || job.agentId !== agentId) return job
    const attemptsAtTier = this.database.prepare(`
      SELECT COUNT(*) AS count FROM ai_schedule_job_attempts
      WHERE job_id = ? AND routing_tier = ?
    `).get(jobId, job.routingTier) as { count: number }
    const currentTierAttempts = Number(attemptsAtTier.count)
    const now = reference.toISOString()
    const fixedRetryAllowed = failureKind === 'infrastructure_error' && currentTierAttempts < 2
    const exhausted = !fixedRetryAllowed
    this.database.prepare(`
      UPDATE ai_schedule_job_attempts
      SET completed_at = ?, outcome = ?, message = ?
      WHERE job_id = ? AND agent_id = ? AND outcome = 'running'
    `).run(
      now,
      exhausted ? 'failed' : failureKind,
      message.trim(),
      jobId,
      agentId
    )
    if (exhausted) {
      this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET status = 'failed', completed_at = ?, agent_id = NULL,
            message = ?, progress_phase = 'failed', progress_updated_at = ?,
            last_failure_kind = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed' AND agent_id = ?
      `).run(
        now,
        `当前配置未能完成：${message.trim()}`,
        now,
        failureKind,
        now,
        jobId,
        agentId
      )
    } else {
      const routeMessage = `连接或工具异常，正在使用当前配置重试 ${currentTierAttempts + 1}/2：${message.trim()}`
      this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET status = 'pending', agent_id = NULL, claimed_at = NULL,
            routing_tier = ?, assigned_model = NULL,
            assigned_reasoning_effort = NULL,
            message = ?, progress_phase = 'retrying', progress_current = NULL,
            progress_total = NULL, progress_updated_at = ?,
            last_failure_kind = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed' AND agent_id = ?
      `).run(
        job.routingTier,
        routeMessage,
        now,
        failureKind,
        now,
        jobId,
        agentId
      )
    }
    const updated = this.getAiScheduleJob(jobId)
    if (updated.status === 'failed' && updated.jobKind === 'public_catalog') {
      this.recordSyncOutcome(updated.gameId, 'error', updated.message ?? message, false, reference)
      this.recordSyncTargetAttempt(updated.gameId, updated.target, 'error', reference)
    }
    return updated
  }

  recordAiScheduleJobLaunchFailure(
    jobId: string,
    agentId: string,
    route: { model: string; reasoningEffort: string; startedAt: string },
    failureKind: 'timeout' | 'infrastructure_error',
    message: string,
    reference = new Date()
  ): AiScheduleJob {
    const job = this.getAiScheduleJob(jobId)
    if (job.status !== 'pending') return job
    const priorAttemptsAtTier = this.database.prepare(`
      SELECT COUNT(*) AS count FROM ai_schedule_job_attempts
      WHERE job_id = ? AND routing_tier = ?
    `).get(jobId, job.routingTier) as { count: number }
    const currentTierAttempts = Number(priorAttemptsAtTier.count) + 1
    const fixedRetryAllowed = failureKind === 'infrastructure_error' && currentTierAttempts < 2
    const exhausted = !fixedRetryAllowed
    const now = reference.toISOString()
    const attemptNumber = job.attemptCount + 1
    this.database.prepare(`
      INSERT INTO ai_schedule_job_attempts(
        id, job_id, attempt_number, routing_tier, model, reasoning_effort,
        agent_id, started_at, completed_at, outcome, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      jobId,
      attemptNumber,
      job.routingTier,
      route.model,
      route.reasoningEffort,
      agentId,
      route.startedAt,
      now,
      exhausted ? 'failed' : failureKind,
      message.trim()
    )
    if (exhausted) {
      this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET status = 'failed', completed_at = ?, attempt_count = ?,
            message = ?, progress_phase = 'failed', progress_updated_at = ?,
            last_failure_kind = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(
        now,
        attemptNumber,
        `当前配置未能启动：${message.trim()}`,
        now,
        failureKind,
        now,
        jobId
      )
    } else {
      const routeMessage = `连接或工具异常，正在使用当前配置重试 ${currentTierAttempts + 1}/2：${message.trim()}`
      this.database.prepare(`
        UPDATE ai_schedule_jobs
        SET attempt_count = ?, routing_tier = ?, assigned_model = NULL,
            assigned_reasoning_effort = NULL, message = ?,
            progress_phase = 'retrying', progress_current = NULL,
            progress_total = NULL, progress_updated_at = ?,
            last_failure_kind = ?, updated_at = ?
        WHERE id = ? AND status = 'pending'
      `).run(
        attemptNumber,
        job.routingTier,
        routeMessage,
        now,
        failureKind,
        now,
        jobId
      )
    }
    const updated = this.getAiScheduleJob(jobId)
    if (updated.status === 'failed' && updated.jobKind === 'public_catalog') {
      this.recordSyncOutcome(updated.gameId, 'error', updated.message ?? message, false, reference)
      this.recordSyncTargetAttempt(updated.gameId, updated.target, 'error', reference)
    }
    return updated
  }

  getAiScheduleJobAttemptRuntimeMs(
    jobId: string,
    reference = new Date()
  ): number {
    const rows = this.database.prepare(`
      SELECT started_at AS startedAt, completed_at AS completedAt
      FROM ai_schedule_job_attempts
      WHERE job_id = ?
    `).all(jobId) as Array<{ startedAt: string; completedAt: string | null }>
    const referenceTime = reference.getTime()
    return rows.reduce((total, row) => {
      const startedAt = Date.parse(row.startedAt)
      const completedAt = row.completedAt ? Date.parse(row.completedAt) : referenceTime
      if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) return total
      return total + Math.max(0, completedAt - startedAt)
    }, 0)
  }

  expireAiScheduleJob(
    jobId: string,
    message: string,
    reference = new Date()
  ): { job: AiScheduleJob; agentId: string | null } {
    const job = this.getAiScheduleJob(jobId)
    if (job.status !== 'pending' && job.status !== 'claimed') {
      return { job, agentId: job.agentId }
    }
    const now = reference.toISOString()
    this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'failed', completed_at = ?, message = ?,
          progress_phase = 'failed', progress_updated_at = ?,
          last_failure_kind = 'total_budget_exceeded', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'claimed')
    `).run(now, message.trim(), now, now, jobId)
    const updated = this.getAiScheduleJob(jobId)
    if (updated.jobKind === 'public_catalog') {
      this.recordSyncOutcome(updated.gameId, 'error', message.trim(), false, reference)
      this.recordSyncTargetAttempt(updated.gameId, updated.target, 'error', reference)
    }
    return { job: updated, agentId: job.agentId }
  }

  private getAiScheduleJob(id: string): AiScheduleJob {
    const row = this.database.prepare(`
      SELECT j.id, j.game_id AS gameId, j.scope, j.target, j.job_kind AS jobKind,
        j.user_timezone AS userTimeZone, j.output_locale AS outputLocale, j.status,
        j.requested_at AS requestedAt, j.claimed_at AS claimedAt,
        j.completed_at AS completedAt, j.agent_id AS agentId,
        a.name AS agentName, j.message,
        j.progress_phase AS progressPhase,
        j.progress_current AS progressCurrent,
        j.progress_total AS progressTotal,
        j.progress_updated_at AS progressUpdatedAt,
        j.routing_tier AS routingTier,
        j.attempt_count AS attemptCount,
        j.assigned_model AS assignedModel,
        j.assigned_reasoning_effort AS assignedReasoningEffort,
        j.last_failure_kind AS lastFailureKind
      FROM ai_schedule_jobs j
      LEFT JOIN ai_schedule_agents a ON a.id = j.agent_id
      WHERE j.id = ?
    `).get(id) as Omit<
      AiScheduleJob,
      'activityTagTargets' | 'metadataTargets' | 'reviewTargets' |
      'matchCandidates' | 'contract' | 'requestContext'
    > | undefined
    if (!row) throw new Error('AI 资料任务不存在')
    const activityTagTargets = row.jobKind === 'public_catalog' && (
      row.status === 'pending' || row.status === 'claimed'
    ) && (row.target === 'events' || row.target === 'all')
      ? this.listActivityTagEnrichmentTargets(row.gameId, row.requestedAt, row.outputLocale)
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
    const matchCandidates = row.jobKind === 'public_catalog' ? this.listChecklistItems(row.gameId)
      .filter((item) =>
        item.source === 'public_schedule' &&
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
      })) : []
    const metadataTargets = row.jobKind === 'personal_metadata' &&
      (row.status === 'pending' || row.status === 'claimed') &&
      (row.target === 'events' || row.target === 'cycles')
      ? this.listPersonalMetadataEnrichmentTargets(
          row.gameId,
          row.target,
          row.outputLocale,
          new Date(row.requestedAt)
        )
      : []
    const reviewTargets = row.jobKind === 'personal_review' &&
      (row.status === 'pending' || row.status === 'claimed')
      ? this.readPersonalReviewTargets(row.id)
      : []
    return {
      ...row,
      requestContext: {
        outputLocale: row.outputLocale,
        userTimeZone: row.userTimeZone
      },
      activityTagTargets,
      metadataTargets,
      reviewTargets,
      matchCandidates,
      contract: row.jobKind === 'personal_review' &&
        (row.target === 'events' || row.target === 'cycles' || row.target === 'exploration')
        ? getPersonalReviewContract(row.target, {
            outputLocale: row.outputLocale,
            userTimeZone: row.userTimeZone
          })
        : row.jobKind === 'personal_metadata' &&
          (row.target === 'events' || row.target === 'cycles')
          ? getPersonalMetadataContract(row.target, {
            outputLocale: row.outputLocale,
            userTimeZone: row.userTimeZone
          })
        : getPublicSyncContract(row.target, {
            outputLocale: row.outputLocale,
            userTimeZone: row.userTimeZone
          })
    }
  }

  private readPersonalReviewTargets(jobId: string): PersonalReviewTarget[] {
    const row = this.database.prepare(`
      SELECT review_targets_json AS reviewTargetsJson
      FROM personal_review_batches WHERE job_id = ?
    `).get(jobId) as { reviewTargetsJson: string } | undefined
    if (!row) return []
    const value = JSON.parse(row.reviewTargetsJson) as unknown
    if (!Array.isArray(value)) throw new Error('个人数据异常暂存格式不正确')
    return value as PersonalReviewTarget[]
  }

  private listPersonalMetadataEnrichmentTargets(
    gameId: GameId,
    target: Extract<PersonalSyncTarget, 'events' | 'cycles'>,
    outputLocale: string,
    reference = new Date()
  ): PersonalMetadataEnrichmentTarget[] {
    const category = target === 'events' ? 'limited_event' : 'endgame'
    const rows = this.database.prepare(`
      SELECT i.id AS itemId, i.title, i.category,
        i.activity_tags_json AS activityTagsJson,
        i.starts_at AS startsAt, i.ends_at AS endsAt,
        i.mode_key AS modeKey,
        b.provider, b.endpoint, b.external_id AS externalId
      FROM checklist_items i
      INNER JOIN source_bindings b ON b.game_id = i.game_id AND b.item_id = i.id
      WHERE i.game_id = ? AND i.category = ? AND i.source = 'personal_sync'
        AND i.archived = 0
        AND (i.ends_at IS NULL OR julianday(i.ends_at) > julianday(?))
      ORDER BY COALESCE(i.starts_at, i.created_at), i.created_at
    `).all(gameId, category, reference.toISOString()) as Array<{
      itemId: string
      title: string
      category: Extract<ChecklistCategory, 'limited_event' | 'endgame'>
      activityTagsJson: string
      startsAt: string | null
      endsAt: string | null
      modeKey: string | null
      provider: string
      endpoint: string
      externalId: string
    }>
    return rows.flatMap((row) => {
      let currentTags: string[] = []
      try {
        const parsed = JSON.parse(row.activityTagsJson)
        if (Array.isArray(parsed)) {
          currentTags = parsed.filter((tag): tag is string => typeof tag === 'string')
        }
      } catch {
        // Invalid stored values require enrichment.
      }
      currentTags = normalizeActivityTags(currentTags, outputLocale)
      const missingFields: PersonalMetadataEnrichmentTarget['missingFields'] = []
      if (target === 'events' && activityTagsNeedReview(currentTags)) {
        missingFields.push('activityTags')
      }
      if (!row.startsAt) missingFields.push('startsAt')
      if (!row.endsAt) missingFields.push('endsAt')
      if (missingFields.length === 0) return []
      return [{
        itemId: row.itemId,
        title: row.title,
        category: row.category,
        currentTags,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        missingFields,
        ...(target === 'cycles' ? {
          timeWindowPolicy:
            gameId === 'wuthering-waves' && row.modeKey === 'endstate-matrix'
              ? 'current_playable_phase' as const
              : 'full_cycle' as const
        } : {}),
        sourceIdentity: {
          provider: row.provider,
          endpoint: row.endpoint,
          externalId: row.externalId
        }
      }]
    })
  }

  private listActivityTagEnrichmentTargets(
    gameId: GameId,
    reference: string,
    outputLocale: string
  ): ActivityTagEnrichmentTarget[] {
    const rows = this.database.prepare(`
      SELECT id AS itemId, title, activity_tags_json AS activityTagsJson,
        source, remote_key AS remoteKey, source_url AS sourceUrl,
        starts_at AS startsAt, ends_at AS endsAt
      FROM checklist_items
      WHERE game_id = ?
        AND category = 'limited_event'
        AND source = 'public_schedule'
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
        // Invalid stored values are deliberately treated as requiring review.
      }
      const normalizedTags = normalizeActivityTags(tags, outputLocale)
      return activityTagsNeedReview(normalizedTags)
        ? [{ ...row, currentTags: normalizedTags }]
        : []
    })
  }

  private requeueStaleAiScheduleJobs(reference: Date): number {
    const threshold = new Date(reference.getTime() - AI_JOB_CLAIM_MAX_AGE_MS).toISOString()
    const now = reference.toISOString()
    const result = this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'pending', agent_id = NULL, claimed_at = NULL,
          progress_phase = 'queued', progress_current = NULL, progress_total = NULL,
          progress_updated_at = ?, message = '处理超时，任务已重新排队', updated_at = ?
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
        WHERE game_id = ? AND archived = 1 AND source = 'manual'
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
          map_node_kind, parent_remote_key, starts_at, ends_at,
          reset_rule, period_key, schedule_kind, reset_weekday, timezone, mode_key,
          recurrence_rule, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
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
    const item = this.getChecklistItem(id)
    if (item.source !== 'manual') throw new Error('系统清单由同步维护，不能删除')
    const result = this.database
      .prepare(`
        UPDATE checklist_items
        SET archived = 1, updated_at = ?
        WHERE id = ? AND archived = 0 AND source = 'manual'
      `)
      .run(new Date().toISOString(), id)

    if (result.changes === 0) throw new Error('清单事项不存在或已删除')
  }

  emptyRecycleBin(gameId: GameId): number {
    const result = this.database.prepare(`
      DELETE FROM checklist_items
      WHERE game_id = ? AND archived = 1 AND source = 'manual'
    `).run(gameId)
    return Number(result.changes)
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
        WHERE id = ? AND archived = 1 AND source = 'manual'
      `)
      .run(new Date().toISOString(), id)

    if (result.changes === 0) throw new Error('回收站事项不存在或已恢复')
    this.resetDueWeeklyItems()
    return this.getChecklistItem(id)
  }

  archiveCompletedSection(gameId: string, categories: ChecklistCategory[]): number {
    if (!categories.includes('custom')) return 0
    const result = this.database
      .prepare(`
        UPDATE checklist_items
        SET archived = 1, updated_at = ?
        WHERE game_id = ?
          AND category = 'custom'
          AND completed = 1
          AND archived = 0
          AND source = 'manual'
          AND id NOT IN (
            game_id || ':main_quest',
            game_id || ':side_quest',
            game_id || ':weekly'
          )
      `)
      .run(new Date().toISOString(), gameId)

    return Number(result.changes)
  }

  private hydratePersonalMetadataFromCache(
    gameId: GameId,
    item: NormalizedSyncItem,
    outputLocale: string,
    reference: Date
  ): NormalizedSyncItem {
    if (
      !item.sourceIdentity ||
      (item.category !== 'limited_event' && item.category !== 'endgame')
    ) return { ...item }
    const cached = this.database.prepare(`
      SELECT activity_tags_json AS activityTagsJson,
        starts_at AS startsAt, ends_at AS endsAt, source_url AS sourceUrl
      FROM personal_metadata_cache
      WHERE game_id = ? AND provider = ? AND endpoint = ? AND external_id = ?
        AND output_locale = ? AND taxonomy_version = ?
    `).get(
      gameId,
      item.sourceIdentity.provider,
      item.sourceIdentity.endpoint,
      item.sourceIdentity.externalId,
      outputLocale,
      ACTIVITY_TAG_TAXONOMY_VERSION
    ) as {
      activityTagsJson: string | null
      startsAt: string | null
      endsAt: string | null
      sourceUrl: string | null
    } | undefined
    if (!cached) return { ...item }
    let cachedTags: string[] = []
    try {
      const parsed = cached.activityTagsJson ? JSON.parse(cached.activityTagsJson) : []
      if (Array.isArray(parsed)) {
        cachedTags = parsed.filter((tag): tag is string => typeof tag === 'string')
      }
    } catch {
      cachedTags = []
    }
    const currentTags = normalizeActivityTags(item.activityTags ?? [], outputLocale)
    const cachedEndsAt = cached.endsAt ? Date.parse(cached.endsAt) : Number.NaN
    // Recurring challenge identities may remain stable across periods.  A
    // cached window that has already ended describes the previous period and
    // must not make a fresh official response expire before it can be
    // enriched with the current window.
    const reuseCachedWindow = item.category !== 'endgame' ||
      !Number.isFinite(cachedEndsAt) || cachedEndsAt > reference.getTime()
    return {
      ...item,
      activityTags: item.category === 'limited_event' && activityTagsNeedReview(currentTags)
        ? cachedTags.length > 0 ? cachedTags : currentTags
        : currentTags,
      startsAt: item.startsAt || (reuseCachedWindow ? cached.startsAt : null),
      endsAt: item.endsAt || (reuseCachedWindow ? cached.endsAt : null),
      sourceUrl: item.sourceUrl || cached.sourceUrl
    }
  }

  private cachePersonalMetadata(
    gameId: GameId,
    item: NormalizedSyncItem,
    outputLocale: string,
    verifiedAt: string,
    confidence = 1
  ): void {
    if (
      !item.sourceIdentity ||
      (item.category !== 'limited_event' && item.category !== 'endgame')
    ) return
    const normalizedTags = item.category === 'limited_event'
      ? normalizeActivityTags(item.activityTags ?? [], outputLocale)
      : []
    const activityTagsJson = normalizedTags.length > 0 && !activityTagsNeedReview(normalizedTags)
      ? JSON.stringify(normalizedTags)
      : null
    if (!activityTagsJson && !item.startsAt && !item.endsAt) return
    this.database.prepare(`
      INSERT INTO personal_metadata_cache(
        game_id, provider, endpoint, external_id, output_locale, category,
        activity_tags_json, starts_at, ends_at, source_url, confidence,
        verified_at, updated_at, taxonomy_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id, provider, endpoint, external_id, output_locale) DO UPDATE SET
        category = excluded.category,
        activity_tags_json = COALESCE(excluded.activity_tags_json, personal_metadata_cache.activity_tags_json),
        starts_at = COALESCE(excluded.starts_at, personal_metadata_cache.starts_at),
        ends_at = COALESCE(excluded.ends_at, personal_metadata_cache.ends_at),
        source_url = COALESCE(excluded.source_url, personal_metadata_cache.source_url),
        confidence = COALESCE(excluded.confidence, personal_metadata_cache.confidence),
        taxonomy_version = excluded.taxonomy_version,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
    `).run(
      gameId,
      item.sourceIdentity.provider,
      item.sourceIdentity.endpoint,
      item.sourceIdentity.externalId,
      outputLocale,
      item.category,
      activityTagsJson,
      item.startsAt ?? null,
      item.endsAt ?? null,
      item.sourceUrl ?? null,
      confidence,
      verifiedAt,
      verifiedAt,
      ACTIVITY_TAG_TAXONOMY_VERSION
    )
  }

  /**
   * Switches one section to a complete authenticated snapshot.  Public and
   * personal rows are deliberately not reconciled: the selected source owns
   * the section until the user explicitly chooses the other source.
   */
  replacePersonalSnapshot(
    gameId: GameId,
    target: PersonalSyncTarget,
    accountScope: string,
    items: NormalizedSyncItem[],
    adapterVersion: string,
    reference = new Date(),
    requestContext: SyncRequestContext = {
      outputLocale: 'zh-CN',
      userTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    },
    manageTransaction = true
  ): SyncMergeResult {
    assertAccountScope(accountScope)
    if (!adapterVersion.trim() || adapterVersion.length > 100) {
      throw new Error('个人数据适配器版本格式不正确')
    }
    const expectedCategories: Record<PersonalSyncTarget, ChecklistCategory[]> = {
      events: ['limited_event'],
      cycles: ['endgame'],
      exploration: ['exploration']
    }
    if (items.some((item) => !expectedCategories[target].includes(item.category))) {
      throw new Error('个人快照包含了不属于当前版块的数据')
    }
    const identities = new Set<string>()
    for (const item of items) {
      if (!item.sourceIdentity) throw new Error(`个人事项“${item.title}”缺少官方来源标识`)
      assertSourceIdentity(
        item.sourceIdentity.provider,
        item.sourceIdentity.endpoint,
        item.sourceIdentity.externalId
      )
      const identity = `${item.sourceIdentity.provider}\u0000${item.sourceIdentity.endpoint}\u0000${item.sourceIdentity.externalId}`
      if (identities.has(identity)) throw new Error(`个人快照包含重复官方标识：${item.title}`)
      identities.add(identity)
    }
    const preparedItems = items.map((item) => this.hydratePersonalMetadataFromCache(
      gameId,
      item,
      requestContext.outputLocale,
      reference
    ))
    const activeItems: NormalizedSyncItem[] = []
    const expiredItems: NormalizedSyncItem[] = []
    const suppressedItems: NormalizedSyncItem[] = []
    const correctedIdentities: NormalizedSyncItem['sourceIdentity'][] = []
    for (const item of preparedItems) {
      this.assertTimeWindow(item.startsAt ?? null, item.endsAt ?? null)
      if (
        item.category === 'limited_event' && item.completed === true &&
        item.startsAt && Date.parse(item.startsAt) > reference.getTime()
      ) {
        throw new Error(`尚未开始的活动“${item.title}”不能标记为已完成`)
      }
      const identity = item.sourceIdentity!
      // Catalog placeholders are local period predictions rather than
      // official identities.  They must be allowed to reappear in a later
      // period even if an older prediction was enriched with an end time and
      // expired.  Expiry tombstones remain reserved for actual provider IDs.
      const isCatalogPrediction = identity.provider === 'gtask-cycle-catalog'
      const isKnownRecurringCycle = item.category === 'endgame' && Boolean(findCycleMode(gameId, item))
      const tombstone = isCatalogPrediction
        ? undefined
        : this.database.prepare(`
            SELECT expired_ends_at AS expiredEndsAt
            FROM personal_expiry_tombstones
            WHERE game_id = ? AND provider = ? AND endpoint = ? AND external_id = ?
          `).get(
            gameId,
            identity.provider,
            identity.endpoint,
            identity.externalId
          ) as { expiredEndsAt: string } | undefined
      const endsAtMs = item.endsAt ? Date.parse(item.endsAt) : Number.NaN
      if (Number.isFinite(endsAtMs) && endsAtMs <= reference.getTime()) {
        expiredItems.push(item)
        continue
      }
      if (tombstone) {
        if (isKnownRecurringCycle && !Number.isFinite(endsAtMs)) {
          // Stable official mode IDs can legitimately return again for a new
          // period before the provider exposes the new window. Keep the old
          // period tombstone until the current window is bound, and never
          // carry the old period's completion bit into the placeholder.
          activeItems.push({ ...item, completed: false })
          continue
        }
        if (
          Number.isFinite(endsAtMs) &&
          endsAtMs > reference.getTime() &&
          endsAtMs > Date.parse(tombstone.expiredEndsAt)
        ) {
          correctedIdentities.push(identity)
          activeItems.push(item)
        } else {
          suppressedItems.push(item)
        }
        continue
      }
      activeItems.push(item)
    }
    this.assertStandaloneMapStructure(activeItems)

    const replace = (): SyncMergeResult => {
      const now = reference.toISOString()
      const categories = expectedCategories[target]
      const placeholders = categories.map(() => '?').join(', ')
      let expiredRemoved = 0
      const deleteExactPersonalItem = this.database.prepare(`
        DELETE FROM checklist_items
        WHERE game_id = ? AND source = 'personal_sync'
          AND (
            remote_key = ? OR id IN (
              SELECT item_id FROM source_bindings
              WHERE game_id = ? AND provider = ? AND endpoint = ? AND external_id = ?
            )
          )
      `)
      const upsertExpiry = this.database.prepare(`
        INSERT INTO personal_expiry_tombstones(
          game_id, provider, endpoint, external_id, category, expired_ends_at, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_id, provider, endpoint, external_id) DO UPDATE SET
          category = excluded.category,
          expired_ends_at = CASE
            WHEN julianday(excluded.expired_ends_at) > julianday(personal_expiry_tombstones.expired_ends_at)
              THEN excluded.expired_ends_at
            ELSE personal_expiry_tombstones.expired_ends_at
          END,
          observed_at = excluded.observed_at
      `)
      for (const item of expiredItems) {
        const identity = item.sourceIdentity!
        if (identity.provider !== 'gtask-cycle-catalog') {
          upsertExpiry.run(
            gameId,
            identity.provider,
            identity.endpoint,
            identity.externalId,
            item.category,
            item.endsAt!,
            now
          )
        }
        expiredRemoved += Number(deleteExactPersonalItem.run(
          gameId,
          item.remoteKey,
          gameId,
          identity.provider,
          identity.endpoint,
          identity.externalId
        ).changes)
      }
      for (const item of suppressedItems) {
        const identity = item.sourceIdentity!
        expiredRemoved += Number(deleteExactPersonalItem.run(
          gameId,
          item.remoteKey,
          gameId,
          identity.provider,
          identity.endpoint,
          identity.externalId
        ).changes)
      }
      for (const identity of correctedIdentities) {
        if (!identity) continue
        this.database.prepare(`
          DELETE FROM personal_expiry_tombstones
          WHERE game_id = ? AND provider = ? AND endpoint = ? AND external_id = ?
        `).run(gameId, identity.provider, identity.endpoint, identity.externalId)
      }
      const previouslyExpired = this.database.prepare(`
        SELECT i.id, i.category, i.remote_key AS remoteKey, i.ends_at AS endsAt,
          b.provider, b.endpoint, b.external_id AS externalId
        FROM checklist_items i
        LEFT JOIN source_bindings b ON b.game_id = i.game_id AND b.item_id = i.id
        WHERE i.game_id = ? AND i.source = 'personal_sync'
          AND i.category IN (${placeholders})
          AND i.ends_at IS NOT NULL AND julianday(i.ends_at) <= julianday(?)
      `).all(gameId, ...categories, now) as Array<{
        id: string
        category: Extract<ChecklistCategory, 'limited_event' | 'endgame'>
        remoteKey: string | null
        endsAt: string
        provider: string | null
        endpoint: string | null
        externalId: string | null
      }>
      for (const row of previouslyExpired) {
        if (
          row.provider && row.endpoint && row.externalId &&
          row.provider !== 'gtask-cycle-catalog'
        ) {
          upsertExpiry.run(
            gameId,
            row.provider,
            row.endpoint,
            row.externalId,
            row.category,
            row.endsAt,
            now
          )
        }
        expiredRemoved += Number(this.database.prepare(
          `DELETE FROM checklist_items WHERE id = ? AND game_id = ? AND source = 'personal_sync'`
        ).run(row.id, gameId).changes)
      }
      const snapshotId = randomUUID()
      this.database.prepare(`
        INSERT INTO personal_sync_snapshots(
          id, game_id, target, account_scope, adapter_version,
          item_count, activated_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        snapshotId,
        gameId,
        target,
        accountScope,
        adapterVersion.trim(),
        activeItems.length,
        now,
        now
      )

      // Replace only the active competing checklist. Rows in the recycle bin are
      // an explicit user choice and remain untouched until restored or emptied.
      // Fixed quests, weekly and custom items are outside these category sets.
      this.database.prepare(`
        DELETE FROM checklist_items
        WHERE game_id = ? AND category IN (${placeholders})
          AND source <> 'personal_sync' AND archived = 0
      `).run(gameId, ...categories)
      if (target !== 'events') {
        this.database.prepare(`
          UPDATE checklist_items
          SET manual_completion_locked = 0
          WHERE game_id = ? AND category IN (${placeholders}) AND source = 'personal_sync'
        `).run(gameId, ...categories)
      }

      const merge = this.mergeSyncedItems(
        gameId,
        'personal_sync',
        activeItems,
        now,
        false,
        { codexReviewed: true, identityPolicy: 'remote-key-only' }
      )
      const remoteKeys = activeItems.map((item) => item.remoteKey)
      if (remoteKeys.length === 0) {
        this.database.prepare(`
          DELETE FROM checklist_items
          WHERE game_id = ? AND category IN (${placeholders})
            AND source = 'personal_sync' AND archived = 0
        `).run(gameId, ...categories)
      } else {
        const keyPlaceholders = remoteKeys.map(() => '?').join(', ')
        this.database.prepare(`
          DELETE FROM checklist_items
          WHERE game_id = ? AND category IN (${placeholders}) AND source = 'personal_sync'
            AND archived = 0
            AND remote_key NOT IN (${keyPlaceholders})
        `).run(gameId, ...categories, ...remoteKeys)
      }

      const findItem = this.database.prepare(`
        SELECT id, archived FROM checklist_items
        WHERE game_id = ? AND source = 'personal_sync' AND remote_key = ?
        ORDER BY archived ASC, updated_at DESC
        LIMIT 1
      `)
      const bind = this.database.prepare(`
        INSERT INTO source_bindings(
          game_id, provider, endpoint, external_id, item_id,
          binding_kind, confidence, state_rule_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'mechanical', 1, NULL, ?, ?)
        ON CONFLICT(game_id, provider, endpoint, external_id) DO UPDATE SET
          item_id = excluded.item_id,
          binding_kind = 'mechanical',
          confidence = 1,
          state_rule_json = NULL,
          updated_at = excluded.updated_at
      `)
      const markSnapshot = this.database.prepare(`
        UPDATE checklist_items
        SET source_snapshot_id = ?, last_synced_at = ?, updated_at = ?
        WHERE id = ?
      `)
      for (const item of activeItems) {
        const row = findItem.get(gameId, item.remoteKey) as {
          id: string
          archived: number
        } | undefined
        if (!row || !item.sourceIdentity) throw new Error(`个人事项“${item.title}”写入失败`)
        // An archived row deliberately stays in the recycle bin and is not part
        // of the active snapshot. Emptying the recycle bin removes it, after
        // which a later complete personal snapshot may recreate the item.
        if (row.archived === 1) continue
        markSnapshot.run(snapshotId, now, now, row.id)
        bind.run(
          gameId,
          item.sourceIdentity.provider,
          item.sourceIdentity.endpoint,
          item.sourceIdentity.externalId,
          row.id,
          now,
          now
        )
        this.cachePersonalMetadata(gameId, item, requestContext.outputLocale, now)
      }

      if (target === 'cycles') this.ensureFixedWeeklyItem(gameId, reference)
      this.database.prepare(`
        INSERT INTO sync_target_states(
          game_id, target, last_success_at, last_attempt_at, status,
          catalog_coverage, catalog_source, active_account_scope, active_snapshot_id
        ) VALUES (?, ?, ?, ?, 'success', 'complete', 'personal_data', ?, ?)
        ON CONFLICT(game_id, target) DO UPDATE SET
          last_success_at = excluded.last_success_at,
          last_attempt_at = excluded.last_attempt_at,
          status = 'success',
          catalog_coverage = 'complete',
          catalog_source = 'personal_data',
          active_account_scope = excluded.active_account_scope,
          active_snapshot_id = excluded.active_snapshot_id
      `).run(gameId, target, now, now, accountScope, snapshotId)
      if (target === 'exploration') this.assertActiveMapReferences(gameId)
      return { ...merge, expiredRemoved }
    }
    return manageTransaction ? this.runTransaction(replace) : replace()
  }

  activateChecklistSource(
    gameId: GameId,
    target: PersonalSyncTarget,
    source: 'public_schedule'
  ): void {
    this.runTransaction(() => this.activateChecklistSourceInTransaction(gameId, target, source))
  }

  replacePublicCatalog(
    gameId: GameId,
    target: SyncTarget,
    items: NormalizedSyncItem[],
    syncedAt = new Date().toISOString(),
    options: SyncMergeOptions = {}
  ): SyncMergeResult {
    return this.runTransaction(() => {
      const targets: PersonalSyncTarget[] = target === 'all'
        ? ['events', 'cycles', 'exploration']
        : target === 'events' || target === 'cycles' || target === 'exploration'
          ? [target]
          : []
      for (const selected of targets) {
        this.activateChecklistSourceInTransaction(gameId, selected, 'public_schedule')
      }
      return this.mergeSyncedItems(
        gameId,
        'public_schedule',
        items,
        syncedAt,
        false,
        options
      )
    })
  }

  private activateChecklistSourceInTransaction(
    gameId: GameId,
    target: PersonalSyncTarget,
    source: 'public_schedule'
  ): void {
    const categories: Record<PersonalSyncTarget, ChecklistCategory[]> = {
      events: ['limited_event'],
      cycles: ['endgame'],
      exploration: ['exploration']
    }
    const selected = categories[target]
    const placeholders = selected.map(() => '?').join(', ')
    const now = new Date().toISOString()
    this.database.prepare(`
      UPDATE ai_schedule_jobs
      SET status = 'failed', completed_at = ?, message = '清单已切换为公开资料，个人数据 Codex 任务已取消',
          progress_phase = 'failed', progress_current = NULL, progress_total = NULL,
          progress_updated_at = ?, updated_at = ?
      WHERE game_id = ? AND target = ? AND job_kind IN ('personal_metadata', 'personal_review')
        AND status IN ('pending', 'claimed')
    `).run(now, now, now, gameId, target)
    this.database.prepare(`
      DELETE FROM checklist_items
      WHERE game_id = ? AND category IN (${placeholders})
        AND source = 'personal_sync' AND archived = 0
    `).run(gameId, ...selected)
    const hasPublic = Boolean(this.database.prepare(`
      SELECT 1 FROM checklist_items
      WHERE game_id = ? AND category IN (${placeholders})
        AND source = 'public_schedule' AND archived = 0 LIMIT 1
    `).get(gameId, ...selected))
    this.database.prepare(`
      INSERT INTO sync_target_states(
        game_id, target, status, catalog_coverage, catalog_source,
        active_account_scope, active_snapshot_id
      ) VALUES (?, ?, 'idle', ?, ?, NULL, NULL)
      ON CONFLICT(game_id, target) DO UPDATE SET
        status = 'idle',
        catalog_coverage = excluded.catalog_coverage,
        catalog_source = excluded.catalog_source,
        active_account_scope = NULL,
        active_snapshot_id = NULL
    `).run(gameId, target, hasPublic ? 'partial' : 'empty', source)
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
      if (source === 'public_schedule') {
        this.restorePublicCycleCompletionFromHistory(gameId, items, syncedAt)
      }
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
                map_node_kind, parent_remote_key,
                starts_at, ends_at, reset_rule, period_key, schedule_kind,
                reset_weekday, timezone, mode_key, recurrence_rule, source, remote_key,
                source_url, completed_at, last_synced_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        const resolvedActivityTags = item.category === 'limited_event'
          ? item.activityTags === undefined
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
        const startsAt = item.startsAt === undefined ? current.startsAt : item.startsAt
        const endsAt = item.endsAt === undefined ? current.endsAt : item.endsAt
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
            item.category,
            item.title,
            JSON.stringify(resolvedActivityTags),
            completed ? 1 : 0,
            item.category === 'exploration'
              ? source === 'public_schedule' || item.progressPercent === undefined
                ? current.progressPercent
                : item.progressPercent
              : null,
            item.parentTitle === undefined ? current.parentTitle : item.parentTitle,
            item.mapNodeKind === undefined ? current.mapNodeKind : item.mapNodeKind,
            item.parentRemoteKey === undefined ? current.parentRemoteKey : item.parentRemoteKey,
            startsAt,
            endsAt,
            item.resetRule === undefined ? current.resetRule : item.resetRule,
            item.periodKey === undefined ? current.periodKey : item.periodKey,
            item.scheduleKind === undefined ? current.scheduleKind : item.scheduleKind,
            item.resetWeekday === undefined ? current.resetWeekday : item.resetWeekday,
            item.timeZone === undefined ? current.timeZone : item.timeZone,
            item.modeKey === undefined ? current.modeKey : item.modeKey,
            null,
            source,
            item.sourceUrl === undefined ? current.sourceUrl : item.sourceUrl,
            manualCompletionLocked ? 1 : 0,
            completedAt,
            syncedAt,
            syncedAt,
            current.id
          )
        result.updated += 1
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
          AND source = ?
        ORDER BY updated_at DESC
        LIMIT 1
      `).get(gameId, remoteKey, source) as {
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
          AND source = ?
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
        source,
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
          AND source = ?
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
        source,
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
          AND source = ?
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
        source,
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
          AND source = ?
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
        source,
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
        AND source = ?
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
      source,
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

  rolloverDueCycleItems(reference = new Date()): number {
    const now = reference.toISOString()
    const rows = this.database.prepare(`
      SELECT id, game_id AS gameId, category, title,
        activity_tags_json AS activityTagsJson, completed,
        progress_percent AS progressPercent, parent_title AS parentTitle,
        map_node_kind AS mapNodeKind, parent_remote_key AS parentRemoteKey,
        starts_at AS startsAt, ends_at AS endsAt, reset_rule AS resetRule,
        period_key AS periodKey, schedule_kind AS scheduleKind,
        reset_weekday AS resetWeekday, timezone AS timeZone,
        mode_key AS modeKey, recurrence_rule AS recurrenceRule,
        source, remote_key AS remoteKey, source_url AS sourceUrl,
        manual_completion_locked AS manualCompletionLocked,
        last_synced_at AS lastSyncedAt, completed_at AS completedAt,
        created_at AS createdAt, updated_at AS updatedAt
      FROM checklist_items
      WHERE category = 'endgame' AND archived = 0
        AND source IN ('public_schedule', 'personal_sync')
        AND mode_key IS NOT NULL AND remote_key IS NOT NULL
        AND ends_at IS NOT NULL AND julianday(ends_at) <= julianday(?)
    `).all(now) as Array<Omit<ChecklistItem, 'activityTags' | 'completed' | 'manualCompletionLocked'> & {
      activityTagsJson: string
      completed: number
      manualCompletionLocked: number
    }>
    if (rows.length === 0) return 0
    let changes = 0
    this.runTransaction(() => {
      const insertHistory = this.database.prepare(`
        INSERT INTO cycle_period_history(
          id, game_id, item_id, source, remote_key, mode_key, title,
          completed, manual_completion_locked, starts_at, ends_at,
          period_key, completed_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const updateItem = this.database.prepare(`
        UPDATE checklist_items
        SET title = ?, completed = 0, progress_percent = NULL,
            starts_at = ?, ends_at = ?, reset_rule = NULL,
            period_key = ?, schedule_kind = 'remote_schedule', mode_key = ?,
            remote_key = ?, source_url = NULL, manual_completion_locked = 0,
            completed_at = NULL, last_synced_at = NULL, updated_at = ?
        WHERE id = ? AND category = 'endgame' AND archived = 0
          AND ends_at IS NOT NULL AND julianday(ends_at) <= julianday(?)
      `)
      const clearBindings = this.database.prepare('DELETE FROM source_bindings WHERE item_id = ?')
      for (const row of rows) {
        const item: ChecklistItem = {
          ...row,
          activityTags: JSON.parse(row.activityTagsJson) as string[],
          completed: Boolean(row.completed),
          manualCompletionLocked: Boolean(row.manualCompletionLocked)
        }
        const next = nextCyclePeriod(row.gameId, item, reference)
        if (!next || next.periodKey === row.periodKey) continue
        insertHistory.run(
          randomUUID(),
          row.gameId,
          row.id,
          row.source,
          row.remoteKey,
          row.modeKey,
          row.title,
          row.completed,
          row.manualCompletionLocked,
          row.startsAt,
          row.endsAt,
          row.periodKey,
          row.completedAt,
          now
        )
        clearBindings.run(row.id)
        changes += Number(updateItem.run(
          next.definition.title,
          next.startsAt,
          next.endsAt,
          next.periodKey,
          next.definition.modeKey,
          next.definition.remoteKey,
          now,
          row.id,
          now
        ).changes)
      }
    })
    return changes
  }

  private restorePublicCycleCompletionFromHistory(
    gameId: GameId,
    items: NormalizedSyncItem[],
    reference: string
  ): void {
    const candidates = items.filter((item) =>
      item.category === 'endgame' && item.modeKey && item.startsAt && item.endsAt
    )
    if (candidates.length === 0) return
    const findHistory = this.database.prepare(`
      SELECT id, completed, manual_completion_locked AS manualCompletionLocked,
        completed_at AS completedAt
      FROM cycle_period_history
      WHERE game_id = ? AND source = 'public_schedule' AND mode_key = ?
        AND restored_at IS NULL
        AND (
          period_key = ? OR (
            starts_at IS NOT NULL AND ends_at IS NOT NULL
            AND julianday(starts_at) < julianday(?)
            AND julianday(ends_at) > julianday(?)
          )
        )
      ORDER BY archived_at DESC
      LIMIT 1
    `)
    const restore = this.database.prepare(`
      UPDATE checklist_items
      SET completed = ?, manual_completion_locked = ?, completed_at = ?, updated_at = ?
      WHERE game_id = ? AND source = 'public_schedule' AND mode_key = ?
        AND category = 'endgame' AND archived = 0
    `)
    const markRestored = this.database.prepare(
      'UPDATE cycle_period_history SET restored_at = ? WHERE id = ?'
    )
    for (const item of candidates) {
      const history = findHistory.get(
        gameId,
        item.modeKey!,
        item.periodKey ?? null,
        item.endsAt!,
        item.startsAt!
      ) as {
        id: string
        completed: number
        manualCompletionLocked: number
        completedAt: string | null
      } | undefined
      if (!history) continue
      restore.run(
        history.completed,
        history.manualCompletionLocked,
        history.completedAt,
        reference,
        gameId,
        item.modeKey!
      )
      markRestored.run(reference, history.id)
    }
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

  private migrate(): void {
    const existing = this.database.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'
    `).get()
    if (existing) {
      const version = this.database.prepare(
        'SELECT MAX(version) AS version FROM schema_migrations'
      ).get() as { version: number | null }
      if (version.version !== CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `数据库版本不兼容：期望 ${CURRENT_SCHEMA_VERSION}，实际 ${version.version ?? '未知'}`
        )
      }
      return
    }

    this.database.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE games (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_name TEXT NOT NULL,
        accent TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE checklist_items (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
        category TEXT NOT NULL CHECK (category IN (
          'main_quest', 'side_quest', 'limited_event',
          'weekly', 'endgame', 'exploration', 'custom'
        )),
        title TEXT NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
        progress_percent REAL CHECK (
          progress_percent IS NULL OR (progress_percent >= 0 AND progress_percent <= 100)
        ),
        starts_at TEXT,
        ends_at TEXT,
        reset_rule TEXT,
        period_key TEXT,
        source TEXT NOT NULL DEFAULT 'manual'
          CHECK (source IN ('manual', 'public_schedule', 'personal_sync')),
        remote_key TEXT,
        manual_completion_locked INTEGER NOT NULL DEFAULT 0
          CHECK (manual_completion_locked IN (0, 1)),
        archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
        last_synced_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT,
        schedule_kind TEXT CHECK (
          schedule_kind IS NULL OR schedule_kind IN ('weekly', 'fixed_window', 'remote_schedule')
        ),
        reset_weekday INTEGER CHECK (
          reset_weekday IS NULL OR (reset_weekday >= 1 AND reset_weekday <= 7)
        ),
        timezone TEXT,
        mode_key TEXT,
        parent_title TEXT,
        source_url TEXT,
        recurrence_rule TEXT,
        activity_tags_json TEXT NOT NULL DEFAULT '[]',
        map_node_kind TEXT CHECK (
          map_node_kind IS NULL OR map_node_kind IN ('region', 'subregion')
        ),
        parent_remote_key TEXT,
        source_snapshot_id TEXT
      );
      CREATE UNIQUE INDEX checklist_remote_identity
        ON checklist_items(game_id, source, remote_key)
        WHERE remote_key IS NOT NULL;

      CREATE TABLE sync_states (
        game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        mode TEXT NOT NULL DEFAULT 'manual'
          CHECK (mode IN ('manual', 'public_schedule', 'personal_sync')),
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'success', 'error', 'stale', 'verification_required')),
        last_attempt_at TEXT,
        last_success_at TEXT,
        message TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        run_mode TEXT NOT NULL DEFAULT 'manual' CHECK (run_mode = 'manual'),
        auto_scope TEXT NOT NULL DEFAULT 'public_schedule' CHECK (auto_scope = 'public_schedule'),
        last_scope TEXT CHECK (
          last_scope IS NULL OR last_scope IN ('public_schedule', 'public_and_personal')
        ),
        initial_guide_dismissed INTEGER NOT NULL DEFAULT 0
          CHECK (initial_guide_dismissed IN (0, 1))
      );

      CREATE TABLE sync_target_states (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        target TEXT NOT NULL CHECK (target IN ('all', 'tasks', 'events', 'cycles', 'exploration')),
        last_success_at TEXT,
        last_attempt_at TEXT,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'success', 'error', 'stale', 'verification_required')),
        catalog_coverage TEXT NOT NULL DEFAULT 'empty'
          CHECK (catalog_coverage IN ('empty', 'partial', 'complete')),
        catalog_source TEXT
          CHECK (catalog_source IS NULL OR catalog_source IN ('public_schedule', 'personal_data')),
        active_account_scope TEXT,
        active_snapshot_id TEXT,
        PRIMARY KEY(game_id, target)
      );

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
        updated_at TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT 'all'
          CHECK (target IN ('all', 'tasks', 'events', 'cycles', 'exploration')),
        user_timezone TEXT NOT NULL DEFAULT 'UTC',
        progress_phase TEXT NOT NULL DEFAULT 'queued' CHECK (progress_phase IN (
          'queued', 'fetching', 'searching', 'verifying', 'structuring',
          'writing', 'retrying', 'verification', 'merging', 'completed', 'failed', 'cancelled'
        )),
        progress_current INTEGER,
        progress_total INTEGER,
        progress_updated_at TEXT,
        output_locale TEXT NOT NULL DEFAULT 'zh-CN',
        job_kind TEXT NOT NULL DEFAULT 'public_catalog'
          CHECK (job_kind IN ('public_catalog', 'personal_metadata', 'personal_review')),
        routing_tier INTEGER NOT NULL DEFAULT 0,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        assigned_model TEXT,
        assigned_reasoning_effort TEXT,
        last_failure_kind TEXT
      );
      CREATE INDEX ai_schedule_jobs_pending ON ai_schedule_jobs(status, requested_at);
      CREATE UNIQUE INDEX ai_schedule_jobs_active_game_target_kind
        ON ai_schedule_jobs(game_id, target, job_kind)
        WHERE status IN ('pending', 'claimed');

      CREATE TABLE ai_schedule_job_attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES ai_schedule_jobs(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        routing_tier INTEGER NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        outcome TEXT CHECK (outcome IN (
          'running', 'completed', 'escalated', 'timeout', 'infrastructure_error',
          'cancelled', 'failed'
        )),
        message TEXT
      );
      CREATE INDEX ai_schedule_job_attempts_job
        ON ai_schedule_job_attempts(job_id, attempt_number DESC);
      CREATE TRIGGER ai_schedule_job_attempt_finished
        AFTER UPDATE OF status ON ai_schedule_jobs
        WHEN NEW.status IN ('completed', 'failed')
        BEGIN
          UPDATE ai_schedule_job_attempts
          SET completed_at = COALESCE(completed_at, NEW.completed_at, NEW.updated_at),
              outcome = CASE WHEN NEW.status = 'completed' THEN 'completed' ELSE 'failed' END,
              message = COALESCE(message, NEW.message)
          WHERE job_id = NEW.id AND outcome = 'running';
        END;

      CREATE TABLE source_bindings (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        external_id TEXT NOT NULL,
        item_id TEXT NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
        binding_kind TEXT NOT NULL CHECK (binding_kind IN ('mechanical', 'codex')),
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        state_rule_json TEXT,
        PRIMARY KEY(game_id, provider, endpoint, external_id)
      );
      CREATE INDEX source_bindings_item ON source_bindings(game_id, item_id);

      CREATE TABLE personal_sync_snapshots (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        target TEXT NOT NULL CHECK (target IN ('events', 'cycles', 'exploration')),
        account_scope TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        item_count INTEGER NOT NULL CHECK (item_count >= 0),
        activated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX personal_sync_snapshots_target
        ON personal_sync_snapshots(game_id, target, activated_at DESC);

      CREATE TABLE personal_review_batches (
        job_id TEXT PRIMARY KEY REFERENCES ai_schedule_jobs(id) ON DELETE CASCADE,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        target TEXT NOT NULL CHECK (target IN ('events', 'cycles', 'exploration')),
        account_scope TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        base_items_json TEXT NOT NULL,
        review_targets_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX personal_review_batches_target
        ON personal_review_batches(game_id, target, created_at DESC);

      CREATE TABLE personal_review_rules (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        external_id TEXT NOT NULL,
        target TEXT NOT NULL CHECK (target IN ('events', 'cycles', 'exploration')),
        rule_version TEXT NOT NULL,
        resolution_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        verified_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(game_id, provider, endpoint, external_id, target)
      );

      CREATE TABLE personal_metadata_cache (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        external_id TEXT NOT NULL,
        output_locale TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('limited_event', 'endgame')),
        activity_tags_json TEXT,
        starts_at TEXT,
        ends_at TEXT,
        source_url TEXT,
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        verified_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        taxonomy_version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(game_id, provider, endpoint, external_id, output_locale)
      );

      CREATE TABLE personal_expiry_tombstones (
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        external_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK (category IN ('limited_event', 'endgame')),
        expired_ends_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY(game_id, provider, endpoint, external_id)
      );
      CREATE INDEX personal_expiry_tombstones_game_category
        ON personal_expiry_tombstones(game_id, category, observed_at DESC);

      CREATE TABLE cycle_period_history (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
        item_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('public_schedule', 'personal_sync')),
        remote_key TEXT NOT NULL,
        mode_key TEXT NOT NULL,
        title TEXT NOT NULL,
        completed INTEGER NOT NULL CHECK (completed IN (0, 1)),
        manual_completion_locked INTEGER NOT NULL CHECK (manual_completion_locked IN (0, 1)),
        starts_at TEXT,
        ends_at TEXT,
        period_key TEXT,
        completed_at TEXT,
        archived_at TEXT NOT NULL,
        restored_at TEXT
      );
      CREATE INDEX cycle_period_history_lookup
        ON cycle_period_history(game_id, source, mode_key, archived_at DESC);

      CREATE TABLE activity_tag_registry (
        id TEXT PRIMARY KEY,
        dimension TEXT NOT NULL CHECK (dimension IN ('gameplay', 'format', 'content', 'reward')),
        labels_json TEXT NOT NULL,
        description TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        source_url TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_by_agent TEXT,
        taxonomy_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE codex_worker_settings (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        strategy TEXT NOT NULL DEFAULT 'fixed' CHECK (strategy = 'fixed'),
        model TEXT NOT NULL DEFAULT 'gpt-5.6-sol'
          CHECK (model IN ('inherit', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')),
        reasoning_effort TEXT NOT NULL DEFAULT 'medium'
          CHECK (reasoning_effort IN ('inherit', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')),
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO codex_worker_settings(singleton, strategy, model, reasoning_effort)
        VALUES (1, 'fixed', 'gpt-5.6-sol', 'medium');

      INSERT INTO schema_migrations(version) VALUES (${CURRENT_SCHEMA_VERSION});
      COMMIT;
    `)
  }

  private loadRuntimeActivityTags(): void {
    const rows = this.database.prepare(`
      SELECT id, dimension, labels_json AS labelsJson, description,
        aliases_json AS aliasesJson
      FROM activity_tag_registry
      WHERE taxonomy_version = ?
      ORDER BY id
    `).all(ACTIVITY_TAG_TAXONOMY_VERSION) as Array<{
      id: string
      dimension: ActivityTagDimension
      labelsJson: string
      description: string
      aliasesJson: string
    }>
    const definitions = rows.flatMap((row): ActivityTagDefinition[] => {
      try {
        const labels = JSON.parse(row.labelsJson)
        const aliases = JSON.parse(row.aliasesJson)
        if (!labels || typeof labels !== 'object' || Array.isArray(labels) || !Array.isArray(aliases)) {
          return []
        }
        return [{
          id: row.id,
          dimension: row.dimension,
          labels: Object.fromEntries(Object.entries(labels)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          description: row.description,
          aliases: aliases.filter((alias): alias is string => typeof alias === 'string'),
          builtin: false
        }]
      } catch {
        return []
      }
    })
    configureRuntimeActivityTags(definitions)
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

  private ensureFixedWeeklyItem(gameId: GameId, reference = new Date()): void {
    const period = getWeeklyPeriod(reference, 1, 'Asia/Shanghai')
    const now = reference.toISOString()
    this.database.prepare(`
      INSERT OR IGNORE INTO checklist_items(
        id, game_id, category, title, completed, starts_at, ends_at,
        reset_rule, period_key, schedule_kind, reset_weekday, timezone,
        source, remote_key, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, 'weekly', '周常', 0, ?, ?, '每周一重置', ?, 'weekly', 1,
        'Asia/Shanghai', 'public_schedule', ?, ?, ?, ?)
    `).run(
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
      DELETE FROM checklist_items
      WHERE category = 'weekly'
        AND archived = 0
        AND id <> game_id || ':weekly'
    `).run()
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
        // Invalid stored values use the honest fallback below.
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
      activityTags: localizeActivityTags(activityTags, 'zh-CN'),
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

  private assertStandaloneMapStructure(items: NormalizedSyncItem[]): void {
    const maps = items.filter((item) => item.category === 'exploration')
    if (maps.length === 0) return
    const byKey = new Map<string, NormalizedSyncItem>()
    for (const item of maps) {
      if (byKey.has(item.remoteKey)) {
        throw new Error(`个人地图快照包含重复标识：${item.remoteKey}`)
      }
      byKey.set(item.remoteKey, item)
      if (item.parentRemoteKey === item.remoteKey) throw new Error('地图节点不能以自身为上级')
      if (item.mapNodeKind === 'region' && item.parentRemoteKey) {
        throw new Error(`一级主地区“${item.title}”不能包含上级地区`)
      }
      if (item.mapNodeKind === 'subregion' && !item.parentRemoteKey) {
        throw new Error(`二级地区“${item.title}”必须指定一级主地区`)
      }
    }
    for (const item of maps) {
      if (!item.parentRemoteKey) continue
      const parent = byKey.get(item.parentRemoteKey)
      if (!parent || parent.mapNodeKind !== 'region') {
        throw new Error(`二级地区“${item.title}”的上级必须是同一快照中的一级主地区`)
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
