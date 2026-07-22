export interface PersonalRequestOutcome {
  succeeded: boolean
  error?: unknown
}

export async function capturePersonalRequest<T>(
  operation: () => Promise<T>,
  outcomes: PersonalRequestOutcome[]
): Promise<T | undefined> {
  try {
    const value = await operation()
    outcomes.push({ succeeded: true })
    return value
  } catch (error) {
    outcomes.push({ succeeded: false, error })
    return undefined
  }
}

export function assertAnyPersonalRequestSucceeded(outcomes: PersonalRequestOutcome[]): void {
  if (outcomes.length === 0 || outcomes.some((outcome) => outcome.succeeded)) return
  throw outcomes.find((outcome) => outcome.error)?.error ?? new Error('个人进度接口全部同步失败')
}

export function personalPartialSuffix(outcomes: PersonalRequestOutcome[]): string {
  const succeeded = outcomes.filter((outcome) => outcome.succeeded).length
  if (succeeded === outcomes.length) return ''
  return `（部分成功 ${succeeded}/${outcomes.length}，失败项已保留原数据）`
}
