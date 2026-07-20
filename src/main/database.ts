import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { backup, DatabaseSync } from 'node:sqlite'
import { getWeeklyPeriod } from './periods'
import type {
  ChecklistCategory,
  ChecklistItem,
  ChecklistSource,
  CreateChecklistItemInput,
  GameId,
  GameSummary,
  SyncScope,
  SyncSettings,
  SyncStatus,
  UpdateSyncSettingsInput,
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

export const CURRENT_SCHEMA_VERSION = 6

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

  updateSyncSettings(input: UpdateSyncSettingsInput): SyncSettings {
    const result = this.database
      .prepare(`
        UPDATE sync_states
        SET run_mode = ?, auto_scope = ?, updated_at = ?
        WHERE game_id = ?
      `)
      .run(input.runMode, input.autoScope, new Date().toISOString(), input.gameId)

    if (result.changes === 0) throw new Error('游戏同步设置不存在')
    return this.getSyncSettings(input.gameId)
  }

  listAutomaticSyncSettings(): SyncSettings[] {
    const gameIds = this.database
      .prepare(`
        SELECT game_id AS gameId
        FROM sync_states
        WHERE run_mode = 'automatic'
        ORDER BY game_id
      `)
      .all() as Array<{ gameId: string }>

    return gameIds.map((row) => this.getSyncSettings(row.gameId))
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
          completed ASC,
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
    const resetWeekday = scheduleKind === 'weekly' ? input.resetWeekday ?? 1 : input.resetWeekday ?? null
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
          source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
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
        now,
        now
      )

    return this.getChecklistItem(id)
  }

  createChecklistItems(inputs: CreateChecklistItemInput[]): ChecklistItem[] {
    return this.runTransaction(() => inputs.map((input) => this.createChecklistItem(input)))
  }

  updateChecklistItem(input: UpdateChecklistItemInput): ChecklistItem {
    const current = this.getChecklistItem(input.id)
    const completed = input.completed ?? current.completed
    const manualCompletionLocked =
      input.completed === undefined ? current.manualCompletionLocked : input.completed
    const completedAt =
      input.completed === undefined
        ? current.completedAt
        : input.completed
          ? current.completedAt ?? new Date().toISOString()
          : null
    const category = input.category ?? current.category
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
      input.resetWeekday === undefined
        ? scheduleKind === 'weekly'
          ? current.resetWeekday ?? 1
          : categoryChanged
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
        const remoteKey = item.remoteKey.trim()
        if (!remoteKey || remoteKey.length > 200) throw new Error('远端事项标识格式不正确')
        this.assertTimeWindow(item.startsAt ?? null, item.endsAt ?? null)
        if (seenRemoteKeys.has(remoteKey)) throw new Error(`同步数据包含重复标识：${remoteKey}`)
        seenRemoteKeys.add(remoteKey)

        const identity = this.database
          .prepare(`
            SELECT id, archived, source
            FROM checklist_items
            WHERE game_id = ?
              AND remote_key = ?
              AND source <> 'manual'
            ORDER BY CASE WHEN source = ? THEN 0 ELSE 1 END
            LIMIT 1
          `)
          .get(gameId, remoteKey, source) as
          | { id: string; archived: number; source: ChecklistSource }
          | undefined

        if (identity?.archived) {
          result.preserved += 1
          continue
        }

        if (!identity) {
          const id = randomUUID()
          const remoteCompleted = source === 'personal_sync' && item.completed === true
          this.database
            .prepare(`
              INSERT INTO checklist_items(
                id, game_id, category, title, completed, progress_percent, parent_title,
                starts_at, ends_at, reset_rule, period_key, schedule_kind,
                reset_weekday, timezone, mode_key, source, remote_key,
                source_url, completed_at, last_synced_at, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              id,
              gameId,
              item.category,
              item.title,
              remoteCompleted ? 1 : 0,
              source === 'personal_sync' ? item.progressPercent ?? null : null,
              item.parentTitle ?? null,
              item.startsAt ?? null,
              item.endsAt ?? null,
              item.resetRule ?? null,
              item.periodKey ?? null,
              item.scheduleKind ?? this.defaultScheduleKind(item.category),
              item.resetWeekday ?? null,
              item.timeZone ?? null,
              item.modeKey ?? null,
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
        const periodChanged =
          item.periodKey !== undefined &&
          item.periodKey !== null &&
          current.periodKey !== null &&
          item.periodKey !== current.periodKey
        const currentCompleted = periodChanged ? false : current.completed
        const currentCompletedAt = periodChanged ? null : current.completedAt
        const manualCompletionLocked = periodChanged ? false : current.manualCompletionLocked
        const acceptsRemoteCompletion = source === 'personal_sync' && item.completed !== undefined
        const completionProtected =
          acceptsRemoteCompletion && item.completed === false && manualCompletionLocked
        const completed = completionProtected
          ? currentCompleted
          : acceptsRemoteCompletion
            ? item.completed!
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
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO checklist_items(
        id, game_id, category, title, source, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'manual', ?, ?)
    `)
    const now = new Date().toISOString()

    for (const game of DEFAULT_GAMES) {
      insert.run(`${game.id}:main_quest`, game.id, 'main_quest', '主线任务', now, now)
      insert.run(`${game.id}:side_quest`, game.id, 'side_quest', '支线任务', now, now)
    }
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
