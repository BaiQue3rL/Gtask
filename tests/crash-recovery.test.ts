import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database'

describe('abrupt process loss', () => {
  it('discards an interrupted transaction and retains a committed one across process termination', () => {
    const root = mkdtempSync(join(tmpdir(), 'gtask-crash-recovery-'))
    const path = join(root, 'gtask.sqlite')
    let db: AppDatabase | null = new AppDatabase(path)
    try {
      const item = db.createChecklistItem({ gameId: 'genshin', category: 'custom', title: '中断恢复样本' })
      db.close(); db = null
      for (const commit of [false, true]) {
        const result = spawnSync(process.execPath, ['-e', `
          const { DatabaseSync } = require('node:sqlite');
          const db = new DatabaseSync(process.argv[1]);
          db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
          db.prepare('UPDATE checklist_items SET completed=1, manual_completion_locked=1 WHERE id=?').run(process.argv[2]);
          if (process.argv[3] === 'true') db.exec('COMMIT');
          process.kill(process.pid, 'SIGKILL');
        `, path, item.id, String(commit)], { timeout: 10000, windowsHide: true })
        expect(result.error).toBeUndefined()
        expect(result.status === null || result.status !== 0).toBe(true)
        db = new AppDatabase(path)
        expect(db.listChecklistItems('genshin').find((row) => row.id === item.id)?.completed).toBe(commit)
        db.close(); db = null
        const inspection = new DatabaseSync(path)
        try { expect(inspection.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok') }
        finally { inspection.close() }
      }
    } finally { db?.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
