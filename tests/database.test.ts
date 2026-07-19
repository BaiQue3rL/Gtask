import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database'

let database: AppDatabase | null = null
let temporaryDirectory: string | null = null

afterEach(() => {
  database?.close()
  database = null
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = null
})

describe('AppDatabase', () => {
  it('只初始化四款支持的游戏和每款游戏的主支线状态', () => {
    database = new AppDatabase(':memory:')

    expect(database.listGames().map((game) => game.id)).toEqual([
      'genshin',
      'star-rail',
      'zenless',
      'wuthering-waves'
    ])

    for (const game of database.listGames()) {
      const items = database.listChecklistItems(game.id)
      expect(items.map((item) => item.category)).toEqual(['main_quest', 'side_quest'])
    }
  })

  it('新增、编辑、手动完成和软删除事项', () => {
    database = new AppDatabase(':memory:')
    const created = database.createChecklistItem({
      gameId: 'genshin',
      category: 'exploration',
      title: '枫丹探索',
      progressPercent: 42
    })

    expect(created.completed).toBe(false)
    expect(created.progressPercent).toBe(42)

    const completed = database.updateChecklistItem({
      id: created.id,
      title: '枫丹探索收尾',
      completed: true,
      progressPercent: 100
    })
    expect(completed.title).toBe('枫丹探索收尾')
    expect(completed.completed).toBe(true)
    expect(completed.manualCompletionLocked).toBe(true)
    expect(completed.completedAt).not.toBeNull()

    const reopened = database.updateChecklistItem({ id: created.id, completed: false })
    expect(reopened.completed).toBe(false)
    expect(reopened.manualCompletionLocked).toBe(false)
    expect(reopened.completedAt).toBeNull()

    database.archiveChecklistItem(created.id)
    expect(database.listChecklistItems('genshin').some((item) => item.id === created.id)).toBe(false)
  })

  it('关闭并重新打开数据库后保留数据且迁移可重复执行', () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'gacha-task-manager-test-'))
    const databasePath = join(temporaryDirectory, 'test.sqlite')
    database = new AppDatabase(databasePath)
    const created = database.createChecklistItem({
      gameId: 'star-rail',
      category: 'custom',
      title: '持久化测试'
    })
    database.close()

    database = new AppDatabase(databasePath)
    const items = database.listChecklistItems('star-rail')
    expect(items.find((item) => item.id === created.id)?.title).toBe('持久化测试')
    expect(items.filter((item) => item.category === 'main_quest')).toHaveLength(1)
    expect(items.filter((item) => item.category === 'side_quest')).toHaveLength(1)
  })
})
