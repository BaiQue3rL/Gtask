import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from '../src/main/database'
import { LocalCommandService } from '../src/main/local-command-service'

let database: AppDatabase | null = null

afterEach(() => {
  database?.close()
  database = null
})

describe('LocalCommandService', () => {
  it('可以自描述支持范围和破坏性命令', () => {
    database = new AppDatabase(':memory:')
    const result = new LocalCommandService(database).execute({ command: 'describe_commands' })
    expect(result).toMatchObject({
      schemaVersion: 1,
      supportedGameIds: ['genshin', 'star-rail', 'zenless', 'wuthering-waves'],
      destructiveCommands: ['archive_item', 'archive_items', 'archive_completed_section'],
      maximumBatchSize: 100
    })
  })

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

  it('一次读取四游戏快照并以事务执行批量写入', () => {
    database = new AppDatabase(':memory:')
    const service = new LocalCommandService(database)
    const created = service.execute({
      command: 'create_items',
      items: [
        { gameId: 'genshin', category: 'custom', title: '事项 A' },
        { gameId: 'zenless', category: 'weekly', title: '事项 B' }
      ]
    })
    expect(created.command).toBe('create_items')
    if (created.command !== 'create_items') throw new Error('批量创建失败')
    expect(created.items).toHaveLength(2)

    expect(
      service.execute({
        command: 'update_items',
        items: created.items.map((item) => ({ id: item.id, completed: true }))
      })
    ).toMatchObject({ command: 'update_items', items: [{ completed: true }, { completed: true }] })

    const snapshots = service.execute({ command: 'get_all_snapshots' })
    expect(snapshots.command).toBe('get_all_snapshots')
    if (snapshots.command !== 'get_all_snapshots') throw new Error('读取快照失败')
    expect(snapshots.snapshots.map((snapshot) => snapshot.game.id)).toEqual([
      'genshin',
      'star-rail',
      'zenless',
      'wuthering-waves'
    ])
  })

  it('批量命令先校验全部输入，非法项不会留下部分写入', () => {
    database = new AppDatabase(':memory:')
    const service = new LocalCommandService(database)
    expect(() =>
      service.execute({
        command: 'create_items',
        items: [
          { gameId: 'genshin', category: 'custom', title: '不应写入' },
          { gameId: 'genshin', category: 'custom', title: '' }
        ]
      })
    ).toThrow('不能为空')
    expect(database.listChecklistItems('genshin').some((item) => item.title === '不应写入')).toBe(false)
  })

  it('批量更新中途发生数据库错误时回滚前面的更新', () => {
    database = new AppDatabase(':memory:')
    const service = new LocalCommandService(database)
    const created = service.execute({
      command: 'create_item',
      item: { gameId: 'genshin', category: 'custom', title: '事务回滚事项' }
    })
    if (created.command !== 'create_item') throw new Error('创建测试事项失败')

    expect(() =>
      service.execute({
        command: 'update_items',
        items: [
          { id: created.item.id, completed: true },
          { id: 'missing-item', completed: true }
        ]
      })
    ).toThrow('不存在')
    expect(
      database.listChecklistItems('genshin').find((item) => item.id === created.item.id)?.completed
    ).toBe(false)
  })

  it('批量删除同样要求确认并在任一 ID 无效时回滚', () => {
    database = new AppDatabase(':memory:')
    const service = new LocalCommandService(database)
    const created = service.execute({
      command: 'create_item',
      item: { gameId: 'genshin', category: 'custom', title: '不能部分删除' }
    })
    if (created.command !== 'create_item') throw new Error('创建测试事项失败')

    expect(() =>
      service.execute({
        command: 'archive_items',
        ids: [created.item.id, 'missing-item'],
        confirm: true
      })
    ).toThrow('不存在')
    expect(database.listChecklistItems('genshin').some((item) => item.id === created.item.id)).toBe(true)
  })
})
