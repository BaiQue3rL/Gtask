import type {
  CredentialProvider,
  SyncProgressUpdate,
  SyncResult
} from '../../shared/contracts'

export interface UserFacingSyncNotice {
  status: SyncResult['status']
  message: string
  credentialProvider?: CredentialProvider | null
}

export interface UserFacingSyncNoticeInput {
  status: SyncResult['status']
  credentialProvider?: CredentialProvider | null
  needsRetry?: boolean
}

const TARGET_PROGRESS_LABELS = {
  all: '全部清单',
  tasks: '当前版本时间',
  events: '活动',
  cycles: '周期',
  exploration: '地图目录和进度'
} as const

function reviewingMessage(target: SyncProgressUpdate['target']): string {
  if (target === 'tasks') return '正在核对当前版本结束时间'
  if (target === 'events') return '正在核对活动名称、时间和玩法信息'
  if (target === 'cycles') return '正在核对周期名称、时间和完成状态'
  if (target === 'exploration') return '正在核对地图目录、归属和探索进度'
  return '正在核对清单信息'
}

/**
 * User copy is derived exclusively from structured source/target/phase/count
 * fields. progress.message is an internal diagnostic and is never rendered.
 */
export function userFacingProgressMessage(progress: SyncProgressUpdate): string {
  const target = TARGET_PROGRESS_LABELS[progress.target]
  switch (progress.phase) {
    case 'queued':
      return '同步任务正在排队'
    case 'fetching':
      return `正在读取${target}进度`
    case 'searching':
      return reviewingMessage(progress.target)
    case 'verifying':
      return reviewingMessage(progress.target)
    case 'structuring':
      return `正在整理${target}进度`
    case 'writing':
    case 'merging':
      return `正在更新${target}清单`
    case 'retrying':
      return progress.current !== null && progress.total !== null
        ? `连接不稳定，正在重试 ${progress.current}/${progress.total}`
        : '连接不稳定，正在重试'
    case 'verification':
      return '请完成平台验证后继续'
    case 'completed':
      return '同步完成'
    case 'failed':
      return '同步未完成，请稍后重试'
    case 'cancelled':
      return '同步已取消'
  }
}

export function userFacingSyncNotice(
  input: UserFacingSyncNoticeInput
): UserFacingSyncNotice | null {
  if (input.credentialProvider) {
    return {
      status: input.status,
      message: '登录状态需要更新，请重新登录后继续同步',
      credentialProvider: input.credentialProvider
    }
  }
  if (input.status === 'success') return null
  if (input.status === 'cancelled') {
    return { status: 'cancelled', message: '同步已取消' }
  }
  if (input.status === 'partial') {
    return input.needsRetry
      ? { status: 'partial', message: '部分数据暂未同步，可稍后重试' }
      : null
  }
  return { status: 'error', message: '同步未完成，请稍后重试' }
}
