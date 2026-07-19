import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type {
  ChecklistItem,
  CreateChecklistItemInput,
  GameSummary,
  UpdateChecklistItemInput
} from '../shared/contracts'

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

export class AppDatabase {
  private readonly database: DatabaseSync

  constructor(databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true })
    this.database = new DatabaseSync(databasePath)
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    this.migrate()
    this.seedGames()
    this.seedQuestChecklists()
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
          starts_at AS startsAt,
          ends_at AS endsAt,
          reset_rule AS resetRule,
          period_key AS periodKey,
          source,
          manual_completion_locked AS manualCompletionLocked,
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
          created_at ASC
      `)
      .all(gameId) as unknown[]

    return rows.map((row) => this.mapChecklistItem(row))
  }

  createChecklistItem(input: CreateChecklistItemInput): ChecklistItem {
    const id = randomUUID()
    const now = new Date().toISOString()

    this.database
      .prepare(`
        INSERT INTO checklist_items(
          id, game_id, category, title, progress_percent, starts_at, ends_at,
          reset_rule, source, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?)
      `)
      .run(
        id,
        input.gameId,
        input.category,
        input.title,
        input.progressPercent ?? null,
        input.startsAt ?? null,
        input.endsAt ?? null,
        input.resetRule ?? null,
        now,
        now
      )

    return this.getChecklistItem(id)
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

    this.database
      .prepare(`
        UPDATE checklist_items SET
          category = ?,
          title = ?,
          completed = ?,
          progress_percent = ?,
          starts_at = ?,
          ends_at = ?,
          reset_rule = ?,
          manual_completion_locked = ?,
          completed_at = ?,
          updated_at = ?
        WHERE id = ? AND archived = 0
      `)
      .run(
        input.category ?? current.category,
        input.title ?? current.title,
        completed ? 1 : 0,
        input.progressPercent === undefined ? current.progressPercent : input.progressPercent,
        input.startsAt === undefined ? current.startsAt : input.startsAt,
        input.endsAt === undefined ? current.endsAt : input.endsAt,
        input.resetRule === undefined ? current.resetRule : input.resetRule,
        manualCompletionLocked ? 1 : 0,
        completedAt,
        new Date().toISOString(),
        input.id
      )

    return this.getChecklistItem(input.id)
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

  close(): void {
    this.database.close()
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
          starts_at AS startsAt,
          ends_at AS endsAt,
          reset_rule AS resetRule,
          period_key AS periodKey,
          source,
          manual_completion_locked AS manualCompletionLocked,
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
}
