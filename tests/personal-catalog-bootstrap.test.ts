import { describe, expect, it, vi } from 'vitest'
import type { SyncResult, SyncSourceResult } from '../src/shared/contracts'
import { syncPersonalBeforeCatalogBootstrap } from '../src/main/sync/personal-catalog-bootstrap'

function personalResult(
  source: SyncSourceResult,
  status: SyncResult['status'] = source.status === 'success' ? 'success' : 'error'
): SyncResult {
  return {
    gameId: 'genshin',
    requestedScope: 'personal_data',
    requestedTarget: 'events',
    status,
    startedAt: '2026-07-30T00:00:00.000Z',
    finishedAt: '2026-07-30T00:00:01.000Z',
    sources: [source],
    message: source.message
  }
}

describe('syncPersonalBeforeCatalogBootstrap', () => {
  it('凭据失效时立即返回验证状态且不创建公开资料 Codex 任务', async () => {
    const queueCatalog = vi.fn()
    const result = await syncPersonalBeforeCatalogBootstrap({
      catalogComplete: false,
      syncPersonal: async () => personalResult({
        source: 'personal_data',
        status: 'verification_required',
        message: '米游社登录已失效，请重新登录',
        added: 0,
        updated: 0,
        preserved: 0
      }),
      queueCatalog
    })

    expect(queueCatalog).not.toHaveBeenCalled()
    expect(result.sources[0]).toMatchObject({
      source: 'personal_data',
      status: 'verification_required'
    })
  })

  it('个人接口读取成功后才为不完整清单创建公开资料任务', async () => {
    const order: string[] = []
    const result = await syncPersonalBeforeCatalogBootstrap({
      catalogComplete: false,
      syncPersonal: async () => {
        order.push('personal')
        return personalResult({
          source: 'personal_data',
          status: 'success',
          message: '个人数据读取完成',
          added: 0,
          updated: 0,
          preserved: 0,
          pendingReview: 2
        }, 'partial')
      },
      queueCatalog: async () => {
        order.push('catalog')
        return {
          gameId: 'genshin',
          requestedScope: 'public_schedule',
          requestedTarget: 'events',
          status: 'partial',
          startedAt: '2026-07-30T00:00:01.000Z',
          finishedAt: '2026-07-30T00:00:02.000Z',
          sources: [{
            source: 'public_schedule',
            status: 'skipped',
            message: '公开资料任务等待 Codex 处理',
            added: 0,
            updated: 0,
            preserved: 0
          }],
          message: '公开资料任务等待 Codex 处理'
        }
      }
    })

    expect(order).toEqual(['personal', 'catalog'])
    expect(result.status).toBe('partial')
    expect(result.sources.map((source) => source.source)).toEqual([
      'personal_data',
      'public_schedule'
    ])
  })

  it('目录已经完整时只同步个人数据', async () => {
    const queueCatalog = vi.fn()
    const expected = personalResult({
      source: 'personal_data',
      status: 'success',
      message: '同步完成',
      added: 0,
      updated: 1,
      preserved: 0
    })

    const result = await syncPersonalBeforeCatalogBootstrap({
      catalogComplete: true,
      syncPersonal: async () => expected,
      queueCatalog
    })

    expect(result).toBe(expected)
    expect(queueCatalog).not.toHaveBeenCalled()
  })
})
