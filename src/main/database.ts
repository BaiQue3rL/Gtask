import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import type {
  ChecklistCategory,
  ChecklistItem,
  ChecklistSource,
  ActivityTagEnrichmentTarget,
  AiScheduleAgentStatus,
  AiScheduleJob,
  AiScheduleJobKind,
  AiScheduleVersionCandidate,
  CreateChecklistItemInput,
  GameId,
  GameSummary,
  GameVersionSummary,
  PersonalSyncTarget,
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
import { completeCycleCatalog, findCycleMode, nextCyclePeriod } from './sync/cycle-catalog'
import { getBundledMapCatalog, getBundledMapCatalogVerifiedAt } from './sync/map-catalog'
import {
  BUNDLED_BASELINE_VERIFIED_AT,
  getBundledActivityCatalog,
  getDefaultVersionCadenceDays,
  getBundledVersionWindow
} from './sync/baseline-catalog'
import {
  type ActivityTagUpdate,
  type CodexArchiveDecision,
  type CodexScheduleItem,
  type CodexVersionWindow,
  type NormalizedSyncItem,
  type SyncMergeResult
} from './sync/types'
import type { RemoteCatalogFeed } from './remote-catalog-update'

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

// Version 1 is the public Gtask 1.0 baseline. All later structural changes use
// explicit forward migrations so existing user data remains intact.
export const CURRENT_SCHEMA_VERSION = 3

const AI_AGENT_MAX_AGE_MS = 5 * 60 * 1000
const AI_JOB_CLAIM_MAX_AGE_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

interface SyncMergeOptions {
  codexReviewed?: boolean
  identityPolicy?: 'heuristic' | 'remote-key-only'
  outputLocale?: string
}

export interface RemoteCatalogApplyResult extends SyncMergeResult {
  archived: number
  expiredRemoved: number
}

interface PublicCatalogReplacementOptions extends SyncMergeOptions {
  preserveActiveSourceState?: boolean
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

export class AppDatabase {
  private readonly database: DatabaseSync

  constructor(
    databasePath: string,
    options: { seedBundledBaselines?: boolean } = {}
  ) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    try {
      this.database.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
      this.migrate()
      this.loadRuntimeActivityTags()
      this.seedGames()
      this.ensureVersionWindowStorage()
      if (options.seedBundledBaselines !== false) {
        // Advance expired rows before a bundled catalog with the same stable
        // mode key is merged. Otherwise the new period can collide with the
        // unique (game, source, remote_key) identity before normal rollover.
        this.rolloverDueCycleItems()
        this.seedBundledBaselines()
        this.absorbLegacyPersonalProgressIntoBaselines()
      }
      this.reconcileSyncTargetStates()
      this.normalizeLegacyActivityTags()
      this.normalizeSyncedProgressSafety()
      this.normalizePublicMapProgressConsistency()
      this.rolloverDueCycleItems()
      this.rolloverExpiredVersionWindows()
      this.pruneExpiredSystemItems()
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

  listGameVersionSummaries(reference = new Date()): GameVersionSummary[] {
    this.rolloverExpiredVersionWindows(reference)
    const referenceTime = reference.getTime()
    const rows = this.database.prepare(`
      SELECT
        game_id AS gameId,
        starts_at AS startsAt,
        ends_at AS endsAt
      FROM game_version_windows
    `).all() as Array<{ gameId: GameId; startsAt: string; endsAt: string }>

    return this.listGames().map((game) => {
      const currentWindow = rows
        .filter((row) => {
          if (row.gameId !== game.id) return false
          const startsAt = Date.parse(row.startsAt)
          const endsAt = Date.parse(row.endsAt)
          return Number.isFinite(startsAt) && Number.isFinite(endsAt) &&
            startsAt <= referenceTime && referenceTime < endsAt
        })
        .sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt))[0]

      return {
        gameId: game.id,
        endsAt: currentWindow?.endsAt ?? null
      }
    })
  }

  getRelevantGameVersionWindow(
    gameId: GameId,
    reference = new Date()
  ): { periodKey: string | null; startsAt: string; endsAt: string } | null {
    this.rolloverExpiredVersionWindows(reference)
    const rows = this.database.prepare(`
      SELECT period_key AS periodKey, starts_at AS startsAt, ends_at AS endsAt
      FROM game_version_windows
      WHERE game_id = ?
    `).all(gameId) as Array<{ periodKey: string; startsAt: string; endsAt: string }>
    const referenceTime = reference.getTime()
    const valid = rows.filter((row) => {
      const startsAt = Date.parse(row.startsAt)
      const endsAt = Date.parse(row.endsAt)
      return Number.isFinite(startsAt) && Number.isFinite(endsAt) && startsAt < endsAt
    })
    return valid.find((row) =>
      Date.parse(row.startsAt) <= referenceTime && referenceTime < Date.parse(row.endsAt)
    ) ?? valid.sort((left, right) => Date.parse(right.startsAt) - Date.parse(left.startsAt))[0] ?? null
  }

  rolloverExpiredVersionWindows(reference = new Date()): number {
    const expired = this.database.prepare(`
      SELECT game_id AS gameId, ends_at AS endsAt
      FROM game_version_windows
      WHERE julianday(ends_at) <= julianday(?)
    `).all(reference.toISOString()) as Array<{ gameId: GameId; endsAt: string }>
    if (expired.length === 0) return 0

    const update = this.database.prepare(`
      UPDATE game_version_windows
      SET period_key = ?, starts_at = ?, ends_at = ?,
          confidence = MIN(confidence, 0.25), updated_at = ?
      WHERE game_id = ? AND ends_at = ?
    `)
    let changed = 0
    for (const row of expired) {
      const previousEndsAt = Date.parse(row.endsAt)
      if (!Number.isFinite(previousEndsAt)) continue
      const cadenceMs = getDefaultVersionCadenceDays(row.gameId) * DAY_MS
      const elapsedPeriods = Math.floor(
        Math.max(0, reference.getTime() - previousEndsAt) / cadenceMs
      )
      const startsAt = new Date(previousEndsAt + elapsedPeriods * cadenceMs).toISOString()
      const endsAt = new Date(previousEndsAt + (elapsedPeriods + 1) * cadenceMs).toISOString()
      const periodKey = `predicted:${row.gameId}:version:${startsAt}`
      changed += Number(update.run(
        periodKey,
        startsAt,
        endsAt,
        reference.toISOString(),
        row.gameId,
        row.endsAt
      ).changes)
    }
    return changed
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
          auto_sync_enabled AS autoSyncEnabled,
          status,
          last_attempt_at AS lastAttemptAt,
          last_success_at AS lastSuccessAt,
          message
        FROM sync_states
        WHERE game_id = ?
      `)
      .get(gameId)

    if (!row) throw new Error('游戏同步设置不存在')
    return {
      ...(row as Omit<SyncSettings, 'autoSyncEnabled'> & { autoSyncEnabled: number }),
      autoSyncEnabled: Boolean((row as { autoSyncEnabled: number }).autoSyncEnabled)
    }
  }

  updateSyncSettings(
    gameId: GameId,
    settings: Pick<SyncSettings, 'autoSyncEnabled'>,
    reference = new Date()
  ): SyncSettings {
    const result = this.database.prepare(`
      UPDATE sync_states
      SET auto_sync_enabled = ?, updated_at = ?
      WHERE game_id = ?
    `).run(settings.autoSyncEnabled ? 1 : 0, reference.toISOString(), gameId)
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

  recoverInterruptedPublicCatalogMaintenance(
    gameId: GameId,
    target: PersonalSyncTarget
  ): boolean {
    const hasActiveJob = this.listActiveAiScheduleJobs(gameId).some(
      (job) => job.target === target || job.target === 'all'
    )
    if (hasActiveJob) return false
    const result = this.database.prepare(`
      UPDATE sync_target_states
      SET status = 'success'
      WHERE game_id = ? AND target = ?
        AND status = 'idle'
        AND catalog_coverage = 'complete'
        AND catalog_source = 'public_schedule'
        AND last_success_at IS NOT NULL
        AND last_attempt_at = last_success_at
    `).run(gameId, target)
    return result.changes > 0
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

  recordPersonalSyncAttempt(gameId: string): void {
    const now = new Date().toISOString()
    this.database
      .prepare(`
        UPDATE sync_states
        SET status = 'idle', last_attempt_at = ?, message = NULL, updated_at = ?
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
    return { connected: true, agentId, name, lastSeenAt: now }
  }

  getAiScheduleAgentStatus(reference = new Date()): AiScheduleAgentStatus {
    const threshold = new Date(reference.getTime() - AI_AGENT_MAX_AGE_MS).toISOString()
    const row = this.database.prepare(`
      SELECT id AS agentId, name, last_seen_at AS lastSeenAt
      FROM ai_schedule_agents
      WHERE last_seen_at >= ?
      ORDER BY last_seen_at DESC
      LIMIT 1
    `).get(threshold) as Omit<AiScheduleAgentStatus, 'connected'> | undefined
    return row ? { connected: true, ...row } : {
      connected: false,
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
      SELECT id, target FROM ai_schedule_jobs
      WHERE game_id = ? AND job_kind = 'public_catalog' AND status IN ('pending', 'claimed')
        AND (
          target = ?
          OR target = 'all'
          OR ? = 'all'
        )
      ORDER BY requested_at ASC LIMIT 1
    `).get(gameId, target, target) as {
      id: string
      target: SyncTarget
    } | undefined
    if (active) {
      if (active.target !== target) {
        throw new Error('全局同步与版块同步不能重复排队，请等待当前全局任务完成')
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
      SET status = 'idle', last_attempt_at = ?,
          message = '公开资料任务已提交给 AI，等待检索', updated_at = ?
      WHERE game_id = ?
    `).run(now, now, gameId)
    this.recordSyncTargetAttempt(gameId, target, 'idle', reference)
    return this.getAiScheduleJob(id)
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
    contentLocale?: string,
    versionWindow?: CodexVersionWindow,
    verifiedUnchangedTargets: Exclude<SyncTarget, 'all'>[] = []
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
      cycles: ['endgame'],
      exploration: ['exploration'],
      tasks: []
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
      if (candidate.source === 'manual') {
        throw new Error('手动事项不能由同步流程删除')
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
    const uniqueVerifiedUnchangedTargets = [...new Set(verifiedUnchangedTargets)]
    const validSectionTargets: Exclude<SyncTarget, 'all'>[] = [
      'tasks', 'events', 'cycles', 'exploration'
    ]
    if (uniqueVerifiedUnchangedTargets.some((target) => !validSectionTargets.includes(target))) {
      throw new Error('无变化核查目标不受支持')
    }
    if (
      job.target !== 'all' &&
      uniqueVerifiedUnchangedTargets.some((target) => target !== job.target)
    ) {
      throw new Error('无变化核查目标与当前同步目标不一致')
    }
    if (uniqueVerifiedEmptyTargets.some((target) => uniqueVerifiedUnchangedTargets.includes(target))) {
      throw new Error('同一版块不能同时标记为空目录和无变化')
    }
    const mutationTargets = new Set<Exclude<SyncTarget, 'all'>>()
    if (versionWindow) mutationTargets.add('tasks')
    if (items.some((item) => item.category === 'limited_event') || activityTagUpdates.length > 0) {
      mutationTargets.add('events')
    }
    if (items.some((item) => item.category === 'endgame')) mutationTargets.add('cycles')
    if (items.some((item) => item.category === 'exploration')) mutationTargets.add('exploration')
    for (const decision of archiveItems) {
      const category = matchCandidatesById.get(decision.itemId)?.category
      if (category === 'limited_event') mutationTargets.add('events')
      if (category === 'endgame') mutationTargets.add('cycles')
      if (category === 'exploration') mutationTargets.add('exploration')
    }
    const contradictoryTarget = uniqueVerifiedUnchangedTargets.find((target) =>
      mutationTargets.has(target)
    )
    if (contradictoryTarget) {
      throw new Error(`版块“${contradictoryTarget}”不能同时标记为无变化并提交增删改`)
    }
    if (
      job.target === 'tasks' &&
      !versionWindow &&
      !uniqueVerifiedUnchangedTargets.includes('tasks')
    ) {
      throw new Error('版本核查必须提交变化后的版本窗口，或明确标记版本时间无变化')
    }
    if (job.target !== 'tasks' && job.target !== 'all' && versionWindow) {
      throw new Error('当前同步目标不允许回写游戏版本窗口')
    }
    if (versionWindow) this.validateVersionWindow(versionWindow, reference)
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
        !activityTagsMeetQualityContract(item.activityTags)
      )
    )
    if (invalidEventTags) {
      throw new Error(
        `活动“${invalidEventTags.title}”必须提交 1 到 5 个有可靠依据的有效玩法标签`
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
      (item) => item.category === 'endgame'
    )
    const coveredTargets: Exclude<SyncTarget, 'all'>[] = job.target === 'all'
      ? [...new Set([
          ...(versionWindow ? ['tasks' as const] : []),
          ...(items.some((item) =>
            item.category === 'limited_event'
          ) ||
            activityTagUpdates.length > 0 ||
            uniqueVerifiedEmptyTargets.includes('events')
            ? ['events' as const]
            : []),
          ...(includesCycles ? ['cycles' as const] : []),
          ...(items.some((item) => item.category === 'exploration') ? ['exploration' as const] : []),
          ...uniqueVerifiedUnchangedTargets
        ])]
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
      if (versionWindow) this.upsertVersionWindow(job.gameId, versionWindow, now)
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
        items,
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
      this.recalculatePublicMapRegionProgress(job.gameId, reference)
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
      tasks: '版本时间',
      events: '活动',
      cycles: '周期',
      exploration: '地图'
    }
    const tagMessage = activityTagUpdates.length > 0 ? `，补全标签 ${activityTagUpdates.length}` : ''
    const unresolvedMessage = unresolvedActivityCount > 0
      ? `；仍有 ${unresolvedActivityCount} 项活动经本轮核验后暂为未知`
      : ''
    const archiveMessage = archived > 0 ? `，移入回收站 ${archived}` : ''
    const noMutation = mutationTargets.size === 0 && archiveItems.length === 0
    const mergeMessage = noMutation && uniqueVerifiedUnchangedTargets.length > 0
      ? '全版块核查完成，未发现变化'
      : versionWindow && items.length === 0
      ? '版本时间已校准'
      : `新增 ${merge.added}，更新 ${merge.updated}${tagMessage}${archiveMessage}，保护 ${merge.preserved}`
    const message = effectiveMissingTargets.length > 0
      ? `AI 资料部分同步完成：${mergeMessage}；仍需补齐${effectiveMissingTargets.map(
          (target) => targetNames[target]
        ).join('、')}${unresolvedMessage}`
      : `AI 资料同步完成：${mergeMessage}${unresolvedMessage}`
    if (requiresFullCoverage && effectiveMissingTargets.length > 0) {
      for (const coveredTarget of coveredTargets) {
        this.recordCatalogCoverage(job.gameId, coveredTarget, 'public_schedule', 'complete')
        this.recordSyncTargetSuccess(job.gameId, coveredTarget, reference)
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
    const partialPublicResult = job.target === 'all' && effectiveMissingTargets.length > 0
    const finalStatus = partialPublicResult ? 'stale' : 'success'
    this.recordSyncOutcome(
      job.gameId,
      finalStatus,
      message,
      !partialPublicResult
    )
    if (job.target === 'all') {
      for (const coveredTarget of coveredTargets) {
        this.recordCatalogCoverage(job.gameId, coveredTarget, 'public_schedule', 'complete')
        this.recordSyncTargetSuccess(job.gameId, coveredTarget, reference)
      }
      if (!partialPublicResult) {
        this.recordCatalogCoverage(job.gameId, 'all', 'public_schedule', 'complete')
        this.recordSyncTargetSuccess(job.gameId, 'all', reference, true)
      } else {
        this.recordCatalogCoverage(job.gameId, 'all', 'public_schedule', 'partial')
        this.recordSyncTargetAttempt(job.gameId, 'all', 'stale', reference)
      }
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
      'activityTagTargets' | 'matchCandidates' | 'currentVersionWindow' | 'contract' | 'requestContext'
    > | undefined
    if (!row) throw new Error('AI 资料任务不存在')
    const activityTagTargets = row.jobKind === 'public_catalog' && (
      row.status === 'pending' || row.status === 'claimed'
    ) && (row.target === 'events' || row.target === 'all')
      ? this.listActivityTagEnrichmentTargets(row.gameId, row.requestedAt, row.outputLocale)
      : []
    const targetCategories: Record<SyncTarget, ChecklistCategory[]> = {
      tasks: [],
      events: ['limited_event'],
      cycles: ['endgame'],
      exploration: ['exploration'],
      all: [
        'limited_event',
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
        activityTags: normalizeActivityTags(item.activityTags, row.outputLocale),
        source: item.source,
        remoteKey: item.remoteKey,
        sourceUrl: item.sourceUrl,
        modeKey: item.modeKey,
        periodKey: item.periodKey,
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        resetRule: item.resetRule,
        scheduleKind: item.scheduleKind,
        resetWeekday: item.resetWeekday,
        timeZone: item.timeZone,
        recurrenceRule: item.recurrenceRule,
        parentTitle: item.parentTitle,
        mapNodeKind: item.mapNodeKind,
        parentRemoteKey: item.parentRemoteKey
      })) : []
    const currentVersionWindow = row.jobKind === 'public_catalog' && (
      row.target === 'tasks' || row.target === 'all'
    )
      ? this.database.prepare(`
          SELECT period_key AS periodKey, starts_at AS startsAt, ends_at AS endsAt,
            timezone AS timeZone, source_url AS sourceUrl, confidence
          FROM game_version_windows
          WHERE game_id = ?
        `).get(row.gameId) as unknown as AiScheduleVersionCandidate | undefined
      : null
    return {
      ...row,
      requestContext: {
        outputLocale: row.outputLocale,
        userTimeZone: row.userTimeZone
      },
      activityTagTargets,
      matchCandidates,
      currentVersionWindow: currentVersionWindow ?? null,
      contract: getPublicSyncContract(row.target, {
        outputLocale: row.outputLocale,
        userTimeZone: row.userTimeZone
      })
    }
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
            WHEN 'limited_event' THEN 30
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
    const id = randomUUID()
    const now = new Date().toISOString()
    const scheduleKind = input.scheduleKind ?? this.defaultScheduleKind(input.category)
    const resetWeekday = input.resetWeekday ?? null
    const timeZone = input.timeZone ?? null
    const startsAt = input.startsAt ?? null
    const endsAt = input.endsAt ?? null
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
        null,
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
    const resetWeekday = input.resetWeekday === undefined
      ? categoryChanged
        ? null
        : current.resetWeekday
      : input.resetWeekday
    const timeZone =
      input.timeZone === undefined
        ? categoryChanged
          ? null
          : current.timeZone
        : input.timeZone
    const startsAt = input.startsAt === undefined ? current.startsAt : input.startsAt
    const endsAt = input.endsAt === undefined ? current.endsAt : input.endsAt
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
        categoryChanged ? null : current.periodKey,
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

    if (current.category === 'exploration' || category === 'exploration') {
      this.recalculatePublicMapRegionProgress(current.gameId)
    }
    return this.getChecklistItem(input.id)
  }

  updateChecklistItems(inputs: UpdateChecklistItemInput[]): ChecklistItem[] {
    return this.runTransaction(() => inputs.map((input) => this.updateChecklistItem(input)))
  }

  setChecklistCompletion(id: string, completed: boolean): ChecklistItem[] {
    const item = this.getChecklistItem(id)
    const affectedIds = [item.id]
    if (item.category === 'exploration' && item.mapNodeKind === 'region') {
      const children = this.database.prepare(`
        SELECT id
        FROM checklist_items
        WHERE game_id = ? AND category = 'exploration' AND archived = 0
          AND map_node_kind = 'subregion'
          AND (
            (? IS NOT NULL AND parent_remote_key = ?)
            OR (parent_remote_key IS NULL AND parent_title = ?)
          )
        ORDER BY created_at, id
      `).all(
        item.gameId,
        item.remoteKey,
        item.remoteKey,
        item.title
      ) as Array<{ id: string }>
      affectedIds.push(...children.map((child) => child.id))
    }
    this.updateChecklistItems(affectedIds.map((affectedId) => ({
      id: affectedId,
      completed,
      ...(item.category === 'exploration' ? { progressPercent: completed ? 100 : 0 } : {})
    })))
    if (item.category !== 'exploration') {
      return affectedIds.map((affectedId) => this.getChecklistItem(affectedId))
    }

    const relatedIds = new Set(affectedIds)
    if (item.mapNodeKind === 'subregion') {
      const parent = this.database.prepare(`
        SELECT id FROM checklist_items
        WHERE game_id = ? AND category = 'exploration' AND archived = 0
          AND map_node_kind = 'region'
          AND (
            (? IS NOT NULL AND remote_key = ?)
            OR (? IS NULL AND title = ?)
          )
        LIMIT 1
      `).get(
        item.gameId,
        item.parentRemoteKey,
        item.parentRemoteKey,
        item.parentRemoteKey,
        item.parentTitle
      ) as { id: string } | undefined
      if (parent) relatedIds.add(parent.id)
    }
    return this.listChecklistItems(item.gameId).filter((candidate) => relatedIds.has(candidate.id))
  }

  archiveChecklistItem(id: string): void {
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
      `)
      .run(new Date().toISOString(), gameId)

    return Number(result.changes)
  }

  private findBaselineItemForPersonalProgress(
    gameId: GameId,
    item: NormalizedSyncItem
  ): ChecklistItem | null {
    const identity = item.sourceIdentity
    if (identity) {
      const bound = this.database.prepare(`
        SELECT checklist.id
        FROM source_bindings binding
        JOIN checklist_items checklist ON checklist.id = binding.item_id
        WHERE binding.game_id = ? AND binding.provider = ? AND binding.endpoint = ?
          AND binding.external_id = ? AND checklist.archived = 0
          AND checklist.source = 'public_schedule'
        LIMIT 1
      `).get(
        gameId,
        identity.provider,
        identity.endpoint,
        identity.externalId
      ) as { id: string } | undefined
      if (bound) return this.getChecklistItem(bound.id)
    }

    const candidates = this.listChecklistItems(gameId).filter((candidate) =>
      candidate.source === 'public_schedule' && candidate.category === item.category
    )
    const remoteMatch = candidates.find((candidate) => candidate.remoteKey === item.remoteKey)
    if (remoteMatch) return remoteMatch

    if (item.category === 'endgame') {
      const modeMatch = candidates.find((candidate) =>
        Boolean(item.modeKey) && candidate.modeKey === item.modeKey
      )
      if (modeMatch) return modeMatch
      const definition = findCycleMode(gameId, item)
      if (definition) {
        return candidates.find((candidate) => candidate.modeKey === definition.modeKey) ?? null
      }
    }

    const title = normalizeSourceTitle(item.title)
    if (item.category === 'exploration') {
      const titleMatches = candidates.filter((candidate) =>
        normalizeSourceTitle(candidate.title) === title
      )
      // Official account APIs sometimes expose a standalone region where the
      // canonical two-level catalog deliberately keeps the same unique title
      // under its main region. Progress identity may follow the unique title;
      // the baseline continues to own the rendered hierarchy below.
      if (titleMatches.length === 1) return titleMatches[0]
      const nodeKind = item.mapNodeKind ?? null
      const parent = item.parentTitle ? normalizeSourceTitle(item.parentTitle) : null
      const matches = titleMatches.filter((candidate) =>
        (!nodeKind || candidate.mapNodeKind === nodeKind) &&
        (!parent || normalizeSourceTitle(candidate.parentTitle ?? '') === parent)
      )
      return matches.length === 1 ? matches[0] : null
    }

    if (item.category === 'limited_event') {
      const matches = candidates.filter((candidate) =>
        eventTitlesEquivalent(candidate.title, item.title) &&
        (
          !item.startsAt || !item.endsAt || !candidate.startsAt || !candidate.endsAt ||
          itemTimeWindowOverlapsPayload(candidate, {
            observedStartsAt: item.startsAt,
            observedEndsAt: item.endsAt
          })
        )
      )
      return matches.length === 1 ? matches[0] : null
    }

    return candidates.find((candidate) => normalizeSourceTitle(candidate.title) === title) ?? null
  }

  /**
   * Applies an authenticated progress snapshot to the persistent baseline.
   * The adapter may prove completion and progress, but it never owns titles,
   * time windows, tags or hierarchy and therefore cannot replace the catalog.
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
    const preparedItems = items.flatMap((item) => {
      const baseline = this.findBaselineItemForPersonalProgress(gameId, item)
      if (!baseline?.remoteKey) return []
      return [{
        item: {
          ...item,
          remoteKey: baseline.remoteKey,
          title: baseline.title,
          activityTags: baseline.activityTags,
          parentTitle: baseline.parentTitle,
          mapNodeKind: baseline.mapNodeKind,
          parentRemoteKey: baseline.parentRemoteKey,
          startsAt: baseline.startsAt,
          endsAt: baseline.endsAt,
          resetRule: baseline.resetRule,
          periodKey: baseline.periodKey,
          scheduleKind: baseline.scheduleKind,
          resetWeekday: baseline.resetWeekday,
          timeZone: baseline.timeZone,
          modeKey: baseline.modeKey,
          sourceUrl: baseline.sourceUrl
        } satisfies NormalizedSyncItem,
        observedStartsAt: item.startsAt,
        observedEndsAt: item.endsAt
      }]
    })
    const activeItems: NormalizedSyncItem[] = []
    const expiredItems: NormalizedSyncItem[] = []
    const suppressedItems: NormalizedSyncItem[] = []
    const correctedIdentities: NormalizedSyncItem['sourceIdentity'][] = []
    for (const prepared of preparedItems) {
      const item = prepared.item
      // The persistent baseline owns the rendered period window, but the
      // provider's observed window still owns the lifecycle of its personal
      // identity.  Classify recurring observations before projecting them
      // onto the current baseline period; otherwise an expired observation
      // and the new-period placeholder become two active rows with the same
      // stable remote key.
      const lifecycleStartsAt = item.category === 'endgame'
        ? prepared.observedStartsAt
        : item.startsAt
      const lifecycleEndsAt = item.category === 'endgame'
        ? prepared.observedEndsAt
        : item.endsAt
      this.assertTimeWindow(item.startsAt ?? null, item.endsAt ?? null)
      if (item.category === 'endgame') {
        this.assertTimeWindow(lifecycleStartsAt ?? null, lifecycleEndsAt ?? null)
      }
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
      const endsAtMs = lifecycleEndsAt ? Date.parse(lifecycleEndsAt) : Number.NaN
      if (Number.isFinite(endsAtMs) && endsAtMs <= reference.getTime()) {
        expiredItems.push({
          ...item,
          startsAt: lifecycleStartsAt,
          endsAt: lifecycleEndsAt
        })
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

      const merge = this.mergeSyncedItems(
        gameId,
        'personal_sync',
        activeItems,
        now,
        false,
        { codexReviewed: true, identityPolicy: 'remote-key-only' }
      )
      merge.preserved += items.length - preparedItems.length + suppressedItems.length
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
        WHERE game_id = ? AND source IN ('public_schedule', 'personal_sync') AND remote_key = ?
        ORDER BY archived ASC, CASE WHEN source = 'public_schedule' THEN 0 ELSE 1 END, updated_at DESC
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
      }

      this.database.prepare(`
        INSERT INTO sync_target_states(
          game_id, target, last_success_at, last_attempt_at, status,
          catalog_coverage, catalog_source, active_account_scope, active_snapshot_id
        ) VALUES (?, ?, ?, ?, 'success', 'complete', 'public_schedule', ?, ?)
        ON CONFLICT(game_id, target) DO UPDATE SET
          last_success_at = excluded.last_success_at,
          last_attempt_at = excluded.last_attempt_at,
          status = 'success',
          catalog_coverage = 'complete',
          catalog_source = 'public_schedule',
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
    options: PublicCatalogReplacementOptions = {}
  ): SyncMergeResult {
    return this.runTransaction(() => {
      const targets: PersonalSyncTarget[] = target === 'all'
        ? ['events', 'cycles', 'exploration']
        : target === 'events' || target === 'cycles' || target === 'exploration'
          ? [target]
          : []
      for (const selected of targets) {
        if (options.preserveActiveSourceState) {
          const current = this.database.prepare(`
            SELECT catalog_source AS catalogSource
            FROM sync_target_states
            WHERE game_id = ? AND target = ?
          `).get(gameId, selected) as { catalogSource: string | null } | undefined
          if (current?.catalogSource !== 'public_schedule') {
            throw new Error('只能在公开资料已激活时保留目录同步状态')
          }
          continue
        }
        this.activateChecklistSourceInTransaction(gameId, selected, 'public_schedule')
      }
      const merge = this.mergeSyncedItems(
        gameId,
        'public_schedule',
        items,
        syncedAt,
        false,
        options
      )
      this.pruneExpiredSystemItemsInTransaction(new Date(syncedAt))
      return merge
    })
  }

  applyRemoteCatalogFeed(
    feed: RemoteCatalogFeed,
    reference = new Date()
  ): RemoteCatalogApplyResult {
    const syncedAt = new Date(feed.publishedAt).toISOString()
    return this.runTransaction(() => {
      const result: RemoteCatalogApplyResult = {
        added: 0,
        updated: 0,
        preserved: 0,
        archived: 0,
        expiredRemoved: 0
      }
      const removePublicItem = this.database.prepare(`
        DELETE FROM checklist_items
        WHERE game_id = ? AND source = 'public_schedule' AND remote_key = ?
      `)

      for (const game of feed.games) {
        if (game.versionWindow) {
          this.validateVersionWindow(game.versionWindow, reference)
          this.upsertVersionWindow(game.gameId, game.versionWindow, syncedAt)
        }
        if (game.upserts.length > 0) {
          const merged = this.mergeSyncedItems(
            game.gameId,
            'public_schedule',
            game.upserts,
            syncedAt,
            false,
            {
              codexReviewed: true,
              identityPolicy: 'remote-key-only',
              outputLocale: 'zh-CN'
            }
          )
          result.added += merged.added
          result.updated += merged.updated
          result.preserved += merged.preserved
        }
        for (const remoteKey of game.archives) {
          result.archived += Number(removePublicItem.run(game.gameId, remoteKey).changes)
        }
        this.recalculatePublicMapRegionProgress(game.gameId, reference)
        this.assertActiveMapReferences(game.gameId)
      }
      result.expiredRemoved = this.pruneExpiredSystemItemsInTransaction(reference)
      return result
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
    if (source === 'public_schedule') {
      this.assertPublicCycleStableIdentities(gameId, items)
    }
    const seenRemoteKeys = new Set<string>()
    this.assertMapStructure(gameId, items)

    if (manageTransaction) this.database.exec('BEGIN IMMEDIATE')
    try {
      if (source === 'public_schedule') {
        this.restorePublicCycleCompletionFromHistory(gameId, items, syncedAt)
      }
      for (const item of items) {
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
          const id = randomUUID()
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
        const parentTitle = item.parentTitle === undefined ? current.parentTitle : item.parentTitle
        const mapNodeKind = item.mapNodeKind === undefined ? current.mapNodeKind : item.mapNodeKind
        const parentRemoteKey = item.parentRemoteKey === undefined
          ? current.parentRemoteKey
          : item.parentRemoteKey
        const resetRule = item.resetRule === undefined ? current.resetRule : item.resetRule
        const periodKey = item.periodKey === undefined ? current.periodKey : item.periodKey
        const scheduleKind = item.scheduleKind === undefined
          ? current.scheduleKind
          : item.scheduleKind
        const resetWeekday = item.resetWeekday === undefined
          ? current.resetWeekday
          : item.resetWeekday
        const timeZone = item.timeZone === undefined ? current.timeZone : item.timeZone
        const modeKey = item.modeKey === undefined ? current.modeKey : item.modeKey
        const sourceUrl = item.sourceUrl === undefined ? current.sourceUrl : item.sourceUrl
        const publicStructureUnchanged = source === 'public_schedule' &&
          current.category === item.category &&
          current.title === item.title &&
          JSON.stringify(normalizeActivityTags(current.activityTags)) ===
            JSON.stringify(resolvedActivityTags) &&
          current.parentTitle === parentTitle &&
          current.mapNodeKind === mapNodeKind &&
          current.parentRemoteKey === parentRemoteKey &&
          current.startsAt === startsAt &&
          current.endsAt === endsAt &&
          current.resetRule === resetRule &&
          current.periodKey === periodKey &&
          current.scheduleKind === scheduleKind &&
          current.resetWeekday === resetWeekday &&
          current.timeZone === timeZone &&
          current.modeKey === modeKey &&
          current.sourceUrl === sourceUrl
        if (publicStructureUnchanged) {
          result.preserved += 1
          continue
        }

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
            parentTitle,
            mapNodeKind,
            parentRemoteKey,
            startsAt,
            endsAt,
            resetRule,
            periodKey,
            scheduleKind,
            resetWeekday,
            timeZone,
            modeKey,
            null,
            identity.source === 'public_schedule' && source === 'personal_sync'
              ? 'public_schedule'
              : source,
            sourceUrl,
            manualCompletionLocked ? 1 : 0,
            completedAt,
            syncedAt,
            syncedAt,
            current.id
          )
        result.updated += 1
        if (completionProtected) result.preserved += 1
      }
      if (source === 'public_schedule' && items.some((item) => item.category === 'exploration')) {
        this.recalculatePublicMapRegionProgress(gameId, new Date(syncedAt))
      }
      if (manageTransaction) this.database.exec('COMMIT')
      return result
    } catch (error) {
      if (manageTransaction) this.database.exec('ROLLBACK')
      throw error
    }
  }

  private assertPublicCycleStableIdentities(
    gameId: GameId,
    items: NormalizedSyncItem[]
  ): void {
    const seenModes = new Set<string>()
    for (const item of items) {
      if (item.category !== 'endgame') continue
      if (!item.modeKey) throw new Error(`周期挑战“${item.title}”缺少稳定模式标识`)
      if (seenModes.has(item.modeKey)) {
        throw new Error(`公开周期清单包含重复模式：${item.modeKey}`)
      }
      seenModes.add(item.modeKey)
      const definition = findCycleMode(gameId, item)
      if (definition && item.remoteKey !== definition.remoteKey) {
        throw new Error(
          `周期挑战“${definition.title}”必须使用稳定标识 ${definition.remoteKey}，不能按期次新建卡片`
        )
      }
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
          AND (source = ? OR (? = 'personal_sync' AND source = 'public_schedule'))
        ORDER BY CASE WHEN source = 'public_schedule' THEN 0 ELSE 1 END, updated_at DESC
        LIMIT 1
      `).get(gameId, remoteKey, source, source) as {
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
            remote_key = ?
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

  /**
   * Permanently removes expired, system-owned time-limited entries.
   *
   * Known recurring challenges must be rolled forward before this method is
   * called. Manual entries are deliberately outside this query: only public
   * and authenticated snapshots are lifecycle-managed by the application.
   * Personal provider identities receive an expiry tombstone before the row
   * is deleted so a stale official snapshot cannot recreate the old period.
   */
  pruneExpiredSystemItems(reference = new Date()): number {
    return this.runTransaction(() => this.pruneExpiredSystemItemsInTransaction(reference))
  }

  private pruneExpiredSystemItemsInTransaction(reference: Date): number {
    const now = reference.toISOString()
    const rows = this.database.prepare(`
      SELECT i.id, i.game_id AS gameId, i.category, i.source,
        i.ends_at AS endsAt,
        b.provider, b.endpoint, b.external_id AS externalId
      FROM checklist_items i
      LEFT JOIN source_bindings b
        ON b.game_id = i.game_id AND b.item_id = i.id
      WHERE i.source IN ('public_schedule', 'personal_sync')
        AND i.category IN ('limited_event', 'endgame')
        AND i.ends_at IS NOT NULL
        AND julianday(i.ends_at) <= julianday(?)
      ORDER BY i.id
    `).all(now) as Array<{
      id: string
      gameId: GameId
      category: Extract<ChecklistCategory, 'limited_event' | 'endgame'>
      source: Extract<ChecklistSource, 'public_schedule' | 'personal_sync'>
      endsAt: string
      provider: string | null
      endpoint: string | null
      externalId: string | null
    }>
    if (rows.length === 0) return 0

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
    const deleteItem = this.database.prepare(`
      DELETE FROM checklist_items
      WHERE id = ? AND source IN ('public_schedule', 'personal_sync')
    `)
    const deleted = new Set<string>()
    let removed = 0
    for (const row of rows) {
      if (
        row.source === 'personal_sync' &&
        row.provider && row.endpoint && row.externalId &&
        row.provider !== 'gtask-cycle-catalog'
      ) {
        upsertExpiry.run(
          row.gameId,
          row.provider,
          row.endpoint,
          row.externalId,
          row.category,
          row.endsAt,
          now
        )
      }
      if (deleted.has(row.id)) continue
      deleted.add(row.id)
      removed += Number(deleteItem.run(row.id).changes)
    }
    return removed
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

  private validateVersionWindow(window: CodexVersionWindow, reference: Date): void {
    if (!window.periodKey.trim()) throw new Error('版更校时缺少当前版本标识')
    if (!window.timeZone.trim()) throw new Error('版更校时缺少官方服务器时区')
    const startsAt = Date.parse(window.startsAt)
    const endsAt = Date.parse(window.endsAt)
    if (!Number.isFinite(startsAt) || !Number.isFinite(endsAt) || startsAt >= endsAt) {
      throw new Error('版更校时缺少有效的版本起止时间')
    }
    if (startsAt > reference.getTime()) throw new Error('版更校时只能提交当前已经开始的游戏版本')
    if (endsAt <= reference.getTime()) throw new Error('版更校时不能提交已经结束的游戏版本')
    if (!Number.isFinite(window.confidence) || window.confidence < 0 || window.confidence > 1) {
      throw new Error('版更校时置信度格式不正确')
    }
    try {
      const url = new URL(window.sourceUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error()
    } catch {
      throw new Error('版更校时缺少有效的核验来源')
    }
  }

  private upsertVersionWindow(
    gameId: GameId,
    window: CodexVersionWindow,
    syncedAt: string
  ): void {
    const current = this.database.prepare(`
      SELECT period_key AS periodKey, starts_at AS startsAt, ends_at AS endsAt,
        timezone AS timeZone, source_url AS sourceUrl, confidence
      FROM game_version_windows
      WHERE game_id = ?
    `).get(gameId) as {
      periodKey: string
      startsAt: string
      endsAt: string
      timeZone: string
      sourceUrl: string | null
      confidence: number
    } | undefined
    if (
      current?.periodKey === window.periodKey &&
      current.startsAt === window.startsAt &&
      current.endsAt === window.endsAt &&
      current.timeZone === window.timeZone &&
      current.sourceUrl === window.sourceUrl &&
      current.confidence === window.confidence
    ) return
    this.database.prepare(`
      INSERT INTO game_version_windows(
        game_id, period_key, starts_at, ends_at, timezone,
        source_url, confidence, last_synced_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(game_id) DO UPDATE SET
        period_key = excluded.period_key,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        timezone = excluded.timezone,
        source_url = excluded.source_url,
        confidence = excluded.confidence,
        last_synced_at = excluded.last_synced_at,
        updated_at = excluded.updated_at
    `).run(
      gameId,
      window.periodKey,
      window.startsAt,
      window.endsAt,
      window.timeZone,
      window.sourceUrl,
      window.confidence,
      syncedAt,
      syncedAt
    )
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
      if (version.version === 1) this.migrateVersion1To2()
      const migrated = this.database.prepare(
        'SELECT MAX(version) AS version FROM schema_migrations'
      ).get() as { version: number | null }
      if (migrated.version === 2) this.migrateVersion2To3()
      const current = this.database.prepare(
        'SELECT MAX(version) AS version FROM schema_migrations'
      ).get() as { version: number | null }
      if (current.version !== CURRENT_SCHEMA_VERSION) {
        throw new Error(
          `数据库版本不兼容：期望 ${CURRENT_SCHEMA_VERSION}，实际 ${current.version ?? '未知'}`
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

      CREATE TABLE game_version_windows (
        game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        period_key TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        timezone TEXT NOT NULL,
        source_url TEXT,
        confidence REAL NOT NULL DEFAULT 0.5
          CHECK (confidence >= 0 AND confidence <= 1),
        last_synced_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE checklist_items (
        id TEXT PRIMARY KEY,
        game_id TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
        category TEXT NOT NULL CHECK (category IN (
          'limited_event', 'endgame', 'exploration', 'custom'
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
          schedule_kind IS NULL OR schedule_kind IN ('fixed_window', 'remote_schedule')
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
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'success', 'error', 'stale', 'verification_required')),
        last_attempt_at TEXT,
        last_success_at TEXT,
        message TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        auto_sync_enabled INTEGER NOT NULL DEFAULT 1
          CHECK (auto_sync_enabled IN (0, 1))
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
        scope TEXT NOT NULL CHECK (scope = 'public_schedule'),
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
          CHECK (job_kind = 'public_catalog'),
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

      INSERT INTO schema_migrations(version) VALUES (${CURRENT_SCHEMA_VERSION});
      COMMIT;
    `)
  }

  private migrateVersion1To2(): void {
    const now = new Date().toISOString()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      // Preserve user-authored legacy weekly rows as ordinary custom items.
      // Canonical fixed rows use the stable `${gameId}:weekly` identity, while
      // synchronized weekly rows are system-owned and may be removed outright.
      this.database.prepare(`
        UPDATE checklist_items
        SET category = 'custom',
            schedule_kind = NULL,
            reset_weekday = NULL,
            timezone = NULL,
            period_key = NULL,
            reset_rule = NULL,
            remote_key = NULL,
            source = 'manual',
            last_synced_at = NULL,
            updated_at = ?
        WHERE category = 'weekly'
          AND source = 'manual'
          AND id <> (game_id || ':weekly')
      `).run(now)
      this.database.prepare(`
        DELETE FROM checklist_items
        WHERE category = 'weekly'
      `).run()
      this.database.prepare(`
        INSERT INTO schema_migrations(version, applied_at) VALUES (2, ?)
      `).run(now)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private migrateVersion2To3(): void {
    const now = new Date().toISOString()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const syncStateColumns = this.database.prepare(`PRAGMA table_info(sync_states)`).all() as Array<{
        name: string
      }>
      if (!syncStateColumns.some((column) => column.name === 'auto_sync_enabled')) {
        this.database.exec(`
          ALTER TABLE sync_states ADD COLUMN auto_sync_enabled INTEGER NOT NULL DEFAULT 1
            CHECK (auto_sync_enabled IN (0, 1));
        `)
      }
      // Existing personal rows remain in place until startup has seeded the
      // complete baseline. Their progress is then absorbed deterministically
      // into matching baseline rows and the obsolete personal structure is
      // removed without ever becoming the catalog itself.
      // User-authored rows from the formerly editable built-in sections stay
      // fully editable by moving into the one section that remains local.
      this.database.prepare(`
        UPDATE checklist_items
        SET category = 'custom', activity_tags_json = '[]', progress_percent = NULL,
            parent_title = NULL, map_node_kind = NULL, parent_remote_key = NULL,
            starts_at = NULL, ends_at = NULL, reset_rule = NULL, period_key = NULL,
            schedule_kind = NULL, reset_weekday = NULL, timezone = NULL,
            mode_key = NULL, recurrence_rule = NULL, remote_key = NULL,
            source_url = NULL, last_synced_at = NULL, updated_at = ?
        WHERE source = 'manual' AND category <> 'custom'
      `).run(now)
      for (const column of [
        'mode',
        'run_mode',
        'auto_scope',
        'last_scope',
        'initial_guide_dismissed'
      ]) {
        if (syncStateColumns.some((candidate) => candidate.name === column)) {
          this.database.exec(`ALTER TABLE sync_states DROP COLUMN ${column}`)
        }
      }
      this.database.exec(`
        DROP TABLE IF EXISTS personal_review_batches;
        DROP TABLE IF EXISTS personal_review_rules;
        DROP TABLE IF EXISTS personal_metadata_cache;
        DROP TABLE IF EXISTS codex_worker_settings;
      `)
      this.database.prepare(`
        DELETE FROM ai_schedule_jobs
        WHERE job_kind IN ('personal_metadata', 'personal_review')
      `).run()
      this.database.prepare(`
        INSERT INTO schema_migrations(version, applied_at) VALUES (3, ?)
      `).run(now)
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
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
      INSERT OR IGNORE INTO sync_states(game_id, status)
      VALUES (?, 'idle')
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

  private ensureVersionWindowStorage(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS game_version_windows (
        game_id TEXT PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
        period_key TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        timezone TEXT NOT NULL,
        source_url TEXT,
        confidence REAL NOT NULL DEFAULT 0.5
          CHECK (confidence >= 0 AND confidence <= 1),
        last_synced_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    const legacyRows = this.database.prepare(`
      SELECT game_id AS gameId, period_key AS periodKey,
        starts_at AS startsAt, ends_at AS endsAt,
        timezone AS timeZone, source_url AS sourceUrl,
        COALESCE(last_synced_at, updated_at) AS syncedAt
      FROM checklist_items
      WHERE category IN ('main_quest', 'side_quest')
        AND starts_at IS NOT NULL AND ends_at IS NOT NULL
      ORDER BY game_id, julianday(starts_at) DESC
    `).all() as Array<{
      gameId: GameId
      periodKey: string | null
      startsAt: string
      endsAt: string
      timeZone: string | null
      sourceUrl: string | null
      syncedAt: string
    }>
    const migratedGames = new Set<GameId>()
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO game_version_windows(
        game_id, period_key, starts_at, ends_at, timezone,
        source_url, confidence, last_synced_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 0.5, ?, ?)
    `)
    for (const row of legacyRows) {
      if (migratedGames.has(row.gameId)) continue
      migratedGames.add(row.gameId)
      insert.run(
        row.gameId,
        row.periodKey ?? `legacy:${row.startsAt}`,
        row.startsAt,
        row.endsAt,
        row.timeZone ?? 'Asia/Shanghai',
        row.sourceUrl,
        row.syncedAt,
        row.syncedAt
      )
    }
    this.database.prepare(`
      DELETE FROM checklist_items WHERE category IN ('main_quest', 'side_quest')
    `).run()
  }

  private seedBundledBaselines(reference = new Date()): void {
    const bundledVerifiedAt = new Date(BUNDLED_BASELINE_VERIFIED_AT).toISOString()
    for (const game of DEFAULT_GAMES) {
      const gameId = game.id
      const storedVersion = this.database.prepare(`
        SELECT last_synced_at AS lastSyncedAt
        FROM game_version_windows
        WHERE game_id = ?
      `).get(gameId) as { lastSyncedAt: string | null } | undefined
      if (!storedVersion?.lastSyncedAt || storedVersion.lastSyncedAt < bundledVerifiedAt) {
        this.upsertVersionWindow(
          gameId,
          getBundledVersionWindow(gameId),
          bundledVerifiedAt
        )
      }

      this.mergeSyncedItems(
        gameId,
        'public_schedule',
        getBundledActivityCatalog(gameId),
        bundledVerifiedAt
      )
      this.recordCatalogCoverage(gameId, 'events', 'public_schedule', 'complete')
      this.mergeSyncedItems(
        gameId,
        'public_schedule',
        completeCycleCatalog(gameId, [], [], 'public_schedule', reference),
        reference.toISOString()
      )
      this.recordCatalogCoverage(gameId, 'cycles', 'public_schedule', 'complete')
      this.mergeSyncedItems(
        gameId,
        'public_schedule',
        getBundledMapCatalog(gameId),
        getBundledMapCatalogVerifiedAt(gameId),
        true,
        { identityPolicy: 'remote-key-only' }
      )
      this.recordCatalogCoverage(gameId, 'exploration', 'public_schedule', 'complete')
    }
  }

  private absorbLegacyPersonalProgressIntoBaselines(): void {
    const legacyRows = this.database.prepare(`
      SELECT id FROM checklist_items
      WHERE source = 'personal_sync' AND archived = 0
      ORDER BY created_at ASC, id ASC
    `).all() as Array<{ id: string }>
    if (legacyRows.length === 0) return

    this.runTransaction(() => {
      const applyProgress = this.database.prepare(`
        UPDATE checklist_items
        SET completed = ?, progress_percent = ?, manual_completion_locked = ?,
            completed_at = ?, last_synced_at = COALESCE(?, last_synced_at), updated_at = ?
        WHERE id = ? AND source = 'public_schedule' AND archived = 0
      `)
      const moveBindings = this.database.prepare(`
        UPDATE source_bindings SET item_id = ?, updated_at = ?
        WHERE item_id = ?
      `)
      const now = new Date().toISOString()
      for (const row of legacyRows) {
        const legacy = this.getChecklistItem(row.id)
        const baseline = this.findBaselineItemForPersonalProgress(legacy.gameId, {
          remoteKey: legacy.remoteKey ?? `legacy-personal:${legacy.id}`,
          category: legacy.category,
          title: legacy.title,
          completed: legacy.completed,
          progressPercent: legacy.progressPercent,
          parentTitle: legacy.parentTitle,
          mapNodeKind: legacy.mapNodeKind,
          parentRemoteKey: legacy.parentRemoteKey,
          startsAt: legacy.startsAt,
          endsAt: legacy.endsAt,
          modeKey: legacy.modeKey
        })
        if (!baseline) continue
        applyProgress.run(
          legacy.completed ? 1 : 0,
          legacy.category === 'exploration' ? legacy.progressPercent : null,
          legacy.manualCompletionLocked ? 1 : 0,
          legacy.completedAt,
          legacy.lastSyncedAt,
          now,
          baseline.id
        )
        moveBindings.run(baseline.id, now, legacy.id)
      }
      this.database.prepare(`DELETE FROM checklist_items WHERE source = 'personal_sync'`).run()
      this.database.prepare(`
        UPDATE sync_target_states
        SET catalog_source = 'public_schedule'
        WHERE target IN ('events', 'cycles', 'exploration')
      `).run()
    })
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

  private normalizePublicMapProgressConsistency(reference = new Date()): void {
    const now = reference.toISOString()
    this.database.prepare(`
      UPDATE checklist_items
      SET progress_percent = 100, updated_at = ?
      WHERE category = 'exploration'
        AND source = 'public_schedule'
        AND map_node_kind = 'subregion'
        AND archived = 0
        AND completed = 1
        AND (progress_percent IS NULL OR progress_percent <> 100)
    `).run(now)
    for (const game of DEFAULT_GAMES) {
      this.recalculatePublicMapRegionProgress(game.id, reference)
    }
  }

  getChecklistItem(id: string): ChecklistItem {
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
    if (category === 'limited_event') return 'fixed_window'
    if (category === 'endgame') return 'remote_schedule'
    return null
  }

  private recalculatePublicMapRegionProgress(
    gameId: GameId,
    reference = new Date()
  ): string[] {
    const regions = this.database.prepare(`
      SELECT id, remote_key AS remoteKey, title
      FROM checklist_items
      WHERE game_id = ? AND category = 'exploration' AND source = 'public_schedule'
        AND map_node_kind = 'region' AND archived = 0
    `).all(gameId) as Array<{ id: string; remoteKey: string | null; title: string }>
    const readChildren = this.database.prepare(`
      SELECT progress_percent AS progressPercent, completed
      FROM checklist_items
      WHERE game_id = ? AND category = 'exploration' AND source = 'public_schedule'
        AND map_node_kind = 'subregion' AND archived = 0
        AND (
          (? IS NOT NULL AND parent_remote_key = ?)
          OR (parent_remote_key IS NULL AND parent_title = ?)
        )
    `)
    const update = this.database.prepare(`
      UPDATE checklist_items
      SET progress_percent = ?,
          completed = ?,
          completed_at = CASE
            WHEN ? = 1 THEN COALESCE(completed_at, ?)
            ELSE NULL
          END,
          manual_completion_locked = 0,
          updated_at = ?
      WHERE id = ?
        AND (
          progress_percent IS NOT ?
          OR completed <> ?
          OR manual_completion_locked <> 0
        )
    `)
    const now = reference.toISOString()
    const updatedIds: string[] = []
    for (const region of regions) {
      const children = readChildren.all(
        gameId,
        region.remoteKey,
        region.remoteKey,
        region.title
      ) as Array<{ progressPercent: number | null; completed: number }>
      if (children.length === 0) continue
      const progress = Math.round(
        children.reduce(
          (sum, child) => sum + (child.completed ? 100 : (child.progressPercent ?? 0)),
          0
        ) / children.length * 100
      ) / 100
      const completed = progress === 100 ? 1 : 0
      const result = update.run(
        progress,
        completed,
        completed,
        now,
        now,
        region.id,
        progress,
        completed
      )
      if (result.changes > 0) updatedIds.push(region.id)
    }
    return updatedIds
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
