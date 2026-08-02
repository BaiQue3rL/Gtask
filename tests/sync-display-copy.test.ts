import { describe, expect, it } from 'vitest'
import {
  userFacingProgressMessage,
  userFacingSyncNotice
} from '../src/renderer/src/sync-display-copy'
import type { SyncProgressUpdate } from '../src/shared/contracts'

function progress(
  message: string,
  phase: SyncProgressUpdate['phase'] = 'verifying',
  overrides: Partial<SyncProgressUpdate> = {}
): SyncProgressUpdate {
  return {
    gameId: 'genshin',
    target: 'events',
    source: 'personal_data',
    phase,
    status: 'running',
    message,
    current: 2,
    total: 5,
    updatedAt: '2026-08-02T10:00:00.000Z',
    ...overrides
  }
}

describe('同步展示文案', () => {
  it('完全忽略 Agent 内部说明并仅按结构化阶段生成文案', () => {
    const message = userFacingProgressMessage(progress(
      '正在提交 completionRule.fieldPath，使用 observedStatus.allFinished'
    ))
    expect(message).toBe('正在核对活动名称、时间和玩法信息')
    expect(message).not.toContain('observedStatus')
    expect(message).not.toContain('completionRule')
    expect(userFacingProgressMessage(progress('正在解析个人 snapshot 的 externalId')))
      .toBe('正在核对活动名称、时间和玩法信息')
    expect(userFacingProgressMessage(progress(
      '已读取 personal_review 契约，正在检查 resolution 与 eventScope'
    ))).toBe('正在核对活动名称、时间和玩法信息')
    expect(userFacingProgressMessage(progress(
      '正在按 zh-CN / Asia/Shanghai 契约提交 contentLocale',
      'writing'
    ))).toBe('正在更新活动清单')
  })

  it('为各类结构化阶段提供固定的用户文案', () => {
    expect(userFacingProgressMessage(progress('任意内部说明', 'queued')))
      .toBe('同步任务正在排队')
    expect(userFacingProgressMessage(progress('任意内部说明', 'fetching')))
      .toBe('正在读取活动个人数据')
    expect(userFacingProgressMessage(progress('任意内部说明', 'searching', {
      source: 'public_schedule'
    }))).toBe('正在查找活动公开数据')
    expect(userFacingProgressMessage(progress('任意内部说明', 'structuring')))
      .toBe('正在整理活动个人清单')
    expect(userFacingProgressMessage(progress('任意内部说明', 'retrying')))
      .toBe('连接不稳定，正在重试 2/5')
    expect(userFacingProgressMessage(progress('任意内部说明', 'verification')))
      .toBe('请完成平台验证后继续')
  })

  it('不为正常完成和无需操作的后台结果额外显示通知', () => {
    expect(userFacingSyncNotice({
      status: 'success'
    })).toBeNull()
    expect(userFacingSyncNotice({
      status: 'partial'
    })).toBeNull()
  })

  it('只根据结构化状态展示登录、失败和取消等可操作通知', () => {
    expect(userFacingSyncNotice({
      status: 'error',
      credentialProvider: 'miyoushe'
    })).toMatchObject({
      message: '登录状态需要更新，请重新登录后继续同步',
      credentialProvider: 'miyoushe'
    })
    expect(userFacingSyncNotice({
      status: 'cancelled'
    })).toEqual({ status: 'cancelled', message: '同步已取消' })
    expect(userFacingSyncNotice({
      status: 'partial',
      needsRetry: true
    })).toEqual({ status: 'partial', message: '部分数据暂未同步，可稍后重试' })
    expect(userFacingSyncNotice({ status: 'error' }))
      .toEqual({ status: 'error', message: '同步未完成，请稍后重试' })
  })
})
