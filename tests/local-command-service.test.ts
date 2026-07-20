import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { LocalCommandService } from '../src/main/local-command-service'

let database: AppDatabase | null = null

afterEach(() => {
  database?.close()
  database = null
})

describe('LocalCommandService', () => {
  it('提供适合本地 AI 调用的游戏快照和筛选', () => {
    database = new AppDatabase(':memory:')
    const service = new LocalCommandService(database)
    service.execute({
      command: 'create_item',
      item: { gameId: 'genshin', category: 'custom', title: '刷天赋素材' }
    })

    const result = service.execute({
      command: 'get_game_snapshot',
      gameId: 'genshin',
      category: 'custom',
      completed: false
    })

    expect(result).toMatchObject({
      command: 'get_game_snapshot',
      game: { id: 'genshin' },
      items: [{ title: '刷天赋素材' }],
      archivedItems: [],
      syncSettings: { runMode: 'manual' }
    })
  })

  it('允许更新和恢复，但删除必须显式确认', () => {
    database = new AppDatabase(':memory:')
    const service = new LocalCommandService(database)
    const created = service.execute({
      command: 'create_item',
      item: { gameId: 'star-rail', category: 'custom', title: '刷遗器' }
    })
    if (created.command !== 'create_item') throw new Error('测试初始化失败')

    const updated = service.execute({
      command: 'update_item',
      item: { id: created.item.id, completed: true }
    })
    expect(updated).toMatchObject({ command: 'update_item', item: { completed: true } })
    expect(() => service.execute({ command: 'archive_item', id: created.item.id })).toThrow(
      'confirm: true'
    )

    expect(
      service.execute({ command: 'archive_item', id: created.item.id, confirm: true })
    ).toEqual({ command: 'archive_item', archived: true })
    expect(service.execute({ command: 'restore_item', id: created.item.id })).toMatchObject({
      command: 'restore_item',
      item: { id: created.item.id }
    })
  })
})
